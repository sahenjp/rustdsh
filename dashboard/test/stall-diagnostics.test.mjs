import test from "node:test";
import assert from "node:assert/strict";
import { diagnoseRun } from "../stall-diagnostics.mjs";

const now = "2026-10-10T03:00:00.000Z";
const ago = (milliseconds) =>
  new Date(Date.parse(now) - milliseconds).toISOString();
const running = (overrides = {}) => ({
  run_id: "run_00000000-0000-4000-8000-000000000001",
  state: "running",
  updated_at: ago(600000),
  commands: [
    {
      operation: "send",
      phase: "dispatched",
      updated_at: ago(600000),
    },
  ],
  ...overrides,
});
const alive = { status: "alive", observed_at: ago(1000) };

test("recent ACP heartbeat identifies quiet-output work as active", () => {
  const report = diagnoseRun({
    run: running({
      last_activity: { kind: "tool_update", observed_at: ago(10000) },
    }),
    processObservation: alive,
    now,
  });
  assert.equal(report.classification, "active");
  assert.equal(report.confidence, "measured");
  assert.equal(report.signals.find((item) => item.name === "agent_activity").status, "recent");
  assert.equal(report.automatic_stop, false);
});

test("a pending send without a heartbeat is reported as a possible API wait", () => {
  const report = diagnoseRun({
    run: running({
      commands: [{ operation: "send", phase: "dispatched", updated_at: ago(30000) }],
    }),
    processObservation: alive,
    now,
  });
  assert.equal(report.classification, "api_wait_possible");
  assert.equal(report.confidence, "inferred");
  assert.equal(report.signals.find((item) => item.name === "api_wait").status, "request_pending");
  assert.equal(report.automatic_stop, false);
});

test("a delayed heartbeat remains an inference and retains its observation time", () => {
  const report = diagnoseRun({
    run: running({
      last_activity: { kind: "tool_update", observed_at: ago(120000) },
      commands: [{ operation: "send", phase: "dispatched", updated_at: ago(30000) }],
    }),
    processObservation: alive,
    now,
  });
  const heartbeat = report.signals.find(
    (item) => item.name === "agent_activity",
  );
  assert.equal(report.classification, "api_wait_possible");
  assert.equal(report.confidence, "inferred");
  assert.equal(heartbeat.status, "delayed");
  assert.equal(heartbeat.observed_at, ago(120000));
  assert.equal(heartbeat.checked_at, now);
  assert.equal(report.automatic_stop, false);
});

test("a long silent pending send is only a suspected stall and shows missing counters", () => {
  const report = diagnoseRun({
    run: running(),
    processObservation: alive,
    now,
  });
  assert.equal(report.classification, "stall_suspected");
  assert.equal(report.confidence, "inferred");
  assert.equal(report.automatic_stop, false);
  assert.equal(report.signals.find((item) => item.name === "cpu_activity").status, "unavailable");
  assert.equal(report.signals.find((item) => item.name === "gpu_activity").status, "unavailable");
  assert.equal(report.signals.find((item) => item.name === "gpu_activity").observed_at, null);
  assert.equal(report.signals.find((item) => item.name === "gpu_activity").checked_at, now);
  assert.ok(report.limitations.includes("stall_is_a_suspicion_not_a_confirmed_failure"));
});

test("an explicit GPU resource wait stays distinct from process and browser state", () => {
  const report = diagnoseRun({
    run: running({
      state: "waiting-resource",
      resource_observation: {
        kind: "gpu",
        status: "waiting",
        observed_at: ago(1000),
      },
    }),
    processObservation: alive,
    uiConnection: "disconnected",
    now,
  });
  assert.equal(report.classification, "resource_wait");
  assert.equal(report.reason, "explicit_resource_wait_observed");
  assert.equal(
    report.signals.find((item) => item.name === "resource_wait").resource_kind,
    "gpu",
  );
  assert.equal(
    report.signals.find((item) => item.name === "browser_connection").status,
    "disconnected",
  );
  assert.ok(report.recommendations.includes("reconnect_dashboard"));
  assert.equal(report.automatic_stop, false);
});

test("browser disconnection does not convert a waiting-human run into a failure", () => {
  const report = diagnoseRun({
    run: running({ state: "waiting-human", commands: [] }),
    processObservation: alive,
    uiConnection: "disconnected",
    now,
  });
  assert.equal(report.classification, "waiting_human");
  assert.notEqual(report.classification, "failed");
  assert.ok(report.recommendations.includes("reconnect_dashboard"));
});

test("confirmed process exit and missing process data remain separate outcomes", () => {
  const exited = diagnoseRun({
    run: running(),
    processObservation: { status: "exit_confirmed", observed_at: now },
    now,
  });
  assert.equal(exited.classification, "process_exited");
  assert.equal(exited.confidence, "measured");

  const unavailable = diagnoseRun({
    run: running(),
    processObservation: { status: "unknown" },
    now,
  });
  assert.equal(unavailable.classification, "insufficient_evidence");
  assert.equal(unavailable.confidence, "unknown");
});

test("future timestamps and unknown commands cannot invent progress", () => {
  const future = diagnoseRun({
    run: running({
      last_activity: {
        kind: "agent_message",
        observed_at: "2026-10-10T03:01:00.000Z",
      },
    }),
    processObservation: alive,
    now,
  });
  assert.equal(future.classification, "stall_suspected");
  assert.equal(
    future.signals.find((item) => item.name === "agent_activity").status,
    "unverified",
  );
  assert.equal(
    future.signals.find((item) => item.name === "agent_activity").basis,
    "unavailable",
  );

  const unknown = diagnoseRun({
    run: running({
      commands: [
        { operation: "send", phase: "dispatched", updated_at: ago(600000) },
        { operation: "send", phase: "unknown", updated_at: ago(300000) },
      ],
    }),
    processObservation: alive,
    now,
  });
  assert.equal(unknown.classification, "insufficient_evidence");
  assert.equal(unknown.signals.find((item) => item.name === "api_wait").status, "not_observed");
});
