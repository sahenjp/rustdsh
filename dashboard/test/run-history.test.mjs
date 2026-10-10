import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import { spawn, execFile } from "node:child_process";
import { promisify } from "node:util";
import { once } from "node:events";
import { identity } from "../state.mjs";
import { RunHistory, runStates } from "../run-history.mjs";
import {
  readProcessIdentity,
  matchProcessIdentity,
} from "../process-identity.mjs";
import { SessionLedger, attachRecordedSession } from "../session-ledger.mjs";

const exec = promisify(execFile);
const fixture = fileURLToPath(
  new URL("./fixtures/acp-cli.mjs", import.meta.url),
);
const crash = fileURLToPath(
  new URL("./fixtures/run-history-crash.mjs", import.meta.url),
);
const cli = fileURLToPath(new URL("../cli.mjs", import.meta.url));
const error = (code) => (value) => value.code === code;
const runId = () => "run_" + randomUUID();
const fakeIdentity = {
  platform: "linux",
  pid: 42424,
  birth: "1234",
  scope: "a".repeat(64),
};
async function setup(t) {
  const root = await fs.mkdtemp(
    path.join(os.tmpdir(), "rdsh-run-history-test-"),
  );
  const cwd = path.join(root, "project");
  await fs.mkdir(cwd);
  const home = path.join(root, "dashboard");
  const project = await identity(cwd);
  project.directory = path.join(home, "projects", project.id);
  const env = {
    ...Object.fromEntries(
      Object.entries(process.env).filter(([key]) =>
        /^(PATH|PATHEXT|SYSTEMROOT|WINDIR|TEMP|TMP|COMSPEC|LANG|LC_ALL)$/i.test(
          key,
        ),
      ),
    ),
    HOME: root,
    USERPROFILE: root,
    DSH_HOME: path.join(root, "dsh"),
    RDSH_DASHBOARD_HOME: home,
    GIT_CEILING_DIRECTORIES: root,
    RDSH_ADAPTER_FIXTURE_TRACE: path.join(root, "trace.jsonl"),
    PROVIDER_API_KEY: "fixture-key-not-for-history",
  };
  const history = await RunHistory.open(project),
    ledger = await SessionLedger.open(project);
  const adapters = [],
    children = [];
  t.after(async () => {
    for (const adapter of adapters) {
      try {
        await adapter.stop();
      } catch (failure) {
        if (!adapter.stopped) throw failure;
      }
    }
    for (const child of children)
      if (child.exitCode === null && child.signalCode === null) {
        const ended = once(child, "exit");
        child.kill("SIGKILL");
        await ended;
      }
    const resolved = path.resolve(root);
    assert.equal(path.dirname(resolved), path.resolve(os.tmpdir()));
    assert.ok(path.basename(resolved).startsWith("rdsh-run-history-test-"));
    await fs.rm(resolved, { recursive: true });
  });
  return {
    root,
    project,
    env,
    history,
    ledger,
    adapters,
    children,
    command: [process.execPath, fixture],
  };
}
async function ready(history, id) {
  await history.register(id);
  await history.transition(id, "starting", "request_recorded");
  await history.transition(id, "waiting-human", "cli_session_attached");
}
async function crashAt(f, id, point) {
  const child = spawn(
    process.execPath,
    [
      crash,
      JSON.stringify({
        project: f.project,
        counter: path.join(f.root, "counter"),
      }),
      id,
      point,
    ],
    {
      env: f.env,
      windowsHide: true,
      shell: false,
      stdio: ["ignore", "ignore", "pipe", "ipc"],
    },
  );
  f.children.push(child);
  child.stderr.resume();
  const reached = await Promise.race([
    once(child, "message"),
    once(child, "exit").then(() => {
      throw new Error("Crash fixture exited before its checkpoint");
    }),
  ]);
  assert.equal(reached[0].point, point);
  const exited = once(child, "exit");
  child.kill("SIGKILL");
  await exited;
}

