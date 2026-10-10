// An append-only control-plane journal. Reading never replays CLI operations.
import fs from "node:fs/promises";
import path from "node:path";
import { randomUUID, createHash } from "node:crypto";
import {
  readProcessIdentity,
  validProcessIdentity,
  matchProcessIdentity,
} from "./process-identity.mjs";
import { diagnoseRun } from "./stall-diagnostics.mjs";

export const runStates = Object.freeze([
  "queued",
  "starting",
  "running",
  "waiting-human",
  "waiting-resource",
  "disconnected",
  "stopping",
  "succeeded",
  "failed",
  "unknown",
]);
const transitions = {
  queued: ["starting", "waiting-resource", "unknown", "failed"],
  starting: [
    "running",
    "waiting-human",
    "stopping",
    "disconnected",
    "unknown",
    "failed",
  ],
  running: [
    "waiting-human",
    "waiting-resource",
    "stopping",
    "disconnected",
    "unknown",
    "succeeded",
    "failed",
  ],
  "waiting-human": [
    "starting",
    "running",
    "waiting-resource",
    "stopping",
    "disconnected",
    "unknown",
    "succeeded",
    "failed",
  ],
  "waiting-resource": [
    "queued",
    "starting",
    "running",
    "waiting-human",
    "stopping",
    "disconnected",
    "unknown",
    "failed",
  ],
  disconnected: ["starting", "unknown"],
  stopping: ["disconnected", "unknown", "failed"],
  unknown: [
    "starting",
    "running",
    "waiting-human",
    "stopping",
    "disconnected",
    "failed",
  ],
  succeeded: [],
  failed: [],
};
const reasons = [
  "registered",
  "request_recorded",
  "cli_session_attached",
  "cli_prompt_pending",
  "cli_prompt_result",
  "owned_stop_requested",
  "owned_exit_confirmed",
  "operation_unconfirmed",
  "external_wait",
  "completion_verified",
  "failure_confirmed",
];
const operations = ["start", "resume", "send", "interrupt", "stop"];
const activityKinds = new Set([
  "agent_message",
  "tool_call",
  "tool_update",
  "usage",
  "plan",
  "mode",
  "other",
]);
const outcomes = [
  null,
  "session_attached",
  "prompt_result_received",
  "prompt_refused",
  "prompt_limit_reached",
  "cancelled_result",
  "process_exit_confirmed",
];
const phases = [
  "recorded",
  "dispatched",
  "notification_sent",
  "acknowledged",
  "unknown",
];
const phaseNext = {
  recorded: ["dispatched", "unknown"],
  dispatched: ["notification_sent", "acknowledged", "unknown"],
  notification_sent: ["acknowledged", "unknown"],
  acknowledged: [],
  unknown: [],
};
const maxBytes = 16 * 1024 * 1024,
  maxEvents = 20000;
const zero = "0".repeat(64);
const object = (value) =>
  value !== null && typeof value === "object" && !Array.isArray(value);
const exact = (value, keys) =>
  object(value) &&
  Object.keys(value).length === keys.length &&
  keys.every((key) => Object.hasOwn(value, key));
const time = (value) =>
  typeof value === "string" &&
  value.length <= 30 &&
  Number.isFinite(Date.parse(value));
const uuid = (value, prefix) =>
  typeof value === "string" &&
  new RegExp(
    "^" +
      prefix +
      "_[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$",
  ).test(value);
const nativeId = (value) =>
  value === null ||
  (typeof value === "string" && /^[a-zA-Z0-9._:/-]{1,256}$/.test(value));
const hash = (value) =>
  createHash("sha256").update(JSON.stringify(value)).digest("hex");
