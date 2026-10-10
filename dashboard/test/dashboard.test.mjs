import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import net from "node:net";
import http from "node:http";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { ResourceUpdatedNotificationSchema } from "@modelcontextprotocol/sdk/types.js";
import { identity, applyOperation, ProjectStore } from "../state.mjs";
import { startDashboard } from "../server.mjs";
import { checkPortConfig } from "../tailscale.mjs";
import { feedbackSince } from "../mcp.mjs";
import { proxyHarness } from "../harness.mjs";
import { RunHistory } from "../run-history.mjs";

async function freePort() {
  const server = net.createServer();
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = server.address().port;
  await new Promise((resolve) => server.close(resolve));
  return port;
}
test("Serve preserves other services and refuses public Funnel or port conflicts", () => {
  const host = "device.tail-test.ts.net",
    target = "http://127.0.0.1:38800",
    authority = host + ":38800";
  assert.equal(checkPortConfig({}, host, 38800, target), false);
  const config = {
    TCP: { 38800: { HTTPS: true } },
    Web: { [authority]: { Handlers: { "/": { Proxy: target } } } },
  };
  assert.equal(checkPortConfig(config, host, 38800, target), true);
  assert.throws(
    () =>
      checkPortConfig(
        { ...config, AllowFunnel: { [authority]: true } },
        host,
        38800,
        target,
      ),
    /Funnel/,
  );
  assert.throws(
    () => checkPortConfig(config, host, 38800, target + "9"),
    /another application/,
  );
  assert.throws(
    () =>
      checkPortConfig(
        { TCP: { 38800: { TCPForward: "127.0.0.1:22" } } },
        host,
        38800,
        target,
      ),
    /another TCP/,
  );
  assert.throws(
    () =>
      checkPortConfig(
        {
          Foreground: {
            session: { ...config, AllowFunnel: { [authority]: true } },
          },
        },
        host,
        38800,
        target,
      ),
    /Funnel/,
  );
});
test("Harness proxy removes dashboard credentials before forwarding", async (t) => {
  let received;
  const upstream = http.createServer((req, res) => {
    received = req.headers;
    res.end("ok");
  });
  await new Promise((resolve) => upstream.listen(0, "127.0.0.1", resolve));
  t.after(() => upstream.close());
  const front = http.createServer((req, res) =>
    proxyHarness(
      req,
      res,
      upstream.address().port,
      "rdsh_harness",
      "admin-key",
    ),
  );
  await new Promise((resolve) => front.listen(0, "127.0.0.1", resolve));
  t.after(() => front.close());
  const response = await fetch(`http://127.0.0.1:${front.address().port}/`, {
    headers: {
      cookie: "rdsh_harness=secret; upstream=keep",
      authorization: "Bearer admin-key",
    },
  });
  assert.equal(await response.text(), "ok");
  assert.equal(received.cookie, "upstream=keep");
  assert.equal(received.authorization, undefined);
});
test("project state, HTTP/stdio MCP, subscriptions, answers, and auth work together", async (t) => {
  const temporary = await fs.mkdtemp(
    path.join(os.tmpdir(), "rdsh-dashboard-test-"),
  );
  const previousHome = process.env.RDSH_DASHBOARD_HOME;
  process.env.RDSH_DASHBOARD_HOME = path.join(temporary, "state");
  let dashboard, other, client, stdio;
  t.after(async () => {
    await stdio?.close();
    await client?.close();
    await dashboard?.close();
    await other?.close();
    if (previousHome) process.env.RDSH_DASHBOARD_HOME = previousHome;
    else delete process.env.RDSH_DASHBOARD_HOME;
    await fs.rm(temporary, { recursive: true, force: true });
  });
  await fs.mkdir(path.join(temporary, "alpha"));
  await fs.mkdir(path.join(temporary, "beta"));
  const alpha = await identity(path.join(temporary, "alpha")),
    beta = await identity(path.join(temporary, "beta"));
  assert.notEqual(alpha.id, beta.id);
  dashboard = await startDashboard({
    project: alpha,
    port: await freePort(),
    tailscale: false,
  });
  other = await startDashboard({
    project: beta,
    port: await freePort(),
    tailscale: false,
  });
  const runtime = JSON.parse(
    await fs.readFile(path.join(alpha.directory, "runtime.json"), "utf8"),
  );
  const headers = {
    authorization: `Bearer ${runtime.token}`,
    "content-type": "application/json",
  };
  assert.equal((await fetch(dashboard.localUrl + "api/state")).status, 401);
  const favicon = await fetch(dashboard.localUrl + "favicon.ico");
  assert.equal(favicon.status, 200);
  assert.equal(favicon.headers.get("content-type"), "image/x-icon");
  assert.deepEqual(
    Buffer.from(await favicon.arrayBuffer()),
    await fs.readFile(new URL("../../assets/icon.ico", import.meta.url)),
  );
  const brandIcon = await fetch(dashboard.localUrl + "icon.png");
  assert.equal(brandIcon.headers.get("content-type"), "image/png");
  assert.deepEqual(
    Buffer.from(await brandIcon.arrayBuffer()),
    await fs.readFile(new URL("../../assets/icon-256.png", import.meta.url)),
  );
  assert.equal(
    (
      await fetch(dashboard.localUrl + "api/state", {
        headers: { ...headers, origin: "https://evil.example" },
      })
    ).status,
    403,
  );
  const rebindingStatus = await new Promise((resolve, reject) => {
    const request = http.get(
      dashboard.localUrl + "api/state",
      { headers: { ...headers, host: "evil.example" } },
      (response) => {
        response.resume();
        resolve(response.statusCode);
      },
    );
    request.on("error", reject);
  });
  assert.equal(rebindingStatus, 403);
  const browserToken = new URL(runtime.browser_url).hash.slice("#key=".length);
  const browserHeaders = { "x-rdsh-browser-token": browserToken };
  const runHistory = await RunHistory.open(alpha);
  const sampleRunId = "run_00000000-0000-4000-8000-000000000001";
  await runHistory.register(sampleRunId, "fixture-session-private");
  assert.equal(
    (await fetch(dashboard.localUrl + "api/run-diagnostics")).status,
    401,
  );
  const runDiagnostics = await fetch(dashboard.localUrl + "api/run-diagnostics", {
    headers: browserHeaders,
  });
  assert.equal(runDiagnostics.status, 200);
  const runReport = await runDiagnostics.json();
  assert.equal(runReport.schema, 1);
  assert.ok(Number.isFinite(Date.parse(runReport.observed_at)));
  assert.equal(runReport.runs.length, 1);
  assert.equal(runReport.runs[0].run_id, sampleRunId);
  assert.equal(
    runReport.runs[0].stall_diagnosis.classification,
    "insufficient_evidence",
  );
  assert.equal(Object.hasOwn(runReport.runs[0], "native_session_id"), false);
  const bootstrap = await fetch(runtime.browser_url);
  assert.equal(bootstrap.status, 200);
  assert.equal(bootstrap.headers.get("set-cookie"), null);
  const html = await bootstrap.text();
  assert.match(html, /未回答の質問/);
  assert.match(html, /run-diagnostics-refresh/);
  assert.equal(
    (await fetch(dashboard.localUrl + "api/qr.svg", { headers })).status,
    409,
  );
  assert.equal(
    (
      await fetch(dashboard.localUrl + "mcp", {
        method: "POST",
        headers: { ...browserHeaders, "content-type": "application/json" },
        body: "{}",
      })
    ).status,
    401,
  );
  client = new Client(
    { name: "dashboard-test", version: "1.0.0" },
    { capabilities: {} },
  );
  await client.connect(
    new StreamableHTTPClientTransport(new URL(dashboard.localUrl + "mcp"), {
      requestInit: {
        headers: { ...headers, authorization: `Bearer ${runtime.mcp_token}` },
      },
    }),
  );
  assert.equal((await client.listTools()).tools.length, 6);
  let notified;
  const notification = new Promise((resolve) => {
    notified = resolve;
  });
  client.setNotificationHandler(ResourceUpdatedNotificationSchema, () =>
    notified(),
  );
  await client.subscribeResource({ uri: "dashboard://feedback" });
  const call = async (name, args) => {
    const result = await client.callTool({ name, arguments: args });
    assert.notEqual(result.isError, true, result.content[0]?.text);
    return JSON.parse(result.content[0].text);
  };
  await call("dashboard_update_metrics", {
    input_tokens: 1000,
    cached_input_tokens: 983,
    tool_calls: 1127,
    tool_errors: 19,
    total_cost_usd: 90.71,
    total_budget_usd: 300,
    session_id: "test-only",
    observation: {
      kind: "measured",
      source: "integration fixture usage report",
      observed_at: new Date(Date.now() - 1000).toISOString(),
      session_id: "test-only",
      reference: "fixture-request-1",
    },
  });
  const reported = await call("dashboard_get_state", {});
  assert.equal(reported.metric_observations.total_cost_usd.kind, "measured");
  assert.equal(reported.metric_observations.total_cost_usd.session_id, "test-only");
  assert.equal(reported.metric_observations.total_cost_usd.reference, "fixture-request-1");
  const observationAsset = await fetch(dashboard.localUrl + "observations.mjs");
  assert.equal(observationAsset.status, 200);
  assert.match(observationAsset.headers.get("content-type"), /javascript/);
  await call("dashboard_upsert_task", {
    id: "M3.6",
    title: "A test task",
    status: "doing",
    milestone: "M3",
  });
  await call("dashboard_ask_question", {
    id: "Q1",
    question: "Choose a test answer",
    urgency: "high",
    default_action: "Wait",
  });
  await call("dashboard_publish_event", {
    title: "Test report",
    type: "artifact",
    artifact: "reference-only.png",
  });
  const forgedAnswer = await fetch(dashboard.localUrl + "api/update/answer", {
    method: "POST",
    headers: { ...headers, authorization: `Bearer ${runtime.mcp_token}` },
    body: JSON.stringify({ id: "Q1", answer: "forged" }),
  });
  assert.equal(forgedAnswer.status, 401);
  assert.equal(dashboard.store.value.questions[0].answer, null);
  const adminAnswer = await fetch(dashboard.localUrl + "api/update/answer", {
    method: "POST",
    headers,
    body: JSON.stringify({ id: "Q1", answer: "admin forged" }),
  });
  assert.equal(adminAnswer.status, 403);
  assert.equal(other.store.value.tasks.length, 0);
  assert.equal(other.store.value.questions.length, 0);
  const error = await client.callTool({
    name: "dashboard_update_metrics",
    arguments: { cached_input_tokens: 1001 },
  });
  assert.equal(error.isError, true);
  assert.equal(dashboard.store.value.metrics.cached_input_tokens, 983);
  const answer = await fetch(dashboard.localUrl + "api/update/answer", {
    method: "POST",
    headers: {
      ...browserHeaders,
      "content-type": "application/json",
      origin: new URL(dashboard.localUrl).origin,
    },
    body: JSON.stringify({ id: "Q1", answer: "Approved for test" }),
  });
  assert.equal(answer.status, 200);
  await Promise.race([
    notification,
    new Promise((_, reject) =>
      setTimeout(() => reject(new Error("MCP notification timed out")), 5000),
    ),
  ]);
  const feedback = await call("dashboard_get_feedback", { after: 0 });
  assert.equal(feedback.messages[0].answer, "Approved for test");
  assert.equal(feedback.next_cursor, 1);
  assert.equal(
    (await call("dashboard_get_feedback", { after: 1 })).messages.length,
    0,
  );
  assert.deepEqual(feedbackSince(dashboard.store.value, 0), feedback);
  stdio = new Client(
    { name: "stdio-test", version: "1.0.0" },
    { capabilities: {} },
  );
  await stdio.connect(
    new StdioClientTransport({
      command: process.execPath,
      args: [path.resolve("cli.mjs"), "mcp", "--project", alpha.root],
      env: { ...process.env },
      stderr: "pipe",
    }),
  );
  const stdioFeedback = await stdio.callTool({
    name: "dashboard_get_feedback",
    arguments: { after: 0 },
  });
  assert.equal(
    JSON.parse(stdioFeedback.content[0].text).messages[0].answer,
    "Approved for test",
  );
  const persisted = await ProjectStore.open(alpha);
  assert.equal(persisted.value.questions[0].answer, "Approved for test");
  assert.deepEqual(persisted.value.metric_observations, dashboard.store.value.metric_observations);
  await assert.rejects(
    () => startDashboard({ project: alpha, port: 39099, tailscale: false }),
    /already running/,
  );
});
test("unknown metrics and invalid reported counters are rejected", () => {
  const state = {
    metrics: {},
    tasks: [],
    questions: [],
    feedback: [],
    events: [],
  };
  assert.throws(
    () =>
      applyOperation(state, "metrics", {
        cached_input_tokens: 10,
        input_tokens: 1,
      }),
    /exceed/,
  );
  assert.throws(
    () => applyOperation(state, "metrics", { tool_errors: -1 }),
    /Invalid/,
  );
  assert.throws(
    () => applyOperation(state, "metrics", { tool_calls: 1.1 }),
    /Invalid/,
  );
  assert.throws(
    () => applyOperation(state, "metrics", { made_up: 99 }),
    /Unknown/,
  );
});