test("run FSM persists rejected transitions and separates browser connection from process state", async (t) => {
  const { history, project } = await setup(t);
  const id = runId();
  assert.equal(runStates.length, 10);
  await history.register(id);
  await assert.rejects(
    history.transition(id, "succeeded", "completion_verified"),
    error("invalid_transition"),
  );
  assert.equal((await history.read()).runs.get(id).state, "queued");
  const rejected = (await history.events(id)).events.at(-1);
  assert.equal(rejected.type, "transition_rejected");
  assert.equal(rejected.data.reason, "invalid_transition");
  await ready(history, id);
  await history.bindProcess(id, fakeIdentity);
  const reopened = await RunHistory.open(project);
  const alive = async () => ({ status: "observed", identity: fakeIdentity });
  const connected = await reopened.inspect(id, {
    ui_connection: "connected",
    observe: alive,
  });
  const disconnected = await reopened.inspect(id, {
    ui_connection: "disconnected",
    observe: alive,
  });
  assert.equal(connected.state, "unknown");
  assert.equal(disconnected.state, "unknown");
  assert.equal(disconnected.recorded_state, "waiting-human");
  assert.equal(disconnected.process_observation.status, "alive");
  assert.match(disconnected.state_basis, /native_run_state_unobservable/);
  assert.equal(disconnected.ui_connection, "disconnected");
  assert.equal(
    (await reopened.events(id)).events.length,
    (await history.events(id)).events.length,
  );
});

test("run activity and resource metadata persist without free text", async (t) => {
  const { history, project } = await setup(t);
  const id = runId();
  await ready(history, id);
  await history.transition(id, "waiting-resource", "external_wait");
  await history.recordActivity(id, "agent_message");
  await history.recordResourceObservation(id, "gpu", "waiting");

  const reopened = await RunHistory.open(project);
  const inspected = await reopened.inspect(id);
  assert.equal(inspected.last_activity.kind, "agent_message");
  assert.equal(inspected.resource_observation.kind, "gpu");
  assert.equal(inspected.stall_diagnosis.classification, "resource_wait");
  assert.equal(
    inspected.stall_diagnosis.signals.find(
      (item) => item.name === "resource_wait",
    ).resource_kind,
    "gpu",
  );
  const historyEvents = (await reopened.events(id)).events;
  assert.ok(
    historyEvents.every(
      (event) =>
        !["activity_observed", "resource_observed"].includes(event.type),
    ),
  );
  const observationFile = path.join(
    project.directory,
    "run-observations.json",
  );
  const observations = JSON.parse(await fs.readFile(observationFile, "utf8"));
  assert.equal(observations.schema, 1);
  assert.equal(observations.project_id, project.id);
  assert.equal(observations.records[0].last_activity.kind, "agent_message");
  assert.equal(
    observations.records[0].resource_observation.kind,
    "gpu",
  );
  await assert.rejects(
    history.recordActivity(id, "raw user prompt"),
    error("invalid_activity_kind"),
  );

  await fs.writeFile(observationFile, "{invalid", "utf8");
  const unavailable = await reopened.inspect(id);
  assert.equal(unavailable.observation_store_status, "unavailable");
  assert.equal(unavailable.last_activity, null);
  assert.equal((await reopened.events(id)).events.length, historyEvents.length);
});

