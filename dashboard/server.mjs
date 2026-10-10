import http from "node:http";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import QRCode from "qrcode";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { isInitializeRequest } from "@modelcontextprotocol/sdk/types.js";
import { ProjectStore, writeJson, stateHome, publicState } from "./state.mjs";
import { createMcpServer } from "./mcp.mjs";
import { enableShare, inspectShare } from "./tailscale.mjs";
import { startHarness, proxyHarness, upgradeHarness } from "./harness.mjs";
import { EventsHub } from "./webhooks.mjs";
import { modernMcpHandler } from "./mcp2.mjs";
import { AnswerApplicationServer } from "./answer-application-server.mjs";
import { BudgetAdmissionServer } from "./budget-server.mjs";
import { createHistoryBackup, backupMaximum } from "./history-backup.mjs";
import { AcceptanceStore } from "./acceptance.mjs";
import {
  ConnectionObservations,
  connectionReport,
  inspectTunnel,
} from "./connection-diagnostics.mjs";
import { RunHistory } from "./run-history.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const equal = (a, b) =>
  typeof a === "string" &&
  typeof b === "string" &&
  Buffer.byteLength(a) === Buffer.byteLength(b) &&
  timingSafeEqual(Buffer.from(a), Buffer.from(b));
function json(res, status, value) {
  res.writeHead(status, { "content-type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(value));
}
async function readBody(req, maximum = 131072) {
  let size = 0,
    chunks = [];
  for await (const chunk of req) {
    size += chunk.length;
    if (size > maximum) throw new Error("Request body too large");
    chunks.push(chunk);
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
}
export async function startDashboard(options) {
  const { kind = "project", project, tailscale = true } = options;
  const port =
    options.port ||
    (kind === "harness"
      ? 38081
      : 38100 + (parseInt(project.id.slice(0, 4), 16) % 1000));
  const directory =
    kind === "project" ? project.directory : path.join(stateHome(), "harness");
  await fs.mkdir(directory, { recursive: true });
  // Exclusive live-instance lock: never launch two writers for the same project.
  const lockFile = path.join(directory, "server.lock");
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      await fs.writeFile(lockFile, String(process.pid), {
        flag: "wx",
        mode: 0o600,
      });
      break;
    } catch (e) {
      if (e.code !== "EEXIST") throw e;
      const pid = Number(await fs.readFile(lockFile, "utf8"));
      let alive = false;
      try {
        process.kill(pid, 0);
        alive = true;
      } catch (error) {
        if (error.code === "EPERM") alive = true;
      }
      if (alive)
        throw new Error(
          "This dashboard is already running; use rdsh-dashboard open with the same project",
        );
      await fs.unlink(lockFile);
      if (attempt === 1) throw new Error("Could not acquire dashboard lock");
    }
  }
  const token = randomBytes(32).toString("hex"); // local administrator
  const mcpToken = randomBytes(32).toString("hex");
  const browserToken = randomBytes(32).toString("hex");
  const instanceId = randomUUID();
  const startedAt = new Date().toISOString();
  const connections = new ConnectionObservations();
  const localUrl = `http://127.0.0.1:${port}/`;
  const cookieName = `rdsh_${kind === "project" ? project.id : "harness"}`;
  let store, eventsHub;
  try {
    store = kind === "project" ? await ProjectStore.open(project) : null;
    eventsHub = store
      ? await EventsHub.open(project, () => store.value, options.webhookPost)
      : null;
  } catch (error) {
    await fs.unlink(lockFile);
    throw error;
  }
  const live = new Set(),
    sessions = new Map();
  const sockets = new Set();
  const applications = store
    ? new AnswerApplicationServer(project, () => store.value, mutateReply)
    : null;
  const visibleState = async () =>
    publicState(
      store.value,
      await applications.observations(),
      eventsHub.deliveries(),
      budgets.observations(),
    );
  const budgets = store ? new BudgetAdmissionServer(mutateBudget) : null;
  const modern = store
    ? modernMcpHandler(
        { getState: visibleState, mutate },
        eventsHub,
        connections,
      )
    : null;
  const deliveryTimer = eventsHub
    ? setInterval(() => {
        void eventsHub.flush().catch(() => {});
      }, 2000)
    : null;
  deliveryTimer?.unref();
  let harness = null;
  let share = {
    state: "disabled",
    message: "ローカル接続のみ。Tailscale共有は起動時に有効にできます。",
    url: null,
  };
  let updateQueue = Promise.resolve();
  let refreshPromise = null;
  let closing = false;
  // Parsed once per share change; the old code rebuilt the Set and parsed
  // the share URL on every request (twice per request via trusted()).
  let originsCache = null;
  const allowedOrigins = () => {
    if (!originsCache) {
      originsCache = {
        origins: new Set([
          localUrl.slice(0, -1),
          `http://localhost:${port}`,
          ...(share.url ? [new URL(share.url).origin] : []),
        ]),
        hosts: new Set(
          [
            localUrl.slice(0, -1),
            `http://localhost:${port}`,
            ...(share.url ? [new URL(share.url).origin] : []),
          ].map((o) => new URL(o).host),
        ),
      };
    }
    return originsCache;
  };
  function browserAuthorized(req, url, route) {
    if (kind === "project")
      return (
        equal(req.headers["x-rdsh-browser-token"], browserToken) ||
        (route === "/api/live" &&
          equal(url.searchParams.get("key"), browserToken))
      );
    return (req.headers.cookie || "").split(";").some((item) => {
      const [name, value] = item.trim().split("=");
      return name === cookieName && equal(value, browserToken);
    });
  }
  function trusted(req) {
    const host = req.headers.host;
    const allowed = allowedOrigins();
    return (
      allowed.hosts.has(host) &&
      (!req.headers.origin || allowed.origins.has(req.headers.origin))
    );
  }
  function browserUrl(base, root = false) {
    const url = new URL(kind === "harness" && !root ? "_rdsh/" : "", base);
    if (kind === "project") url.hash = `key=${browserToken}`;
    else url.searchParams.set("rdsh_dashboard_key", browserToken);
    if (kind === "harness" && root && harness) {
      for (const [key, value] of harness.url.searchParams)
        url.searchParams.set(key, value);
      url.hash = harness.url.hash;
      url.searchParams.set("rdsh_dashboard_key", browserToken);
    }
    return url.href;
  }
  async function persistRuntime() {
    await writeJson(path.join(directory, "runtime.json"), {
      schema: 1,
      kind,
      project_id: project?.id || null,
      instance_id: instanceId,
      pid: process.pid,
      port,
      local_url: localUrl,
      browser_url: browserUrl(localUrl),
      token,
      mcp_token: mcpToken,
      share,
    });
    if (kind === "project") {
      await writeJson(path.join(directory, "mcp-config.json"), {
        mcpServers: {
          [`dashboard-${project.id}`]: {
            command: process.execPath,
            args: [
              path.join(here, "cli.mjs"),
              "mcp",
              "--project",
              project.root,
            ],
          },
        },
      });
      await writeJson(path.join(directory, "mcp-http-config.json"), {
        mcpServers: {
          [`dashboard-${project.id}`]: {
            type: "http",
            url: `${share.url || localUrl}mcp`,
            headers: { Authorization: `Bearer ${mcpToken}` },
          },
        },
      });
    }
  }
  async function refreshShare() {
    if (refreshPromise) return refreshPromise;
    refreshPromise = (async () => {
      share = tailscale ? await enableShare(port) : share;
      originsCache = null; // share.url changed; reparsed on next request
      await persistRuntime();
      return share;
    })();
    try {
      return await refreshPromise;
    } finally {
      refreshPromise = null;
    }
  }
  let diagnosticPromise = null;
  async function diagnostics() {
    if (diagnosticPromise) return diagnosticPromise;
    diagnosticPromise = (async () => {
      const [currentShare, tunnel] = await Promise.all([
        tailscale
          ? (options.inspectShare || inspectShare)(port)
          : { state: "disabled", observed_at: new Date().toISOString() },
        inspectTunnel(project, instanceId),
      ]);
      return connectionReport({
        project,
        startedAt,
        browser: connections.snapshot("browser_auth"),
        mcp: {
          authentication: connections.snapshot("mcp_auth"),
          discovery: connections.snapshot("server/discover"),
          tools: connections.snapshot("tools/list"),
          events: connections.snapshot("events/list"),
        },
        share: currentShare,
        tunnel,
        events: eventsHub.diagnostics(),
      });
    })();
    try {
      return await diagnosticPromise;
    } finally {
      diagnosticPromise = null;
    }
  }
  async function mutate(operation, input) {
    if (!store)
      throw new Error("Project operations are unavailable in Harness mode");
    const task = updateQueue.then(async () => {
      const state = await store.mutate(operation, input);
      for (const response of live)
        response.write(`event: changed\ndata: ${state.revision}\n\n`);
      for (const { mcp } of sessions.values()) void mcp.notify();
      void eventsHub.flush().catch(() => {});
      return visibleState();
    });
    updateQueue = task.catch(() => {});
    return task;
  }
  async function mutateReply(operation, input, context) {
    const task = updateQueue.then(async () => {
      const result = await store.mutateReply(operation, input, context);
      for (const response of live)
        response.write(`event: changed\ndata: ${store.value.revision}\n\n`);
      for (const { mcp } of sessions.values()) void mcp.notify();
      return result;
    });
    updateQueue = task.catch(() => {});
    return task;
  }
  async function mutateBudget(operation, input) {
    const task = updateQueue.then(async () => {
      const result = await store.mutateBudget(operation, input);
      for (const response of live)
        response.write(`event: changed\ndata: ${store.value.revision}\n\n`);
      for (const { mcp } of sessions.values()) void mcp.notify();
      return result;
    });
    updateQueue = task.catch(() => {});
    return task;
  }
  async function backupOperation(action, input) {
    const task = updateQueue.then(async () => {
      if (action === "history") {
        if (Object.keys(input).length)
          throw new Error("History takes no input");
        return {
          project_id: project.id,
          revision: store.value.revision,
          history_backups: structuredClone(store.value.history_backups || []),
        };
      }
      const acceptance = await (await AcceptanceStore.open(project)).read();
      if (action === "preview") {
        if (
          !input ||
          typeof input !== "object" ||
          Array.isArray(input) ||
          !Object.hasOwn(input, "selection") ||
          Object.keys(input).some((k) => !["selection", "review"].includes(k))
        )
          throw new Error("Invalid backup preview fields");
        return createHistoryBackup(
          store.value,
          acceptance,
          input.selection,
          input.review,
        );
      }
      const result = await store.restoreBackup(
        input,
        acceptance.evidence.map((r) => r.evidence_id),
        acceptance.tasks.map((r) => r.id),
      );
      for (const response of live)
        response.write(`event: changed\ndata: ${store.value.revision}\n\n`);
      for (const { mcp } of sessions.values()) void mcp.notify();
      return result;
    });
    updateQueue = task.catch(() => {});
    return task;
  }
  const server = http.createServer(async (req, res) => {
    res.setHeader("cache-control", "no-store");
    res.setHeader("referrer-policy", "no-referrer");
    res.setHeader("x-content-type-options", "nosniff");
    try {
      if (!trusted(req))
        return json(res, 403, { error: "Untrusted host or origin" });
      const url = new URL(req.url, localUrl);
      if (
        kind === "harness" &&
        req.method === "GET" &&
        equal(url.searchParams.get("rdsh_dashboard_key"), browserToken)
      ) {
        url.searchParams.delete("rdsh_dashboard_key");
        const secure =
          share.url && req.headers.host === new URL(share.url).host
            ? "; Secure"
            : "";
        res.writeHead(303, {
          "set-cookie": `${cookieName}=${browserToken}; HttpOnly; SameSite=Strict; Path=/${secure}`,
          location: url.pathname + url.search,
        });
        return res.end();
      }
      const prefix = kind === "harness" ? "/_rdsh" : "";
      const route = url.pathname.startsWith(prefix + "/")
        ? url.pathname.slice(prefix.length)
        : null;
      const adminAuthorized = equal(
        req.headers.authorization,
        `Bearer ${token}`,
      );
      const agentRoute =
        route === "/mcp" ||
        route === "/api/state" ||
        route === "/api/instructions/context" ||
        (req.method === "POST" && route === "/api/instructions/submit") ||
        (req.method === "POST" &&
          ["metrics", "task", "question", "event"].some(
            (operation) => route === `/api/update/${operation}`,
          ));
      const mcpAuthorized =
        kind === "project" &&
        agentRoute &&
        equal(req.headers.authorization, `Bearer ${mcpToken}`);
      const humanAuthorized = browserAuthorized(req, url, route);
      if (kind === "project" && route === "/mcp")
        connections.record(
          "mcp_auth",
          mcpAuthorized,
          mcpAuthorized ? "authenticated" : "unauthorized",
        );
      if (
        kind === "project" &&
        ["/api/state", "/api/config"].includes(route) &&
        (humanAuthorized || req.headers["x-rdsh-browser-token"])
      )
        connections.record(
          "browser_auth",
          humanAuthorized,
          humanAuthorized ? "authenticated" : "unauthorized",
          share.url && req.headers.host === new URL(share.url).host
            ? "tailscale"
            : "loopback",
        );
      const consumerRoute =
        kind === "project" &&
        ((req.method === "GET" && route === "/api/replies/read") ||
          (req.method === "POST" &&
            ["/api/replies/ack", "/api/replies/control"].includes(route)));
      const consumerToken = req.headers["x-rdsh-consumer-token"];
      const budgetProducerRoute =
        kind === "project" &&
        req.method === "POST" &&
        route?.startsWith("/api/budget/producer/");
      const budgetToken = req.headers["x-rdsh-budget-token"];
      const publicAsset =
        kind === "project" &&
        req.method === "GET" &&
        (route === "/" ||
          route === "/app.mjs" ||
          route === "/observations.mjs" ||
          route === "/reports-view.mjs" ||
          route === "/question-cards-ui.mjs" ||
          route === "/project-overview.mjs" ||
          route === "/connection-diagnostics-ui.mjs" ||
          route === "/answer-applications-ui.mjs" ||
          route === "/instruction-queue-ui.mjs" ||
          route === "/cost-ledger-ui.mjs" ||
          route === "/budget-ui.mjs" ||
          route === "/favicon.ico" ||
          route === "/icon.png" ||
          route === "/icon.svg");
      if (
        !publicAsset &&
        !adminAuthorized &&
        !mcpAuthorized &&
        !humanAuthorized &&
        !(budgetProducerRoute && typeof budgetToken === "string") &&
        !(consumerRoute && typeof consumerToken === "string")
      )
        return json(res, 401, {
          error:
            "Open this dashboard through rdsh-dashboard open or its QR code",
        });
      if (closing) return json(res, 503, { error: "Dashboard is stopping" });
      if (
        req.method === "GET" &&
        ["/favicon.ico", "/icon.png", "/icon.svg"].includes(route)
      ) {
        const [file, type] =
          route === "/favicon.ico"
            ? ["icon.ico", "image/x-icon"]
            : route === "/icon.png"
              ? ["icon-256.png", "image/png"]
              : ["icon.svg", "image/svg+xml"];
        const bytes = await fs.readFile(path.join(here, "../assets", file));
        res.writeHead(200, {
          "content-type": type,
          "x-content-type-options": "nosniff",
        });
        return res.end(bytes);
      }
      if (req.method === "GET" && route === "/api/managed-process")
        return json(
          res,
          200,
          harness
            ? await harness.inspect()
            : { run_id: null, scope: null, stages: [] },
        );
      if (req.method === "POST" && route === "/api/managed-stop") {
        if (!harness)
          return json(res, 409, { error: "No owned Harness process" });
        if (!adminAuthorized && !humanAuthorized)
          return json(res, 401, {
            error: "Human browser or administrator required",
          });
        void harness.stop().catch(() => {});
        return json(res, 202, { requested: true, run_id: harness.run_id });
      }
      if (req.method === "POST" && route === "/api/stop") {
        if (!adminAuthorized)
          return json(res, 401, {
            error: "Administrator bearer token required",
          });
        const result = harness ? await harness.stop() : null;
        if (result && !result.confirmed)
          return json(res, 409, {
            error:
              "Managed descendants are unverified; dashboard remains available",
            managed_stop: result,
          });
        res.once("finish", () => {
          void close().catch(() => {});
        });
        return json(res, 200, { stopping: true, managed_stop: result });
      }
      if (
        req.method === "POST" &&
        route === "/api/events/revoke" &&
        eventsHub
      ) {
        if (!adminAuthorized)
          return json(res, 401, {
            error: "Administrator bearer token required",
          });
        await eventsHub.revoke();
        return json(res, 200, { revoked: true });
      }
      if (req.method === "GET" && route === "/") {
        res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
        return res.end(await fs.readFile(path.join(here, "ui.html")));
      }
      if (
        req.method === "GET" &&
        [
          "/app.mjs",
          "/observations.mjs",
          "/reports-view.mjs",
          "/question-cards-ui.mjs",
          "/project-overview.mjs",
          "/connection-diagnostics-ui.mjs",
          "/answer-applications-ui.mjs",
          "/instruction-queue-ui.mjs",
          "/cost-ledger-ui.mjs",
          "/budget-ui.mjs",
        ].includes(route)
      ) {
        res.writeHead(200, {
          "content-type": "text/javascript; charset=utf-8",
        });
        return res.end(await fs.readFile(path.join(here, route.slice(1))));
      }
      if (
        kind === "project" &&
        req.method === "GET" &&
        route === "/api/diagnostics"
      )
        return json(res, 200, await diagnostics());
      if (
        kind === "project" &&
        req.method === "GET" &&
        route === "/api/run-diagnostics"
      ) {
        const history = new RunHistory(project);
        return json(
          res,
          200,
          await history.diagnoseRecent({
            uiConnection: humanAuthorized ? "connected" : "unknown",
          }),
        );
      }
      if (req.method === "GET" && route === "/api/config")
        return json(res, 200, {
          kind,
          instance_id: instanceId,
          project: project
            ? { id: project.id, name: project.name, root: project.root }
            : null,
          share,
          events: eventsHub?.status() || null,
          mcp_url: kind === "project" && share.url ? `${share.url}mcp` : null,
          harness_url: harness
            ? "/" + harness.url.search + harness.url.hash
            : null,
        });
      if (req.method === "POST" && route === "/api/share/refresh")
        return json(res, 200, await refreshShare());
      if (req.method === "GET" && route === "/api/qr.svg") {
        if (!share.url)
          return json(res, 409, { error: "Tailscale connection is not ready" });
        const svg = await QRCode.toString(
          browserUrl(share.url, kind === "harness"),
          { type: "svg", errorCorrectionLevel: "M", margin: 4, width: 280 },
        );
        res.writeHead(200, { "content-type": "image/svg+xml" });
        return res.end(svg);
      }
      if (kind === "project") {
        if (req.method === "POST" && route?.startsWith("/api/backup/")) {
          if (
            !adminAuthorized ||
            !["127.0.0.1", "::1", "::ffff:127.0.0.1"].includes(
              req.socket.remoteAddress,
            )
          )
            return json(res, 403, {
              error: "Backup requires the local administrator credential",
            });
          const action = route.slice("/api/backup/".length);
          if (!["preview", "restore", "history"].includes(action))
            return json(res, 404, { error: "Unknown backup operation" });
          return json(
            res,
            200,
            await backupOperation(
              action,
              await readBody(req, backupMaximum + 65536),
            ),
          );
        }
        if (req.method === "POST" && route?.startsWith("/api/budget/")) {
          if (
            !["127.0.0.1", "::1", "::ffff:127.0.0.1"].includes(
              req.socket.remoteAddress,
            )
          )
            return json(res, 403, {
              error: "Budget control requires loopback access",
            });
          const action = route.slice("/api/budget/".length);
          const input = await readBody(req);
          if (budgetProducerRoute)
            return json(
              res,
              200,
              await budgets.producer(
                action.slice("producer/".length),
                input,
                budgetToken,
              ),
            );
          if (!adminAuthorized)
            return json(res, 403, {
              error:
                "Local administrator credential required for budget control",
            });
          if (action === "launch")
            return json(res, 200, await budgets.launch(input));
          if (action === "revoke")
            return json(res, 200, await budgets.revoke(input));
          if (action === "inspect")
            return json(
              res,
              200,
              (await visibleState()).budget_admission || null,
            );
          if (["policy", "usage"].includes(action))
            return json(res, 200, await mutateBudget(action, input));
          return json(res, 404, { error: "Unknown budget operation" });
        }
        if (req.method === "GET" && route === "/api/instructions/context")
          return json(
            res,
            200,
            await applications.instructionContext(
              url.searchParams.get("consumer_id"),
            ),
          );
        if (
          req.method === "POST" &&
          ["/api/instructions/submit", "/api/instructions/resolve"].includes(
            route,
          )
        ) {
          const resolve = route.endsWith("/resolve");
          if (resolve && !humanAuthorized && !adminAuthorized)
            return json(res, 403, { error: "Human confirmation required" });
          return json(
            res,
            200,
            await applications.instruction(
              await readBody(req),
              adminAuthorized
                ? "administrator"
                : mcpAuthorized
                  ? "management_agent"
                  : "human",
              resolve,
            ),
          );
        }
        if (req.method === "POST" && route === "/api/replies/register") {
          if (!adminAuthorized)
            return json(res, 403, {
              error: "Local administrator must bind the verified ACP owner",
            });
          return json(
            res,
            200,
            await applications.register(await readBody(req)),
          );
        }
        if (consumerRoute) {
          if (typeof consumerToken !== "string")
            return json(res, 403, {
              error: "Separate consumer credential required",
            });
          if (req.method === "GET")
            return json(
              res,
              200,
              await applications.read(
                url.searchParams.get("consumer_id"),
                consumerToken,
                Number(url.searchParams.get("after") || "0"),
              ),
            );
          return json(
            res,
            200,
            route.endsWith("/control")
              ? await applications.control(await readBody(req), consumerToken)
              : await applications.ack(await readBody(req), consumerToken),
          );
        }
        if (req.method === "POST" && route === "/api/decision/cancel") {
          if (!humanAuthorized)
            return json(res, 403, {
              error: "Human browser credential required",
            });
          const input = await readBody(req);
          return json(
            res,
            200,
            await mutate("question", { ...input, action: "cancel" }),
          );
        }
        if (req.method === "GET" && route === "/api/state")
          return json(res, 200, await visibleState());
        if (req.method === "POST" && route?.startsWith("/api/update/")) {
          const operation = route.slice("/api/update/".length);
          if (
            !["metrics", "task", "question", "answer", "event"].includes(
              operation,
            )
          )
            return json(res, 404, { error: "Unknown project operation" });
          if (
            operation === "answer"
              ? !humanAuthorized
              : !(mcpAuthorized || adminAuthorized)
          )
            return json(res, 403, {
              error: "This credential cannot perform that operation",
            });
          return json(res, 200, await mutate(operation, await readBody(req)));
        }
        if (req.method === "GET" && route === "/api/live") {
          res.writeHead(200, {
            "content-type": "text/event-stream",
            connection: "keep-alive",
          });
          res.write(": connected\n\n");
          live.add(res);
          const ping = setInterval(() => res.write(": ping\n\n"), 20000);
          req.on("close", () => {
            clearInterval(ping);
            live.delete(res);
          });
          return;
        }
        if (route === "/mcp") {
          // MCP clients use a bearer token; browser cookies are not an MCP credential.
          if (!mcpAuthorized)
            return json(res, 401, { error: "MCP bearer token required" });
          const sessionId = req.headers["mcp-session-id"];
          const body = req.method === "POST" ? await readBody(req) : undefined;
          if (!sessionId && !(await modern.isLegacy(req, body)))
            return await modern.handle(req, res, body);
          let session = sessions.get(sessionId);
          if (!session && sessionId)
            return json(res, 404, {
              error: "Unknown MCP session; initialize again",
            });
          if (!session && req.method === "POST" && isInitializeRequest(body)) {
            const mcp = createMcpServer({
              getState: visibleState,
              mutate,
            });
            const transport = new StreamableHTTPServerTransport({
              sessionIdGenerator: randomUUID,
              onsessioninitialized: (id) =>
                sessions.set(id, { transport, mcp }),
            });
            await mcp.server.connect(transport);
            mcp.server.onclose = () => {
              if (transport.sessionId) sessions.delete(transport.sessionId);
            };
            session = { transport, mcp };
          }
          if (!session)
            return json(res, 400, { error: "MCP initialization required" });
          return await session.transport.handleRequest(req, res, body);
        }
      }
      if (kind === "harness" && !url.pathname.startsWith("/_rdsh"))
        return proxyHarness(req, res, harness.port, cookieName, token);
      json(res, 404, { error: "Not found" });
    } catch (e) {
      if (!res.headersSent)
        json(res, [401, 403, 409].includes(e.status) ? e.status : 400, {
          error: e.message,
        });
      else res.end();
    }
  });
  server.on("connection", (socket) => {
    sockets.add(socket);
    socket.once("close", () => sockets.delete(socket));
  });
  server.on("upgrade", (req, socket, head) => {
    const authorizedUpgrade =
      equal(req.headers.authorization, `Bearer ${token}`) ||
      (kind === "harness" && browserAuthorized(req, null, null));
    if (kind !== "harness" || !harness || !trusted(req) || !authorizedUpgrade) {
      socket.write("HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n");
      socket.destroy();
      return;
    }
    upgradeHarness(req, socket, head, harness.port, cookieName, token);
  });
  async function close() {
    if (closing) return;
    if (harness && !(await harness.stop()).confirmed)
      throw new Error(
        "Owned Harness exit unverified; dashboard remains available",
      );
    closing = true;
    if (deliveryTimer) clearInterval(deliveryTimer);
    for (const response of live) response.end();
    for (const { mcp } of sessions.values()) await mcp.server.close();
    await updateQueue;
    await eventsHub?.queue;
    for (const socket of sockets) socket.destroy();
    await new Promise((resolve) => server.close(resolve));
    await fs.unlink(lockFile).catch(() => {});
  }
  try {
    await new Promise((resolve, reject) => {
      server.once("error", reject);
      server.listen(port, "127.0.0.1", resolve);
    });
    if (kind === "harness")
      harness = await startHarness(options.harnessPort || 3081, port, {
        ...options.harnessOptions,
        project: { id: "managed-harness", directory },
      });
    if (harness && options.observeHarness) options.observeHarness(harness);
    await refreshShare();
  } catch (e) {
    await close();
    throw e;
  }
  return {
    server,
    close,
    port,
    localUrl,
    directory,
    browserUrl: browserUrl(localUrl),
    getShare: () => share,
    mutate,
    store,
  };
}