test("failed state startup releases the instance lock and administrative stop closes the server", async (t) => {
  const temporary = await fs.mkdtemp(
    path.join(os.tmpdir(), "rdsh-startup-test-"),
  );
  t.after(() => fs.rm(temporary, { recursive: true, force: true }));
  const project = {
    id: "startup-test",
    name: "Startup test",
    root: temporary,
    directory: path.join(temporary, "state"),
  };
  await fs.mkdir(project.directory);
  await fs.writeFile(path.join(project.directory, "events.json"), "corrupted");
  await assert.rejects(
    () => startDashboard({ project, port: 39123, tailscale: false }),
    /JSON/,
  );
  await assert.rejects(
    () => fs.stat(path.join(project.directory, "server.lock")),
    (error) => error.code === "ENOENT",
  );
  await fs.unlink(path.join(project.directory, "events.json"));
  const dashboard = await startDashboard({
    project,
    port: await freePort(),
    tailscale: false,
  });
  t.after(() => dashboard.close());
  const runtime = JSON.parse(
    await fs.readFile(path.join(project.directory, "runtime.json"), "utf8"),
  );
  const stopped = new Promise((resolve) =>
    dashboard.server.once("close", resolve),
  );
  const response = await fetch(dashboard.localUrl + "api/stop", {
    method: "POST",
    headers: { authorization: "Bearer " + runtime.token },
  });
  assert.equal(response.status, 200);
  await stopped;
  await assert.rejects(() => fetch(dashboard.localUrl));
});