const terminal = (state) => state === "succeeded" || state === "failed";
export class HistoryError extends Error {
  constructor(code, eventId = null) {
    super("Run history: " + code);
    this.code = code;
    this.event_id = eventId;
  }
}
function check(condition, code = "invalid_history") {
  if (!condition) throw new HistoryError(code);
}
function observationRecord(record) {
  return (
    exact(record, ["run_id", "last_activity", "resource_observation"]) &&
    uuid(record.run_id, "run") &&
    (record.last_activity === null ||
      (exact(record.last_activity, ["kind", "observed_at"]) &&
        activityKinds.has(record.last_activity.kind) &&
        time(record.last_activity.observed_at))) &&
    (record.resource_observation === null ||
      (exact(record.resource_observation, [
        "kind",
        "status",
        "observed_at",
      ]) &&
        ["cpu", "memory", "gpu", "port", "unknown"].includes(
          record.resource_observation.kind,
        ) &&
        ["waiting", "available"].includes(
          record.resource_observation.status,
        ) &&
        time(record.resource_observation.observed_at)))
  );
}
async function readObservationFile(file, projectId) {
  let handle;
  try {
    handle = await fs.open(file, "r");
    check((await handle.stat()).size <= maxBytes, "observations_too_large");
    const bytes = await handle.readFile();
    check(bytes.length <= maxBytes, "observations_too_large");
    const decoded = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    const value = JSON.parse(decoded);
    check(
      exact(value, ["schema", "project_id", "records"]) &&
        value.schema === 1 &&
        value.project_id === projectId &&
        Array.isArray(value.records) &&
        value.records.length <= maxEvents &&
        value.records.every(observationRecord) &&
        new Set(value.records.map((record) => record.run_id)).size ===
          value.records.length,
      "invalid_observations",
    );
    return new Map(value.records.map((record) => [record.run_id, record]));
  } catch (error) {
    if (error.code === "ENOENT") return new Map();
    if (error instanceof HistoryError) throw error;
    throw new HistoryError("invalid_observations");
  } finally {
    await handle?.close();
  }
}
async function writeObservationFile(file, projectId, records) {
  const value = {
    schema: 1,
    project_id: projectId,
    records: [...records.values()],
  };
  check(
    value.records.length <= maxEvents && value.records.every(observationRecord),
    "invalid_observations",
  );
  const bytes = Buffer.from(JSON.stringify(value) + "\n");
  check(bytes.length <= maxBytes, "observations_too_large");
  const temporary = file + "." + randomUUID() + ".tmp";
  let output;
  try {
    output = await fs.open(temporary, "wx", 0o600);
    await output.writeFile(bytes);
    await output.sync();
    await output.close();
    output = null;
    await fs.rename(temporary, file);
    if (process.platform !== "win32") {
      const parent = await fs.open(path.dirname(file), "r");
      try {
        await parent.sync();
      } finally {
        await parent.close();
      }
    }
  } catch (error) {
    if (error instanceof HistoryError) throw error;
    throw new HistoryError("observations_write_unconfirmed");
  } finally {
    await output?.close();
    await fs.unlink(temporary).catch((error) => {
      if (error.code !== "ENOENT") throw error;
    });
  }
}
function validateData(type, data) {
  if (type === "registered")
    check(
      exact(data, ["native_session_id"]) && nativeId(data.native_session_id),
    );
  else if (type === "session_bound")
    check(
      exact(data, ["native_session_id"]) &&
        data.native_session_id !== null &&
        nativeId(data.native_session_id),
    );
  else if (type === "transition" || type === "transition_rejected")
    check(
      exact(data, ["from", "to", "reason"]) &&
        runStates.includes(data.from) &&
        runStates.includes(data.to) &&
        (type === "transition_rejected"
          ? data.reason === "invalid_transition"
          : reasons.includes(data.reason)),
    );
  else if (type === "process_bound")
    check(
      exact(data, ["identity", "pid", "owner_id"]) &&
        Number.isSafeInteger(data.pid) &&
        data.pid > 0 &&
        data.pid <= 2147483647 &&
        (data.identity === null ||
          (validProcessIdentity(data.identity) &&
            data.identity.pid === data.pid)) &&
        uuid(data.owner_id, "owner"),
    );
  else if (type === "process_exit")
    check(exact(data, ["owner_id"]) && uuid(data.owner_id, "owner"));
  else if (type === "scope_intent")
    check(exact(data, ["owner_id"]) && uuid(data.owner_id, "owner"));
  else if (type === "scope_bound")
    check(
      exact(data, [
        "owner_id",
        "kind",
        "kernel_id",
        "root_identity",
        "root_pid",
      ]) &&
        uuid(data.owner_id, "owner") &&
        ["linux_cgroup_v2", "windows_job"].includes(data.kind) &&
        typeof data.kernel_id === "string" &&
        /^[a-z0-9_-]{1,80}$/.test(data.kernel_id) &&
        Number.isSafeInteger(data.root_pid) &&
        data.root_pid > 0 &&
        data.root_pid <= 2147483647 &&
        (data.root_identity === null ||
          (validProcessIdentity(data.root_identity) &&
            data.root_identity.pid === data.root_pid)),
    );
  else if (type === "stop_stage")
    check(
      exact(data, [
        "owner_id",
        "stage",
        "phase",
        "status",
        "reason",
        "deadline_ms",
        "observed_at",
        "remaining_pids",
        "remaining_count",
      ]) &&
        uuid(data.owner_id, "owner") &&
        [
          "input_interrupt",
          "graceful",
          "termination",
          "kill",
          "verification",
        ].includes(data.stage) &&
        ["request", "result"].includes(data.phase) &&
        [
          "requested",
          "unsupported",
          "running",
          "exit_confirmed",
          "unverifiable",
        ].includes(data.status) &&
        (data.reason === null ||
          (typeof data.reason === "string" &&
            /^[a-z_]{1,100}$/.test(data.reason))) &&
        (data.deadline_ms === null ||
          (Number.isInteger(data.deadline_ms) &&
            data.deadline_ms >= 50 &&
            data.deadline_ms <= 600000)) &&
        time(data.observed_at) &&
        Array.isArray(data.remaining_pids) &&
        data.remaining_pids.length <= 256 &&
        data.remaining_pids.every(
          (p) => Number.isSafeInteger(p) && p > 0 && p <= 2147483647,
        ) &&
        (data.remaining_count === null ||
          (Number.isSafeInteger(data.remaining_count) &&
            data.remaining_count >= data.remaining_pids.length)) &&
        (data.status !== "exit_confirmed" ||
          (data.stage === "verification" &&
            data.phase === "result" &&
            data.remaining_count === 0 &&
            data.remaining_pids.length === 0)),
    );
  else if (type === "process_absent")
    check(
      exact(data, ["identity", "observation"]) &&
        validProcessIdentity(data.identity) &&
        ["gone", "pid_reused"].includes(data.observation),
    );
  else if (type === "command")
    check(
      (exact(data, ["command_id", "operation", "phase", "ack_id", "outcome"]) ||
        (exact(data, [
          "command_id",
          "operation",
          "phase",
          "ack_id",
          "outcome",
          "input_hash",
        ]) &&
          data.operation === "send" &&
          typeof data.input_hash === "string" &&
          /^[0-9a-f]{64}$/.test(data.input_hash))) &&
        uuid(data.command_id, "cmd") &&
        operations.includes(data.operation) &&
        phases.includes(data.phase) &&
        outcomes.includes(data.outcome) &&
        (data.phase === "acknowledged"
          ? uuid(data.ack_id, "ack") && data.outcome !== null
          : data.ack_id === null && data.outcome === null),
    );
  else throw new HistoryError("invalid_history");
}
function apply(state, event) {
  const { type, data, run_id: id } = event;
  let run = state.runs.get(id);
  if (type === "registered") {
    check(!run);
    run = {
      run_id: id,
      native_session_id: data.native_session_id,
      state: "queued",
      updated_at: event.observed_at,
      last_observed_at: event.observed_at,
      reason: "registered",
      process: null,
      scope: null,
      commands: [],
      rejected_transitions: [],
      revision: event.sequence,
    };
    state.runs.set(id, run);
  } else {
    check(run);
    if (type === "transition" || type === "transition_rejected") {
      check(run.state === data.from);
      const valid = transitions[data.from].includes(data.to);
      check(type === "transition" ? valid : !valid && data.to !== data.from);
      if (valid) {
        run.state = data.to;
        run.reason = data.reason;
        run.last_observed_at = event.observed_at;
      } else
        run.rejected_transitions.push({
          event_id: event.event_id,
          ...data,
          observed_at: event.observed_at,
        });
    } else if (type === "session_bound") {
      check(
        run.native_session_id === null ||
          run.native_session_id === data.native_session_id,
      );
      run.native_session_id = data.native_session_id;
    } else if (type === "scope_intent") {
      check(!run.scope || run.scope.status === "exit_confirmed");
      run.scope = {
        owner_id: data.owner_id,
        status: "unverifiable",
        descriptor: null,
        stages: [],
      };
    } else if (type === "scope_bound") {
      check(
        run.scope?.owner_id === data.owner_id && run.scope.descriptor === null,
      );
      run.scope.descriptor = structuredClone(data);
      run.scope.status = "running";
    } else if (type === "stop_stage") {
      check(run.scope?.owner_id === data.owner_id);
      run.scope.stages.push(structuredClone(data));
      run.scope.last_observed_at = data.observed_at;
      run.scope.status =
        data.stage === "verification" ? data.status : "stopping";
      if (data.stage === "verification") {
        run.scope.remaining_pids = [...data.remaining_pids];
        run.scope.remaining_count = data.remaining_count;
      }
    } else if (type === "process_bound") {
      check(
        !run.process ||
          ["exit_confirmed", "absence_observed"].includes(run.process.status),
      );
      run.process = {
        ...data,
        status: "last_observed_alive",
        observed_at: event.observed_at,
      };
    } else if (type === "process_exit") {
      check(run.process?.owner_id === data.owner_id);
      run.process.status = "exit_confirmed";
      run.process.observed_at = event.observed_at;
    } else if (type === "process_absent") {
      check(
        run.process &&
          JSON.stringify(run.process.identity) ===
            JSON.stringify(data.identity),
      );
      run.process.status = "absence_observed";
      run.process.observed_at = event.observed_at;
    } else if (type === "command") {
      const existing = state.commands.get(data.command_id);
      if (!existing) {
        check(data.phase === "recorded");
        const command = {
          ...data,
          run_id: id,
          recorded_at: event.observed_at,
          updated_at: event.observed_at,
        };
        run.commands.push(command);
        state.commands.set(data.command_id, command);
      } else {
        check(
          existing.run_id === id &&
            existing.operation === data.operation &&
            (data.input_hash === undefined ||
              data.input_hash === existing.input_hash) &&
            phaseNext[existing.phase].includes(data.phase),
        );
        Object.assign(existing, data, { updated_at: event.observed_at });
      }
      if (data.ack_id !== null) {
        check(!state.acks.has(data.ack_id));
        state.acks.add(data.ack_id);
      }
    }
    run.revision = event.sequence;
    run.updated_at = event.observed_at;
  }
}
function empty() {
  return {
    runs: new Map(),
    commands: new Map(),
    acks: new Set(),
    events: [],
    tail_bytes: 0,
    committed_bytes: 0,
  };
}
function parse(buffer, project) {
  const state = empty();
  const end = buffer.lastIndexOf(10) + 1;
  state.tail_bytes = buffer.length - end;
  state.committed_bytes = end;
  let previous = zero;
  for (const raw of buffer
    .subarray(0, end)
    .toString("utf8")
    .split("\n")
    .slice(0, -1)) {
    check(Buffer.byteLength(raw) <= 16384 && state.events.length < maxEvents);
    let event;
    try {
      event = JSON.parse(raw);
    } catch {
      throw new HistoryError("invalid_history");
    }
    check(
      exact(event, [
        "schema",
        "project_id",
        "sequence",
        "event_id",
        "run_id",
        "observed_at",
        "type",
        "data",
        "previous_hash",
        "hash",
      ]),
    );
    check(
      event.schema === 1 &&
        event.project_id === project.id &&
        uuid(event.run_id, "run") &&
        uuid(event.event_id, "evt") &&
        time(event.observed_at) &&
        event.sequence === state.events.length + 1 &&
        event.previous_hash === previous,
    );
    const { hash: checksum, ...body } = event;
    check(checksum === hash(body));
    validateData(event.type, event.data);
    apply(state, event);
    state.events.push(event);
    previous = checksum;
  }
  return state;
}
export class RunHistory {
  constructor(project) {
    this.project = { ...project };
    this.file = path.join(project.directory, "run-history.jsonl");
    this.observationsFile = path.join(
      project.directory,
      "run-observations.json",
    );
    this.lock = path.join(project.directory, "run-history.lock");
    this.owner_id = "owner_" + randomUUID();
    this.queue = Promise.resolve();
  }
  static async open(project) {
    check(
      object(project) &&
        typeof project.id === "string" &&
        /^[a-zA-Z0-9_-]{1,160}$/.test(project.id) &&
        typeof project.directory === "string" &&
        path.isAbsolute(project.directory),
      "invalid_project",
    );
    const history = new RunHistory(project);
    await history.read();
    return history;
  }
  async read() {
    let handle;
    try {
      handle = await fs.open(this.file, "r");
      check((await handle.stat()).size <= maxBytes, "history_too_large");
      const bytes = await handle.readFile();
      check(bytes.length <= maxBytes, "history_too_large");
      // Fatal decoding prevents replacement characters from legitimizing corruption.
      new TextDecoder("utf-8", { fatal: true }).decode(
        bytes.subarray(0, bytes.lastIndexOf(10) + 1),
      );
      return parse(bytes, this.project);
    } catch (error) {
      if (error.code === "ENOENT") return empty();
      if (error instanceof HistoryError) throw error;
      throw new HistoryError("invalid_history");
    } finally {
      await handle?.close();
    }
  }
  async observationSnapshot() {
    try {
      return {
        records: await readObservationFile(
          this.observationsFile,
          this.project.id,
        ),
        status: "available",
      };
    } catch {
      return { records: new Map(), status: "unavailable" };
    }
  }
  async mutate(operation) {
    const job = this.queue.then(async () => {
      await fs.mkdir(this.project.directory, { recursive: true });
      let lock;
      try {
        lock = await fs.open(this.lock, "wx", 0o600);
      } catch (error) {
        if (error.code === "EEXIST") throw new HistoryError("history_busy");
        throw new HistoryError("history_write_failed");
      }
      let output;
      try {
        this.writerIdentity ||= readProcessIdentity(process.pid);
        const owner = await this.writerIdentity;
        await lock.writeFile(
          JSON.stringify({ owner_id: this.owner_id, identity: owner.identity }),
        );
        await lock.sync();
        const state = await this.read();
        check(!state.tail_bytes, "incomplete_tail_requires_repair");
        const added = [];
        const append = (id, type, data) => {
          validateData(type, data);
          check(uuid(id, "run"), "exact_run_id_required");
          const body = {
            schema: 1,
            project_id: this.project.id,
            sequence: state.events.length + 1,
            event_id: "evt_" + randomUUID(),
            run_id: id,
            observed_at: new Date().toISOString(),
            type,
            data,
            previous_hash: state.events.at(-1)?.hash || zero,
          };
          const event = { ...body, hash: hash(body) };
          apply(state, event);
          state.events.push(event);
          added.push(JSON.stringify(event) + "\n");
          return event;
        };
        const recordObservation = async (id, field, data) => {
          check(state.runs.has(id), "run_not_found");
          const records = await readObservationFile(
            this.observationsFile,
            this.project.id,
          );
          const current = records.get(id) || {
            run_id: id,
            last_activity: null,
            resource_observation: null,
          };
          records.set(id, {
            ...current,
            [field]: { ...data, observed_at: new Date().toISOString() },
          });
          await writeObservationFile(
            this.observationsFile,
            this.project.id,
            records,
          );
        };
        output = await operation(state, append, recordObservation);
        if (added.length) {
          const bytes = Buffer.from(added.join(""));
          check(
            state.committed_bytes + bytes.length <= maxBytes &&
              state.events.length <= maxEvents,
            "history_full",
          );
          const journal = await fs.open(this.file, "a", 0o600);
          try {
            let written = 0;
            while (written < bytes.length) {
              const result = await journal.write(bytes.subarray(written));
              check(result.bytesWritten > 0, "history_write_failed");
              written += result.bytesWritten;
            }
            await journal.sync();
          } finally {
            await journal.close();
          }
        }
      } catch (error) {
        if (error instanceof HistoryError) throw error;
        throw new HistoryError("history_write_failed");
      } finally {
        try {
          await lock.close();
          await fs.unlink(this.lock);
        } catch {
          throw new HistoryError("history_lock_cleanup_unconfirmed");
        }
      }
      if (output?.rejected)
        throw new HistoryError("invalid_transition", output.rejected);
      return output;
    });
    this.queue = job.catch(() => {});
    return job;
  }
  async register(id, native_session_id = null) {
    check(
      uuid(id, "run") && nativeId(native_session_id),
      "invalid_registration",
    );
    return this.mutate((state, append) => {
      if (state.runs.has(id)) {
        const existing = state.runs.get(id);
        check(
          existing.native_session_id === null ||
            native_session_id === null ||
            existing.native_session_id === native_session_id,
          "session_binding_immutable",
        );
        return structuredClone(existing);
      }
      append(id, "registered", { native_session_id });
      return structuredClone(state.runs.get(id));
    });
  }
  async transition(id, to, reason) {
    check(
      runStates.includes(to) && reasons.includes(reason),
      "invalid_transition_input",
    );
    return this.mutate((state, append) => {
      const run = state.runs.get(id);
      check(run, "run_not_found");
      if (run.state === to) return structuredClone(run);
      if (!transitions[run.state].includes(to))
        return {
          rejected: append(id, "transition_rejected", {
            from: run.state,
            to,
            reason: "invalid_transition",
          }).event_id,
        };
      append(id, "transition", { from: run.state, to, reason });
      return structuredClone(run);
    });
  }
  async bindProcess(id, identity, pid = identity?.pid) {
    check(
      identity === null || validProcessIdentity(identity),
      "process_identity_unavailable",
    );
    return this.mutate((state, append) => {
      append(id, "process_bound", { identity, pid, owner_id: this.owner_id });
    });
  }
  async scopeIntent(id) {
    return this.mutate((state, append) => {
      append(id, "scope_intent", { owner_id: this.owner_id });
    });
  }
  async bindScope(id, descriptor) {
    return this.mutate((state, append) => {
      append(id, "scope_bound", descriptor);
    });
  }
  async stopStage(id, stage) {
    return this.mutate((state, append) => {
      append(id, "stop_stage", stage);
      const run = state.runs.get(id);
      if (
        stage.stage === "verification" &&
        stage.status === "exit_confirmed" &&
        !terminal(run.state) &&
        run.state !== "disconnected"
      )
        append(id, "transition", {
          from: run.state,
          to: "disconnected",
          reason: "owned_exit_confirmed",
        });
    });
  }
  async bindSession(id, native_session_id) {
    check(
      native_session_id !== null && nativeId(native_session_id),
      "invalid_session_id",
    );
    return this.mutate((state, append) => {
      append(id, "session_bound", { native_session_id });
    });
  }
  async confirmAbsent(id) {
    const run = (await this.read()).runs.get(id);
    check(
      validProcessIdentity(run?.process?.identity),
      "process_identity_unavailable",
    );
    const observation = matchProcessIdentity(
      run.process.identity,
      await readProcessIdentity(run.process.identity.pid),
    );
    check(
      ["gone", "pid_reused"].includes(observation),
      "run_process_unconfirmed",
    );
    return this.mutate((state, append) => {
      append(id, "process_absent", {
        identity: run.process.identity,
        observation,
      });
      const current = state.runs.get(id);
      if (!terminal(current.state) && current.state !== "disconnected")
        append(id, "transition", {
          from: current.state,
          to: "disconnected",
          reason: "owned_exit_confirmed",
        });
    });
  }
  async processExited(id) {
    return this.mutate((state, append) => {
      const run = state.runs.get(id);
      check(run?.process?.owner_id === this.owner_id, "process_owner_mismatch");
      if (run.process.status !== "exit_confirmed")
        append(id, "process_exit", { owner_id: this.owner_id });
      if (
        (!run.scope || run.scope.status === "exit_confirmed") &&
        !terminal(run.state) &&
        run.state !== "disconnected"
      )
        append(id, "transition", {
          from: run.state,
          to: "disconnected",
          reason: "owned_exit_confirmed",
        });
    });
  }
  async recordCommand(
    id,
    operation,
    command_id = "cmd_" + randomUUID(),
    input_hash = null,
  ) {
    check(
      operations.includes(operation) && uuid(command_id, "cmd"),
      "invalid_command",
    );
    return this.mutate((state, append) => {
      check(!state.commands.has(command_id), "duplicate_command");
      append(id, "command", {
        command_id,
        operation,
        phase: "recorded",
        ack_id: null,
        outcome: null,
        ...(input_hash === null ? {} : { input_hash }),
      });
      return command_id;
    });
  }
  async recordActivity(id, kind) {
    check(activityKinds.has(kind), "invalid_activity_kind");
    return this.mutate((_state, _append, recordObservation) => {
      return recordObservation(id, "last_activity", { kind });
    });
  }
  async recordResourceObservation(id, kind, status) {
    check(
      ["cpu", "memory", "gpu", "port", "unknown"].includes(kind) &&
        ["waiting", "available"].includes(status),
      "invalid_resource_observation",
    );
    return this.mutate((_state, _append, recordObservation) => {
      return recordObservation(id, "resource_observation", { kind, status });
    });
  }
  async commandPhase(command_id, phase, outcome = null) {
    check(
      phases.includes(phase) &&
        phase !== "recorded" &&
        outcomes.includes(outcome),
      "invalid_command_phase",
    );
    return this.mutate((state, append) => {
      const command = state.commands.get(command_id);
      check(command, "command_not_found");
      append(command.run_id, "command", {
        command_id,
        operation: command.operation,
        phase,
        ack_id: phase === "acknowledged" ? "ack_" + randomUUID() : null,
        outcome,
      });
    });
  }
  async inspect(
    id,
    { ui_connection = "unknown", observe = readProcessIdentity } = {},
  ) {
    check(
      ["unknown", "connected", "disconnected"].includes(ui_connection),
      "invalid_ui_connection",
    );
    const loaded = await this.read();
    const run = loaded.runs.get(id);
    check(run, "run_not_found");
    const observations = await this.observationSnapshot();
    return this.inspectRecord(run, loaded, ui_connection, observe, observations);
  }
  async inspectRecord(
    run,
    loaded,
    ui_connection,
    observe,
    observations = { records: new Map(), status: "available" },
  ) {
    let status = ["exit_confirmed", "absence_observed"].includes(
      run.process?.status,
    )
      ? run.process.status
      : "unknown";
    if (
      run.process &&
      !["exit_confirmed", "absence_observed"].includes(status)
    ) {
      try {
        status = matchProcessIdentity(
          run.process.identity,
          await observe(run.process.pid),
        );
      } catch {
        status = "unknown";
      }
    }
    const knownExit = [
      "exit_confirmed",
      "absence_observed",
      "gone",
      "pid_reused",
    ].includes(status);
    let state = terminal(run.state)
      ? run.state
      : knownExit
        ? "disconnected"
        : run.process ||
            ["starting", "running", "waiting-human", "stopping"].includes(
              run.state,
            )
          ? "unknown"
          : run.state;
    if (loaded.tail_bytes && !terminal(state)) state = "unknown";
    const lock = await this.lockObservation();
    const observed = observations.records.get(run.run_id) || null;
    const diagnosticRun = observed ? { ...run, ...observed } : run;
    return {
      ...structuredClone(run),
      last_activity: observed?.last_activity ?? null,
      resource_observation: observed?.resource_observation ?? null,
      observation_store_status: observations.status,
      scope_observation: run.scope
        ? {
            status:
              run.scope.status === "exit_confirmed"
                ? "exit_confirmed"
                : "unverifiable",
            last_observed_at: run.scope.last_observed_at ?? null,
            kernel_handles_reconstructed: false,
            stop_authority: false,
            reason:
              run.scope.status === "exit_confirmed"
                ? "recorded_kernel_group_empty"
                : "live_owner_required",
          }
        : null,
      recorded_state: run.state,
      state,
      state_basis: terminal(run.state)
        ? "recorded_terminal_result"
        : knownExit
          ? "process_exit_observed; native_session_can_still_exist"
          : status === "alive"
            ? "process_alive; native_run_state_unobservable"
            : state === "unknown"
              ? "run_state_unverified"
              : "recorded_control_state",
      observed_at: new Date().toISOString(),
      ui_connection,
      process_observation: {
        status,
        pid: run.process?.pid ?? null,
        scope: "owned_root_process_only; descendants_unverified",
      },
      stall_diagnosis: diagnoseRun({
        run: diagnosticRun,
        processObservation: { status, observed_at: new Date().toISOString() },
        uiConnection: ui_connection,
      }),
      commands: run.commands.slice(-100).map((command) => ({
        ...structuredClone(command),
        recovery_outcome:
          command.phase === "acknowledged"
            ? "acknowledged"
            : command.phase === "recorded"
              ? "not_dispatched"
              : "unknown",
      })),
      commands_total: run.commands.length,
      rejected_transitions: structuredClone(
        run.rejected_transitions.slice(-20),
      ),
      recovery: {
        mode: "read_only",
        replayed_commands: 0,
        automatically_restarted: false,
        incomplete_tail_bytes: loaded.tail_bytes,
        repair_required:
          loaded.tail_bytes > 0 ||
          (lock.present && lock.owner_process !== "alive"),
        writer_lock: lock,
      },
    };
  }
  async lockObservation() {
    let handle;
    try {
      handle = await fs.open(this.lock, "r");
      check((await handle.stat()).size <= 4096);
      const owner = JSON.parse(await handle.readFile("utf8"));
      check(
        exact(owner, ["owner_id", "identity"]) && uuid(owner.owner_id, "owner"),
      );
      const status = validProcessIdentity(owner.identity)
        ? matchProcessIdentity(
            owner.identity,
            await readProcessIdentity(owner.identity.pid),
          )
        : "unknown";
      return {
        present: true,
        owner_id: owner.owner_id,
        owner_process: status,
        automatic_removal: false,
      };
    } catch (error) {
      if (error.code === "ENOENT")
        return { present: false, automatic_removal: false };
      return {
        present: true,
        owner_id: null,
        owner_process: "unknown",
        automatic_removal: false,
      };
    } finally {
      await handle?.close();
    }
  }
  async list({ after = 0, limit = 10 } = {}) {
    check(
      Number.isSafeInteger(after) &&
        after >= 0 &&
        Number.isSafeInteger(limit) &&
        limit >= 1 &&
        limit <= 20,
      "invalid_cursor",
    );
    const loaded = await this.read(),
      observations = await this.observationSnapshot(),
      runs = [];
    const records = [...loaded.runs.values()];
    for (const run of records.slice(after, after + limit))
      runs.push(
        await this.inspectRecord(
          run,
          loaded,
          "unknown",
          readProcessIdentity,
          observations,
        ),
      );
    return {
      schema: 1,
      project_id: this.project.id,
      revision: loaded.events.length,
      runs,
      next_cursor:
        after + runs.length < records.length ? after + runs.length : null,
      recovery_required: loaded.tail_bytes > 0,
    };
  }
  async diagnoseRecent({ limit = 5, uiConnection = "unknown" } = {}) {
    check(
      Number.isSafeInteger(limit) && limit >= 1 && limit <= 20,
      "invalid_limit",
    );
    check(
      ["unknown", "connected", "disconnected"].includes(uiConnection),
      "invalid_ui_connection",
    );
    const loaded = await this.read();
    const observations = await this.observationSnapshot();
    const records = [...loaded.runs.values()].slice(-limit).reverse();
    const observed_at = new Date().toISOString();
    const runs = await Promise.all(
      records.map(async (run) => {
        let status = ["exit_confirmed", "absence_observed"].includes(
          run.process?.status,
        )
          ? run.process.status
          : "unknown";
        if (
          run.process &&
          validProcessIdentity(run.process.identity) &&
          !terminal(run.state) &&
          !["exit_confirmed", "absence_observed"].includes(status)
        ) {
          try {
            status = matchProcessIdentity(
              run.process.identity,
              await readProcessIdentity(run.process.pid),
            );
          } catch {
            status = "unknown";
          }
        }
        const knownExit = [
          "exit_confirmed",
          "absence_observed",
          "gone",
          "pid_reused",
        ].includes(status);
        let state = run.state;
        if (!terminal(run.state)) {
          if (knownExit) state = "disconnected";
          else if (
            run.process ||
            ["starting", "running", "waiting-human", "stopping"].includes(
              run.state,
            )
          )
            state = "unknown";
        }
        if (loaded.tail_bytes && !terminal(state)) state = "unknown";
        const observation = observations.records.get(run.run_id);
        return {
          run_id: run.run_id,
          recorded_state: run.state,
          state,
          updated_at: run.updated_at,
          observation_store_status: observations.status,
          stall_diagnosis: diagnoseRun({
            run: observation ? { ...run, ...observation } : run,
            processObservation: { status, observed_at },
            uiConnection,
            now: observed_at,
          }),
        };
      }),
    );
    return {
      schema: 1,
      observed_at,
      observation_store_status: observations.status,
      runs,
      recovery_required: loaded.tail_bytes > 0,
    };
  }
  async events(id, { after = 0, limit = 100 } = {}) {
    check(
      Number.isSafeInteger(after) &&
        after >= 0 &&
        Number.isSafeInteger(limit) &&
        limit >= 1 &&
        limit <= 100,
      "invalid_cursor",
    );
    const state = await this.read();
    check(state.runs.has(id), "run_not_found");
    const matching = state.events.filter(
      (event) => event.run_id === id && event.sequence > after,
    );
    const events = matching.slice(0, limit);
    return {
      events: structuredClone(events),
      next_cursor:
        matching.length > events.length ? events.at(-1).sequence : null,
      incomplete_tail_bytes: state.tail_bytes,
    };
  }
}
