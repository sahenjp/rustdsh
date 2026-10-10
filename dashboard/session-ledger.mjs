// Identity links only. Native CLI sessions, conversations and agent loops stay in DSH.
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { writeJson } from "./state.mjs";
import { adapterCatalog, createCliAdapter } from "./adapters.mjs";
import { preflightTask, taskRequirements, requireReady } from "./preflight.mjs";
import { RunHistory, HistoryError } from "./run-history.mjs";
import { readProcessIdentity } from "./process-identity.mjs";
import { trackAdapter } from "./tracked-adapter.mjs";
import { ModelRouting } from "./model-routing.mjs";
import { prepareBudgetAttachment } from "./budget-client.mjs";

const exec = promisify(execFile);
const scopeKeys = [
  "HOME",
  "USERPROFILE",
  "DSH_HOME",
  "XDG_CONFIG_HOME",
  "XDG_DATA_HOME",
  "APPDATA",
  "LOCALAPPDATA",
];
const fields = [
  "run_id",
  "project_id",
  "task_id",
  "label",
  "cli",
  "cli_session_id",
  "binding",
  "cwd",
  "branch",
  "git",
  "provider",
  "launch",
  "scope",
  "cli_version",
  "created_at",
  "last_attached_at",
];
const object = (value) =>
  value !== null && typeof value === "object" && !Array.isArray(value);