test("alive, gone, PID reuse and unavailable process facts have distinct conservative results", async (t) => {
  const { history } = await setup(t),
    id = runId();
  await ready(history, id);
  await history.bindProcess(id, fakeIdentity);
  for (const [observation, status, state] of [
    [{ status: "observed", identity: fakeIdentity }, "alive", "unknown"],
    [
      {
        status: "gone",
        identity: null,
        platform: fakeIdentity.platform,
        scope: fakeIdentity.scope,
      },
      "gone",
      "disconnected",
    ],
    [
      {
        status: "gone",
        identity: null,
        platform: fakeIdentity.platform,
        scope: "b".repeat(64),
      },
      "unknown",
      "unknown",
    ],
    [
      { status: "observed", identity: { ...fakeIdentity, birth: "5678" } },
      "pid_reused",
      "disconnected",
    ],
    [{ status: "unknown", identity: null }, "unknown", "unknown"],
    [
      {
        status: "observed",
        identity: { ...fakeIdentity, scope: "b".repeat(64) },
      },
      "unknown",
      "unknown",
    ],
  ]) {
    const inspected = await history.inspect(id, {
      observe: async () => observation,
    });
    assert.equal(inspected.process_observation.status, status);
    assert.equal(inspected.state, state);
    assert.equal(inspected.recovery.automatically_restarted, false);
  }
  assert.equal(matchProcessIdentity(null, { status: "gone" }), "unknown");
  assert.equal(
    matchProcessIdentity(fakeIdentity, { status: "gone", identity: null }),
    "unknown",
  );
  const unknownId = runId();
  await ready(history, unknownId);
  await history.bindProcess(unknownId, null, 12345);
  const unavailable = await history.inspect(unknownId, {
    observe: async () => ({ status: "gone", identity: null }),
  });
  assert.equal(unavailable.process_observation.status, "unknown");
  assert.equal(unavailable.process_observation.pid, 12345);
  await history.processExited(unknownId);
  assert.equal(
    (await history.inspect(unknownId)).process_observation.status,
    "exit_confirmed",
  );
  assert.equal(
    matchProcessIdentity(fakeIdentity, {
      status: "observed",
      identity: { ...fakeIdentity, pid: 99 },
    }),
    "unknown",
  );
});

test("native OS observation identifies an owned live process and then its exit without signalling other PIDs", async (t) => {
  const { children } = await setup(t);
  const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {
    windowsHide: true,
    stdio: "ignore",
    shell: false,
  });
  children.push(child);
  await once(child, "spawn");
  const before = await readProcessIdentity(child.pid);
  if (["win32", "linux"].includes(process.platform)) {
    assert.equal(before.status, "observed");
    assert.equal(
      matchProcessIdentity(
        before.identity,
        await readProcessIdentity(child.pid),
      ),
      "alive",
    );
  } else assert.equal(before.status, "unknown");
  const ended = once(child, "exit");
  child.kill("SIGKILL");
  await ended;
  if (before.identity)
    assert.equal(
      matchProcessIdentity(
        before.identity,
        await readProcessIdentity(child.pid),
      ),
      "gone",
    );
  assert.equal(
    (await readProcessIdentity("1; fixture-secret")).status,
    "unknown",
  );
});

test("hard exits around intent and ack recover committed events without replaying a fixture side effect", async (t) => {
  for (const point of [
    "before-write",
    "after-write",
    "before-ack",
    "after-ack",
  ]) {
    await t.test(point, async (t) => {
      const f = await setup(t),
        id = runId();
      await ready(f.history, id);
      await crashAt(f, id, point);
      const saved = await fs.readFile(f.history.file);
      const counter = await fs
        .readFile(path.join(f.root, "counter"), "utf8")
        .catch(() => "");
      const expectedEffects = ["before-ack", "after-ack"].includes(point)
        ? 1
        : 0;
      assert.equal(counter.split("\n").filter(Boolean).length, expectedEffects);
      let inspected;
      for (let attempt = 0; attempt < 2; attempt++) {
        const output = await exec(
          process.execPath,
          [
            cli,
            "run-history",
            "inspect",
            "--project",
            f.project.root,
            "--run-id",
            id,
          ],
          { env: f.env, windowsHide: true, maxBuffer: 256 * 1024 },
        );
        inspected = JSON.parse(output.stdout);
        assert.equal(inspected.recovery.replayed_commands, 0);
        assert.equal(inspected.recovery.automatically_restarted, false);
      }
      const commands = inspected.commands;
      if (point === "before-write") assert.equal(commands.length, 0);
      else {
        assert.equal(commands.length, 1);
        assert.equal(
          commands[0].recovery_outcome,
          point === "after-ack"
            ? "acknowledged"
            : point === "after-write"
              ? "not_dispatched"
              : "unknown",
        );
        assert.equal(commands[0].ack_id !== null, point === "after-ack");
      }
      assert.deepEqual(await fs.readFile(f.history.file), saved);
      assert.equal(
        await fs.readFile(path.join(f.root, "counter"), "utf8").catch(() => ""),
        counter,
      );
    });
  }
});

