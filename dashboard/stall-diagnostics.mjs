// Conservative, read-only interpretation of independent run observations.
// Missing telemetry stays unavailable; silence alone never authorizes a stop.
const activeCommandPhases = new Set(["dispatched", "notification_sent"]);
const terminalStates = new Set(["succeeded", "failed"]);

function ageMs(at, now) {
  const observed = Date.parse(at);
  const current = Date.parse(now);
  if (
    !Number.isFinite(observed) ||
    !Number.isFinite(current) ||
    observed > current
  )
    return null;
  return current - observed;
}

function pendingSend(run) {
  const latest = [...(run.commands || [])]
    .reverse()
    .find((command) => command.operation === "send");
  return latest && activeCommandPhases.has(latest.phase) ? latest : null;
}

export function diagnoseRun({
  run,
  processObservation = { status: "unknown" },
  uiConnection = "unknown",
  now = new Date().toISOString(),
  stallAfterMs = 5 * 60 * 1000,
  heartbeatFreshMs = 90 * 1000,
}) {
  if (
    !run ||
    typeof run !== "object" ||
    !Number.isSafeInteger(stallAfterMs) ||
    stallAfterMs < 60 * 1000 ||
    !Number.isSafeInteger(heartbeatFreshMs) ||
    heartbeatFreshMs < 1000 ||
    !["unknown", "connected", "disconnected"].includes(uiConnection)
  )
    throw new TypeError("invalid run diagnostic input");

  const activity = run.last_activity || null;
  const activityAge = activity ? ageMs(activity.observed_at, now) : null;
  const resourceObservation = run.resource_observation || null;
  const resourceAge = resourceObservation
    ? ageMs(resourceObservation.observed_at, now)
    : null;
  const command = pendingSend(run);
  const responseAge = command ? ageMs(command.updated_at, now) : null;
  const processStatus = processObservation?.status || "unknown";
  const processAlive = processStatus === "alive";
  const processExited = [
    "exit_confirmed",
    "absence_observed",
    "gone",
    "pid_reused",
  ].includes(processStatus);
  const heartbeatStatus =
    activityAge === null
      ? activity
        ? "unverified"
        : "unavailable"
      : activityAge <= heartbeatFreshMs
        ? "recent"
        : "delayed";

  let classification = "insufficient_evidence";
  let confidence = "unknown";
  let reason = "independent_activity_or_resource_observation_missing";
  if (terminalStates.has(run.state)) {
    classification = run.state;
    confidence = "measured";
    reason = "recorded_terminal_result";
  } else if (processExited) {
    classification = "process_exited";
    confidence = "measured";
    reason = "owned_process_exit_observed";
  } else if (
    run.state === "waiting-resource" &&
    resourceObservation?.status === "available"
  ) {
    reason = "resource_observation_conflicts_with_run_state";
  } else if (
    run.state === "waiting-resource" ||
    (resourceObservation?.status === "waiting" &&
      resourceAge !== null &&
      resourceAge <= heartbeatFreshMs)
  ) {
    classification = "resource_wait";
    confidence = "measured";
    reason =
      resourceObservation?.status === "waiting"
        ? "explicit_resource_wait_observed"
        : "run_recorded_waiting_for_resource";
  } else if (run.state === "waiting-human") {
    classification = "waiting_human";
    confidence = "measured";
    reason = "run_recorded_waiting_for_human";
  } else if (activityAge !== null && activityAge <= heartbeatFreshMs) {
    classification = "active";
    confidence = "measured";
    reason = "recent_acp_activity_heartbeat";
  } else if (processAlive && command && responseAge !== null) {
    classification =
      responseAge >= stallAfterMs ? "stall_suspected" : "api_wait_possible";
    confidence = "inferred";
    reason =
      responseAge >= stallAfterMs
        ? "long_pending_send_without_recent_activity"
        : "send_command_pending_without_recent_activity";
  } else if (uiConnection === "disconnected") {
    reason = "browser_disconnected_run_health_unconfirmed";
  }

  const processObservedAt =
    processObservation?.observed_at || run.process?.observed_at || null;
  const signals = [
    {
      name: "process",
      status: processStatus,
      basis: processAlive || processExited ? "measured" : "unavailable",
      source: "owned_process_identity",
      observed_at: processObservedAt,
      checked_at: now,
    },
    {
      name: "agent_activity",
      status: heartbeatStatus,
      kind: activity?.kind || null,
      basis: activityAge === null ? "unavailable" : "measured",
      source: "acp_session_update_metadata",
      observed_at: activity?.observed_at || null,
      checked_at: now,
      age_ms: activityAge,
    },
    {
      name: "api_wait",
      status: command ? "request_pending" : "not_observed",
      basis: command ? "inferred" : "unavailable",
      source: "run_history_send_command",
      observed_at: command?.updated_at || null,
      checked_at: now,
      age_ms: responseAge,
    },
    {
      name: "resource_wait",
      status:
        resourceObservation?.status ||
        (run.state === "waiting-resource" ? "waiting" : "not_observed"),
      basis:
        resourceObservation || run.state === "waiting-resource"
          ? "measured"
          : "unavailable",
      source: resourceObservation
        ? "resource_provider_observation"
        : "run_state_machine",
      observed_at:
        resourceObservation?.observed_at ||
        (run.state === "waiting-resource" ? run.updated_at : null),
      checked_at: now,
      age_ms: resourceAge,
      resource_kind: resourceObservation?.kind || null,
    },
    {
      name: "cpu_activity",
      status: "unavailable",
      basis: "unavailable",
      source: "cpu_counter_not_collected",
      observed_at: null,
      checked_at: now,
    },
    {
      name: "gpu_activity",
      status: "unavailable",
      basis: "unavailable",
      source: "gpu_counter_not_collected",
      observed_at: null,
      checked_at: now,
    },
    {
      name: "browser_connection",
      status: uiConnection,
      basis: uiConnection === "unknown" ? "unavailable" : "measured",
      source: "dashboard_connection",
      observed_at: uiConnection === "unknown" ? null : now,
      checked_at: now,
    },
  ];

  const recommendations = [];
  if (uiConnection === "disconnected")
    recommendations.push("reconnect_dashboard");
  if (classification === "resource_wait")
    recommendations.push("inspect_resource_readiness");
  if (["api_wait_possible", "stall_suspected"].includes(classification))
    recommendations.push(
      "check_provider_and_cli_status",
      "collect_another_observation",
    );
  if (classification === "insufficient_evidence")
    recommendations.push("collect_process_and_activity_observations");
  if (
    ["active", "waiting_human", "succeeded", "failed", "process_exited"].includes(
      classification,
    )
  )
    recommendations.push("review_recorded_run_state");

  return {
    classification,
    confidence,
    reason,
    observed_at: now,
    thresholds: {
      stall_after_ms: stallAfterMs,
      heartbeat_fresh_ms: heartbeatFreshMs,
    },
    signals,
    recommendations,
    automatic_stop: false,
    limitations: [
      "stdout_activity_not_collected",
      "cpu_and_gpu_activity_unavailable",
      "api_wait_is_inferred_from_a_pending_send_command",
      "stall_is_a_suspicion_not_a_confirmed_failure",
    ],
  };
}