const runId = (value) =>
  typeof value === "string" &&
  /^run_[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(
    value,
  );
const text = (value, max = 256) =>
  typeof value === "string" &&
  value.trim().length > 0 &&
  value.length <= max &&
  !/[\x00-\x1f\x7f]/.test(value);
const optional = (value, max) => value === null || text(value, max);
const samePath = (a, b) =>
  process.platform === "win32" ? a.toLowerCase() === b.toLowerCase() : a === b;
const sameOptionalPath = (a, b) =>
  a === null ? b === null : typeof b === "string" && samePath(a, b);
const time = (value) => text(value, 30) && Number.isFinite(Date.parse(value));
export class LedgerError extends Error {
  constructor(code) {
    super("Session ledger: " + code);
    this.code = code;
  }
}
function valid(value) {
  if (!value) throw new LedgerError("invalid_record");
}

// Resolve the existing ancestor too, so a not-yet-created CLI home under a
// symlink resolves identically after the native CLI creates that directory.
async function canonical(file, cwd = process.cwd()) {
  let candidate = path.resolve(cwd, file),
    suffix = [];
  while (true) {
    try {
      return path.join(await fs.realpath(candidate), ...suffix);
    } catch (error) {
      if (error.code !== "ENOENT" || path.dirname(candidate) === candidate)
        throw error;
      suffix.unshift(path.basename(candidate));
      candidate = path.dirname(candidate);
    }
  }
}
async function context(cwd, command, env) {
  const root = await fs.realpath(path.resolve(cwd));
  if (!(await fs.stat(root)).isDirectory())
    throw new LedgerError("cwd_unavailable");
  let marker = false;
  const ceilings = await Promise.all(
    (env.GIT_CEILING_DIRECTORIES || "")
      .split(path.delimiter)
      .filter((item) => path.isAbsolute(item))
      .map((item) => canonical(item)),
  );
  for (let directory = root; ; directory = path.dirname(directory)) {
    if (
      directory !== root &&
      ceilings.some((ceiling) => samePath(directory, ceiling))
    )
      break;
    try {
      await fs.stat(path.join(directory, ".git"));
      marker = true;
      break;
    } catch (error) {
      if (error.code !== "ENOENT") {
        marker = true;
        break;
      }
    }
    if (path.dirname(directory) === directory) break;
  }
  let git = {
      status: marker ? "unavailable" : "not_a_repository",
      root: null,
      head: null,
    },
    branch = null;
  const query = async (...args) =>
    (
      await exec("git", ["-C", root, ...args], {
        windowsHide: true,
        shell: false,
        timeout: 3000,
        maxBuffer: 4096,
        env,
      })
    ).stdout.trim();
  try {
    git.root = await fs.realpath(await query("rev-parse", "--show-toplevel"));
    git.head = await query("rev-parse", "--verify", "HEAD").catch(() => null);
    branch = await query("symbolic-ref", "--quiet", "--short", "HEAD").catch(
      () => null,
    );
    git.status = branch || git.head ? "observed" : "unavailable";
  } catch {
    /* Non-Git projects and unavailable Git remain unknown. */
  }
  let launch = null,
    scope = null;
  if (command !== null) {
    if (
      !Array.isArray(command) ||
      command.length < 1 ||
      command.length > 2 ||
      command.some((arg) => !text(arg, 4096))
    )
      throw new LedgerError("invalid_launch");
    const paths = [];
    for (const arg of command) {
      // Paths only: never persist shell strings, arbitrary flags or secrets in argv.
      if (!path.isAbsolute(arg))
        throw new LedgerError("absolute_executable_required");
      const file = await fs.realpath(arg);
      if (!(await fs.stat(file)).isFile())
        throw new LedgerError("invalid_launch");
      paths.push(file);
    }
    launch = {
      method: "acp-stdio-v1",
      executable: paths[0],
      entrypoint: paths[1] || null,
      profile: "acp",
    };
    const effectiveHome =
      process.platform === "win32"
        ? env.USERPROFILE || os.homedir()
        : env.HOME || os.homedir();
    scope = { effective_home: await canonical(effectiveHome, root) };
    for (const key of scopeKeys)
      scope[key] = env[key] ? await canonical(env[key], root) : null;
  }
  return { cwd: root, branch, git, launch, scope };
}
function validateRecord(record, projectId) {
  valid(
    object(record) &&
      Object.keys(record).length === fields.length &&
      fields.every((key) => Object.hasOwn(record, key)),
  );
  valid(runId(record.run_id) && record.project_id === projectId);
  valid(optional(record.task_id, 160) && optional(record.label, 1000));
  valid(adapterCatalog().some((adapter) => adapter.id === record.cli));
  valid(
    optional(record.cli_session_id, 256) &&
      ["unknown", "reported", "confirmed"].includes(record.binding),
  );
  valid((record.cli_session_id === null) === (record.binding === "unknown"));
  valid(
    text(record.cwd, 4096) &&
      path.isAbsolute(record.cwd) &&
      optional(record.branch, 1000),
  );
  valid(
    object(record.git) &&
      Object.keys(record.git).length === 3 &&
      ["observed", "not_a_repository", "unavailable"].includes(
        record.git.status,
      ) &&
      optional(record.git.root, 4096) &&
      optional(record.git.head, 64),
  );
  valid(
    optional(record.provider, 160) &&
      optional(record.cli_version, 80) &&
      time(record.created_at) &&
      (record.last_attached_at === null || time(record.last_attached_at)),
  );
  if (record.launch !== null) {
    const launch = record.launch;
    valid(
      record.cli === "dsh" &&
        object(launch) &&
        Object.keys(launch).length === 4 &&
        launch.method === "acp-stdio-v1" &&
        launch.profile === "acp" &&
        text(launch.executable, 4096) &&
        path.isAbsolute(launch.executable) &&
        optional(launch.entrypoint, 4096),
    );
    valid(launch.entrypoint === null || path.isAbsolute(launch.entrypoint));
    valid(
      object(record.scope) &&
        Object.keys(record.scope).length === scopeKeys.length + 1 &&
        text(record.scope.effective_home, 4096) &&
        path.isAbsolute(record.scope.effective_home),
    );
    for (const key of scopeKeys)
      valid(
        Object.hasOwn(record.scope, key) &&
          optional(record.scope[key], 4096) &&
          (record.scope[key] === null || path.isAbsolute(record.scope[key])),
      );
  } else valid(record.scope === null);
}
function validateFile(value, project) {
  if (
    !object(value) ||
    value.schema !== 1 ||
    value.project_id !== project.id ||
    !text(value.project_root, 4096) ||
    !samePath(value.project_root, project.root) ||
    !Number.isSafeInteger(value.revision) ||
    value.revision < 0 ||
    !Array.isArray(value.runs) ||
    value.runs.length > 5000
  )
    throw new LedgerError("invalid_ledger");
  const ids = new Set();
  for (const record of value.runs) {
    validateRecord(record, project.id);
    if (ids.has(record.run_id)) throw new LedgerError("duplicate_run");
    ids.add(record.run_id);
  }
  return value;
}
function view(record) {
  return {
    ...structuredClone(record),
    unknown_fields: [
      "task_id",
      "cli_session_id",
      "branch",
      "provider",
      "launch",
    ].filter((key) => record[key] === null),
    cli_session_display: record.cli_session_id ?? "不明",
  };
}

export class SessionLedger {
  constructor(project) {
    this.project = { ...project };
    this.file = path.join(project.directory, "sessions.json");
    this.lock = path.join(project.directory, "sessions.lock");
  }
  static async open(project) {
    if (
      !object(project) ||
      !text(project.id, 160) ||
      !text(project.directory, 4096) ||
      !path.isAbsolute(project.directory)
    )
      throw new LedgerError("invalid_project");
    const root = await fs.realpath(project.root);
    if (!(await fs.stat(root)).isDirectory())
      throw new LedgerError("invalid_project");
    const ledger = new SessionLedger({ ...project, root });
    await ledger.read();
    return ledger;
  }
  async read() {
    let handle;
    try {
      handle = await fs.open(this.file, "r");
      if ((await handle.stat()).size > 8 * 1024 * 1024)
        throw new LedgerError("ledger_too_large");
      return validateFile(
        JSON.parse(await handle.readFile("utf8")),
        this.project,
      );
    } catch (error) {
      if (error.code === "ENOENT")
        return {
          schema: 1,
          project_id: this.project.id,
          project_root: this.project.root,
          revision: 0,
          runs: [],
        };
      if (error instanceof LedgerError) throw error;
      throw new LedgerError("invalid_ledger");
    } finally {
      await handle?.close();
    }
  }
  async list() {
    return (await this.read()).runs.map(view);
  }
  async resolve(id) {
    if (!runId(id)) throw new LedgerError("exact_run_id_required");
    const record = (await this.read()).runs.find((run) => run.run_id === id);
    if (!record) throw new LedgerError("run_not_found");
    return view(record);
  }
  async mutate(operation) {
    await fs.mkdir(this.project.directory, { recursive: true });
    let handle;
    try {
      handle = await fs.open(this.lock, "wx", 0o600);
    } catch (error) {
      if (error.code === "EEXIST") throw new LedgerError("ledger_busy");
      throw error;
    }
    try {
      await handle.writeFile(
        JSON.stringify({ pid: process.pid, owner: randomUUID() }),
      );
      const next = await this.read();
      const result = await operation(next);
      next.revision++;
      validateFile(next, this.project);
      if (
        Buffer.byteLength(JSON.stringify(next, null, 2) + "\n") >
        8 * 1024 * 1024
      )
        throw new LedgerError("ledger_full");
      await writeJson(this.file, next);
      return result;
    } finally {
      await handle.close();
      await fs.unlink(this.lock);
    }
  }
  async record({
    task_id = null,
    label = null,
    cli = "dsh",
    cli_session_id = null,
    cwd = this.project.root,
    command = null,
    env = process.env,
    provider = null,
  } = {}) {
    const record = {
      run_id: "run_" + randomUUID(),
      project_id: this.project.id,
      task_id,
      label,
      cli,
      cli_session_id,
      binding: cli_session_id === null ? "unknown" : "reported",
      ...(await context(cwd, command, env)),
      provider,
      cli_version: null,
      created_at: new Date().toISOString(),
      last_attached_at: null,
    };
    validateRecord(record, this.project.id);
    await this.mutate((value) => {
      if (value.runs.length >= 5000) throw new LedgerError("ledger_full");
      value.runs.push(record);
    });
    return view(record);
  }
  async confirm(id, sessionId, version) {
    return this.mutate((value) => {
      const record = value.runs.find((run) => run.run_id === id);
      if (!record) throw new LedgerError("run_not_found");
      if (record.cli_session_id !== null && record.cli_session_id !== sessionId)
        throw new LedgerError("session_binding_immutable");
      record.cli_session_id = sessionId;
      record.binding = "confirmed";
      record.cli_version = version;
      record.last_attached_at = new Date().toISOString();
      return view(record);
    });
  }
}

export async function verifyRecordedContext(
  record,
  command,
  env = process.env,
) {
  if (record.cli !== "dsh" || record.launch === null)
    throw new LedgerError("launch_unknown_or_unsupported");
  const current = await context(record.cwd, command, env);
  const equalLaunch =
    current.launch &&
    Object.keys(record.launch).every((key) =>
      record.launch[key] === null
        ? current.launch[key] === null
        : key === "executable" || key === "entrypoint"
          ? typeof current.launch[key] === "string" &&
            samePath(record.launch[key], current.launch[key])
          : record.launch[key] === current.launch[key],
    );
  if (!equalLaunch) throw new LedgerError("launch_changed");
  if (
    !samePath(current.cwd, record.cwd) ||
    current.git.status !== record.git.status ||
    current.branch !== record.branch ||
    !sameOptionalPath(record.git.root, current.git.root) ||
    (record.branch === null && current.git.head !== record.git.head)
  )
    throw new LedgerError("repository_context_changed");
  if (
    !Object.keys(record.scope).every((key) =>
      record.scope[key] === null
        ? current.scope[key] === null
        : samePath(record.scope[key], current.scope[key]),
    )
  )
    throw new LedgerError("session_scope_changed");
  if (current.git.status === "unavailable")
    throw new LedgerError("repository_context_unknown");
  return current;
}

export async function attachRecordedSession({
  ledger,
  run_id = null,
  command,
  cwd = ledger.project.root,
  env = process.env,
  task_id = null,
  label = null,
  provider = null,
  requestTimeout,
  stopTimeout,
  requirements = null,
  verifyAuth = false,
  budget = null,
  onRecord = null,
} = {}) {
  env = { ...env };
  if (Array.isArray(command)) command = [...command];
  if (requirements !== null) {
    const selected = taskRequirements(requirements);
    selected.cli ||= "dsh";
    const target = run_id === null ? cwd : (await ledger.resolve(run_id)).cwd;
    requireReady(
      await preflightTask({
        requirements: selected,
        cwd: target,
        command,
        env,
        verifyAuth,
      }),
    );
  }
  let record;
  if (run_id === null)
    record = await ledger.record({
      command,
      cwd,
      env,
      task_id,
      label,
      provider,
    });
  else {
    record = await ledger.resolve(run_id);
    if (record.cli_session_id === null)
      throw new LedgerError("session_id_unknown");
    await verifyRecordedContext(record, command, env);
  }
  if (record.git.status === "unavailable")
    throw new LedgerError("repository_context_unknown");
  // Managed releases persist their immutable pin before budget/native dispatch.
  if (onRecord !== null) await onRecord(record);
  const history = await RunHistory.open(ledger.project);
  if (run_id !== null) {
    let previous;
    try {
      previous = await history.inspect(record.run_id);
    } catch (error) {
      if (error.code !== "run_not_found") throw error;
    }
    if (previous?.process) {
      const status = previous.process_observation.status;
      if (
        previous.scope &&
        previous.scope_observation.status !== "exit_confirmed" &&
        ["gone", "pid_reused", "exit_confirmed", "absence_observed"].includes(
          status,
        )
      )
        throw new HistoryError("run_descendants_unconfirmed");
      if (["gone", "pid_reused"].includes(status))
        await history.confirmAbsent(record.run_id);
      else if (!["exit_confirmed", "absence_observed"].includes(status))
        throw new HistoryError("run_process_unconfirmed");
    }
  }
  const budgetGuard =
    budget === null
      ? null
      : await prepareBudgetAttachment(
          ledger.project,
          record,
          budget,
          command,
          env,
        );
  if (budgetGuard) env = budgetGuard.env;
  let commandId;
  try {
    await history.register(record.run_id, record.cli_session_id);
    commandId = await history.recordCommand(
      record.run_id,
      run_id === null ? "start" : "resume",
    );
    await history.transition(record.run_id, "starting", "request_recorded");
    await history.commandPhase(commandId, "dispatched");
  } catch (error) {
    await budgetGuard?.close();
    throw error;
  }
  let processBound = false;
  const exitWrites = {
    pending: [],
    activityPending: new Set(),
    error: null,
    async flush() {
      await Promise.all([...this.pending, ...this.activityPending]);
    },
  };
  let adapter;
  try {
    adapter = createCliAdapter({
      cli: record.cli,
      command,
      cwd: record.cwd,
      env,
      patch: budgetGuard?.patch || null,
      requestTimeout,
      stopTimeout,
      owner_id: history.owner_id,
      onStopStage: async (stage) => {
        try {
          await history.stopStage(record.run_id, stage);
        } catch (error) {
          exitWrites.error ||= error;
        }
      },
      onOwnedSpawn: async (pid, scope) => {
        await history.bindScope(record.run_id, scope);
        const observed = scope.root_identity
          ? { status: "observed", identity: scope.root_identity }
          : await readProcessIdentity(pid);
        await history.bindProcess(
          record.run_id,
          observed.status === "observed" ? observed.identity : null,
          pid,
        );
        processBound = true;
        if (adapter.stopped) await history.processExited(record.run_id);
      },
    });
  } catch (error) {
    await budgetGuard?.close();
    throw error;
  }
  if (budgetGuard) {
    const originalStop = adapter.stop.bind(adapter);
    adapter.stop = async () => {
      try {
        return await originalStop();
      } finally {
        await budgetGuard.close();
      }
    };
  }
  let lastActivityAt = 0;
  let trackedSessionId = null;
  const activityKinds = {
    agent_message_chunk: "agent_message",
    tool_call: "tool_call",
    tool_call_update: "tool_update",
    usage_update: "usage",
    plan: "plan",
    current_mode_update: "mode",
  };
  adapter.on("event", (event) => {
    if (
      event.type === "session_update" &&
      event.session_id === trackedSessionId
    ) {
      const updateType = event.update?.sessionUpdate;
      const kind = activityKinds[updateType] || "other";
      const now = Date.now();
      if (now - lastActivityAt >= 60000) {
        lastActivityAt = now;
        const write = history
          .recordActivity(record.run_id, kind)
          .catch((error) => {
            exitWrites.error ||= error;
          });
        exitWrites.activityPending.add(write);
        void write.finally(() => exitWrites.activityPending.delete(write));
      }
    }
    if (event.type === "process_exit" && budgetGuard)
      exitWrites.pending.push(
        budgetGuard.close().catch((error) => {
          exitWrites.error ||= error;
        }),
      );
    if (event.type === "process_exit" && processBound)
      exitWrites.pending.push(
        history.processExited(record.run_id).catch((error) => {
          exitWrites.error ||= error;
        }),
      );
  });
  try {
    const report = await adapter.probe();
    if (
      record.cli_version !== null &&
      report.detected_version !== record.cli_version
    )
      throw new LedgerError("cli_version_changed");
    await history.scopeIntent(record.run_id);
    const attached =
      run_id === null
        ? await adapter.start()
        : await adapter.resume(record.cli_session_id);
    trackedSessionId = attached.session_id;
    await history.bindSession(record.run_id, attached.session_id);
    if (budgetGuard) adapter.nativeBudgetGuard = await budgetGuard.ready();
    await history.commandPhase(commandId, "acknowledged", "session_attached");
    const confirmed = await ledger.confirm(
      record.run_id,
      attached.session_id,
      attached.cli_version,
    );
    if (!adapter.stopped)
      await history.transition(
        record.run_id,
        "waiting-human",
        "cli_session_attached",
      );
    return {
      record: confirmed,
      adapter: trackAdapter(
        adapter,
        history,
        record.run_id,
        exitWrites,
        async (sessionId) => {
          if (sessionId !== confirmed.cli_session_id)
            throw new LedgerError("native_session_changed");
          if (budgetGuard) await budgetGuard.ready();
          return ModelRouting.open(ledger.project).guard(confirmed, adapter);
        },
      ),
      history,
      command_id: commandId,
    };
  } catch (error) {
    try {
      await history.commandPhase(commandId, "unknown");
    } catch {}
    try {
      await history.transition(
        record.run_id,
        "unknown",
        "operation_unconfirmed",
      );
    } catch {}
    try {
      await adapter.stop();
      await exitWrites.flush();
    } catch {
      throw new LedgerError("cleanup_unconfirmed");
    }
    throw error;
  }
}