test("a torn final frame retains the committed prefix, exposes uncertainty and refuses to overwrite it", async (t) => {
  const f = await setup(t),
    id = runId();
  await ready(f.history, id);
  const before = await fs.readFile(f.history.file);
  await crashAt(f, id, "torn-tail");
  const torn = await fs.readFile(f.history.file);
  const reopened = await RunHistory.open(f.project),
    inspected = await reopened.inspect(id);
  assert.equal(inspected.state, "unknown");
  assert.equal((await reopened.events(id)).events.length, 3);
  assert.equal(
    inspected.recovery.incomplete_tail_bytes,
    torn.length - before.length,
  );
  assert.equal(inspected.recovery.repair_required, true);
  await assert.rejects(
    reopened.transition(id, "running", "cli_prompt_pending"),
    error("incomplete_tail_requires_repair"),
  );
  assert.deepEqual(await fs.readFile(f.history.file), torn);
});

test("a dead writer lock permits read-only restoration but is never silently stolen", async (t) => {
  const f = await setup(t),
    id = runId();
  await ready(f.history, id);
  await crashAt(f, id, "stale-lock");
  const original = await fs.readFile(f.history.lock);
  const inspected = await (await RunHistory.open(f.project)).inspect(id);
  assert.equal(inspected.recovery.writer_lock.present, true);
  assert.equal(inspected.recovery.writer_lock.automatic_removal, false);
  if (["win32", "linux"].includes(process.platform))
    // A bounded native observation may time out on a busy Windows runner.
    // Uncertainty must still preserve the lock and block writes.
    assert.ok(
      ["gone", "pid_reused", "unknown"].includes(
        inspected.recovery.writer_lock.owner_process,
      ),
    );
  await assert.rejects(
    f.history.transition(id, "running", "cli_prompt_pending"),
    error("history_busy"),
  );
  assert.deepEqual(await fs.readFile(f.history.lock), original);
  const unavailableOwner = JSON.stringify({
    owner_id: JSON.parse(original).owner_id,
    identity: null,
  });
  await fs.writeFile(f.history.lock, unavailableOwner);
  const unavailable = await (await RunHistory.open(f.project)).inspect(id);
  assert.equal(unavailable.recovery.writer_lock.owner_process, "unknown");
  assert.equal(unavailable.recovery.writer_lock.automatic_removal, false);
  await assert.rejects(
    f.history.transition(id, "running", "cli_prompt_pending"),
    error("history_busy"),
  );
  assert.equal(await fs.readFile(f.history.lock, "utf8"), unavailableOwner);
});

test("corrupt, foreign-project and unknown-schema histories are preserved and rejected", async (t) => {
  const { history, project } = await setup(t),
    id = runId();
  await history.register(id);
  const original = await fs.readFile(history.file, "utf8");
  for (const modify of [
    (value) => {
      value.schema = 99;
    },
    (value) => {
      value.project_id = "foreign";
    },
    (value) => {
      value.hash = "f".repeat(64);
    },
    (value) => {
      value.data = { env: "fixture-secret-never-print" };
    },
  ]) {
    const value = JSON.parse(original);
    modify(value);
    const bad = JSON.stringify(value) + "\n";
    await fs.writeFile(history.file, bad);
    await assert.rejects(
      RunHistory.open(project),
      (failure) =>
        failure.code === "invalid_history" &&
        !failure.message.includes("fixture-secret"),
    );
    assert.equal(await fs.readFile(history.file, "utf8"), bad);
  }
});

test("command IDs are unique, simultaneous local writes serialize and no prompt or credential is stored", async (t) => {
  const { history, project } = await setup(t),
    id = runId();
  await history.register(id);
  const ids = await Promise.all(
    Array.from({ length: 5 }, () => history.recordCommand(id, "send")),
  );
  assert.equal(new Set(ids).size, 5);
  const secondId = runId();
  await history.register(secondId);
  const firstPage = await history.list({ limit: 1 });
  assert.equal(firstPage.runs[0].run_id, id);
  assert.equal(firstPage.next_cursor, 1);
  const secondPage = await history.list({
    after: firstPage.next_cursor,
    limit: 1,
  });
  assert.equal(secondPage.runs[0].run_id, secondId);
  assert.equal(secondPage.next_cursor, null);
  const eventPage = await history.events(id, { limit: 2 });
  assert.deepEqual(
    eventPage.events.map((event) => event.sequence),
    [1, 2],
  );
  assert.equal(eventPage.next_cursor, 2);
  assert.deepEqual(
    (
      await history.events(id, { after: eventPage.next_cursor, limit: 2 })
    ).events.map((event) => event.sequence),
    [3, 4],
  );
  await assert.rejects(history.list({ limit: 21 }), error("invalid_cursor"));
  const before = await fs.readFile(history.file);
  await assert.rejects(
    history.recordCommand(id, "send", ids[0]),
    error("duplicate_command"),
  );
  assert.deepEqual(await fs.readFile(history.file), before);
  const events = (await (await RunHistory.open(project)).events(id)).events;
  assert.deepEqual(
    events.map((event) => event.sequence),
    [1, 2, 3, 4, 5, 6],
  );
  await assert.rejects(
    history.transition(id, "running", "fixture-peer-secret"),
    error("invalid_transition_input"),
  );
  await assert.rejects(
    history.bindSession(id, "fixture secret with controls\n"),
    error("invalid_session_id"),
  );
  assert.doesNotMatch(
    await fs.readFile(history.file, "utf8"),
    /fixture-peer-secret|PROVIDER_API_KEY|fixture-key/,
  );
});

test("tracked attachment persists command and native ack IDs and stops once despite duplicate stop requests", async (t) => {
  const f = await setup(t);
  const attached = await attachRecordedSession({
    ledger: f.ledger,
    command: f.command,
    env: f.env,
    requestTimeout: 2000,
    stopTimeout: 200,
  });
  f.adapters.push(attached.adapter);
  const during = await attached.history.inspect(attached.record.run_id);
  assert.equal(during.recorded_state, "waiting-human");
  assert.equal(
    during.process_observation.status,
    ["win32", "linux"].includes(process.platform) ? "alive" : "unknown",
  );
  assert.equal(during.state, "unknown");
  const result = await attached.adapter.send(
    attached.record.cli_session_id,
    "fixture-prompt-must-not-be-copied",
  );
  assert.match(result.command_id, /^cmd_/);
  const first = attached.adapter.stop(),
    second = attached.adapter.stop();
  assert.equal(first, second);
  const stopped = await first;
  assert.equal(stopped.confirmed, true);
  const restored = await (
    await RunHistory.open(f.project)
  ).inspect(attached.record.run_id);
  assert.equal(restored.state, "disconnected");
  assert.equal(restored.process_observation.status, "exit_confirmed");
  assert.deepEqual(
    restored.commands.map((item) => [item.operation, item.phase]),
    [
      ["start", "acknowledged"],
      ["send", "acknowledged"],
      ["stop", "acknowledged"],
    ],
  );
  assert.equal(new Set(restored.commands.map((item) => item.ack_id)).size, 3);
  assert.equal(restored.native_session_id, attached.record.cli_session_id);
  assert.doesNotMatch(
    await fs.readFile(attached.history.file, "utf8"),
    /fixture-prompt-must-not|fixture-key-not/,
  );
  const resumed = await attachRecordedSession({
    ledger: f.ledger,
    run_id: attached.record.run_id,
    command: f.command,
    env: f.env,
    requestTimeout: 2000,
    stopTimeout: 200,
  });
  f.adapters.push(resumed.adapter);
  assert.equal(resumed.record.cli_session_id, attached.record.cli_session_id);
  await resumed.adapter.stop();
});

test("a live or unverifiable recorded process blocks duplicate resume before a second ACP session starts", async (t) => {
  const f = await setup(t);
  const first = await attachRecordedSession({
    ledger: f.ledger,
    command: f.command,
    env: f.env,
    requestTimeout: 2000,
    stopTimeout: 200,
  });
  f.adapters.push(first.adapter);
  const trace = await fs.readFile(f.env.RDSH_ADAPTER_FIXTURE_TRACE);
  await assert.rejects(
    attachRecordedSession({
      ledger: f.ledger,
      run_id: first.record.run_id,
      command: f.command,
      env: f.env,
    }),
    error("run_process_unconfirmed"),
  );
  assert.deepEqual(await fs.readFile(f.env.RDSH_ADAPTER_FIXTURE_TRACE), trace);
  const inspected = await first.history.inspect(first.record.run_id, {
    observe: async () => ({ status: "unknown", identity: null }),
  });
  assert.equal(inspected.state, "unknown");
  assert.equal(inspected.process_observation.status, "unknown");
});

test("cancel notifications remain unacknowledged while the actual cancelled prompt result is recorded", async (t) => {
  const f = await setup(t);
  const attached = await attachRecordedSession({
    ledger: f.ledger,
    command: f.command,
    env: { ...f.env, RDSH_ADAPTER_FIXTURE_MODE: "busy" },
    requestTimeout: 2000,
    stopTimeout: 200,
  });
  f.adapters.push(attached.adapter);
  const requested = new Promise((resolve) => {
    attached.adapter.on("event", (event) => {
      if (event.type === "prompt_requested") resolve();
    });
  });
  const sending = attached.adapter.send(
    attached.record.cli_session_id,
    "fixture pending prompt",
  );
  await requested;
  const cancelling = await attached.adapter.interrupt(
    attached.record.cli_session_id,
  );
  assert.equal(cancelling.acknowledged, false);
  const result = await sending;
  assert.equal(result.stop_reason, "cancelled");
  const restored = await attached.history.inspect(attached.record.run_id);
  const interrupt = restored.commands.find(
    (item) => item.operation === "interrupt",
  );
  const prompt = restored.commands.find((item) => item.operation === "send");
  assert.equal(interrupt.phase, "notification_sent");
  assert.equal(interrupt.ack_id, null);
  assert.equal(interrupt.recovery_outcome, "unknown");
  assert.equal(prompt.phase, "acknowledged");
  assert.equal(prompt.outcome, "cancelled_result");
});

test("journal failures block new profile boot yet still allow cleanup of an already owned child", async (t) => {
  const f = await setup(t);
  await fs.mkdir(f.project.directory, { recursive: true });
  const foreign = '{"fixture":"foreign-lock-must-remain"}';
  await fs.writeFile(f.history.lock, foreign);
  await assert.rejects(
    attachRecordedSession({ ledger: f.ledger, command: f.command, env: f.env }),
    error("history_busy"),
  );
  await assert.rejects(
    fs.readFile(f.env.RDSH_ADAPTER_FIXTURE_TRACE),
    (failure) => failure.code === "ENOENT",
  );
  assert.equal(await fs.readFile(f.history.lock, "utf8"), foreign);
  await fs.unlink(f.history.lock);
  const attached = await attachRecordedSession({
    ledger: f.ledger,
    command: f.command,
    env: f.env,
    requestTimeout: 2000,
    stopTimeout: 200,
  });
  f.adapters.push(attached.adapter);
  await fs.writeFile(f.history.lock, foreign);
  await assert.rejects(
    attached.adapter.stop(),
    (failure) =>
      failure.code === "history_unconfirmed_after_owned_stop" &&
      failure.process_result.confirmed === true,
  );
  assert.equal(attached.adapter.stopped, true);
  assert.equal(await fs.readFile(f.history.lock, "utf8"), foreign);
  await fs.unlink(f.history.lock);
});
