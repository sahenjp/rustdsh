import { renderReports } from "./reports-view.mjs";
import { renderQuestionCards } from "./question-cards-ui.mjs";
import { renderAnswerApplications } from "./answer-applications-ui.mjs";
import { renderOverview } from "./project-overview.mjs";
import { renderConnectionDiagnostics } from "./connection-diagnostics-ui.mjs";
import { createInstructionPanel } from "./instruction-queue-ui.mjs";
import { createCostPanel } from "./cost-ledger-ui.mjs";
import { renderBudget } from "./budget-ui.mjs";

const $ = (id) => document.getElementById(id);
const base = location.pathname.startsWith("/_rdsh") ? "/_rdsh/" : "/";
const suppliedBrowserToken =
  base === "/" ? new URLSearchParams(location.hash.slice(1)).get("key") : null;
const browserToken =
  base === "/"
    ? suppliedBrowserToken ||
      sessionStorage.getItem("rdsh_project_browser_token") ||
      ""
    : "";
if (browserToken) {
  sessionStorage.setItem("rdsh_project_browser_token", browserToken);
  if (suppliedBrowserToken !== null)
    history.replaceState(null, "", location.pathname + location.search);
}
async function api(route, body) {
  const headers = browserToken ? { "x-rdsh-browser-token": browserToken } : {};
  const response = await fetch(
    base + "api/" + route,
    body === undefined
      ? { headers }
      : {
          method: "POST",
          headers: { ...headers, "content-type": "application/json" },
          body: JSON.stringify(body),
        },
  );
  const result = await response.json();
  if (!response.ok) throw new Error(result.error || "接続できません");
  return result;
}
function node(tag, text, className) {
  const result = document.createElement(tag);
  if (text !== undefined) result.textContent = text;
  if (className) result.className = className;
  return result;
}
let renderedRevision = -1;
let latestState = null;
let selectedTask = "";
let selectionKey = "";
function navigateTo(id) {
  const target = $(id);
  if (!target) return;
  for (let parent = target.parentElement; parent; parent = parent.parentElement)
    if (parent.tagName === "DETAILS") parent.open = true;
  target.tabIndex = -1;
  target.focus();
  target.scrollIntoView({ block: "start" });
}
function updateOverview(state) {
  const select = $("overview-task");
  const options = [{ id: "", title: "プロジェクト全体" }, ...state.tasks];
  if (selectedTask && !state.tasks.some((task) => task.id === selectedTask))
    options.push({ id: selectedTask, title: "現在の一覧にありません" });
  const signature = JSON.stringify(
    options.map((task) => [task.id, task.title]),
  );
  if (select.dataset.options !== signature) {
    select.replaceChildren(
      ...options.map((task) => {
        const option = node(
          "option",
          `${task.id ? task.id + " · " : ""}${task.title}`,
        );
        option.value = task.id;
        return option;
      }),
    );
    select.dataset.options = signature;
  }
  select.value = selectedTask;
  const view = renderOverview($("project-overview"), state, selectedTask, node);
  $("quick-context").textContent = view.context;
  $("quick-context").title = view.context;
  $("quick-pending").textContent =
    `判断 ${view.pending.length}件${view.reviews.length ? ` · 追指示 ${view.reviews.length}件` : ""}`;
}
$("overview-task").addEventListener("change", (event) => {
  selectedTask = event.target.value;
  try {
    sessionStorage.setItem(selectionKey, selectedTask);
  } catch {}
  if (latestState) updateOverview(latestState);
});
$("tasks").addEventListener("click", (event) => {
  const link = event.target.closest("a[data-task-id]");
  if (!link) return;
  event.preventDefault();
  selectedTask = link.dataset.taskId;
  try {
    sessionStorage.setItem(selectionKey, selectedTask);
  } catch {}
  if (latestState) updateOverview(latestState);
  navigateTo("overview-heading");
});
$("overview-pending").addEventListener("click", (event) => {
  const link = event.target.closest("a");
  if (!link) return;
  event.preventDefault();
  navigateTo(decodeURIComponent(link.hash.slice(1)));
});
$("quick-overview").onclick = () => navigateTo("overview-heading");
$("quick-pending").onclick = () => {
  const view =
    latestState &&
    renderOverview($("project-overview"), latestState, selectedTask, node);
  if (view?.reviews.length && !view.pending.length) {
    renderInstructions.selectTarget(view.reviews[0].consumer_id);
    navigateTo("instruction-panel");
  } else navigateTo("pending-heading");
};
$("quick-details").onclick = () => navigateTo("metrics-heading");
$("quick-stop").onclick = () => navigateTo("overview-stop");
$("diagnostics-refresh").onclick = async () => {
  $("diagnostics-refresh").disabled = true;
  $("diagnostics-status").textContent = "接続の各段階を確認中…";
  try {
    const report = await api("diagnostics");
    renderConnectionDiagnostics($("diagnostics-result"), report, node);
    $("diagnostics-status").textContent =
      "診断を取得しました。各日時はその段階を観測した時点です。";
  } catch {
    $("diagnostics-status").textContent =
      "診断を取得できません。現在の接続は未確認です。最新のQRまたは rdsh-dashboard open から開き直してください。";
    $("diagnostics-result").replaceChildren();
  } finally {
    $("diagnostics-refresh").disabled = false;
  }
};
function renderRunDiagnostics(report) {
  const target = $("run-diagnostics-result");
  const classNames = {
    active: "活動を観測",
    api_wait_possible: "応答待ちの可能性",
    stall_suspected: "停滞の疑い（未確定）",
    resource_wait: "資源待ち",
    process_exited: "プロセス終了を観測",
    waiting_human: "人の確認待ち",
    succeeded: "完了記録",
    failed: "失敗記録",
    insufficient_evidence: "根拠不足・状態未確認",
  };
  const signalNames = {
    process: "プロセス",
    agent_activity: "ACP活動heartbeat",
    api_wait: "応答要求",
    resource_wait: "資源待ち",
    cpu_activity: "CPU活動",
    gpu_activity: "GPU活動",
    browser_connection: "ブラウザー接続",
  };
  const statusNames = {
    alive: "稼働を観測",
    exit_confirmed: "終了を確認",
    absence_observed: "不在を観測",
    gone: "終了を観測",
    pid_reused: "PID再利用を観測",
    unknown: "未確認",
    recent: "最近の活動あり",
    delayed: "heartbeat遅延",
    unverified: "時刻を検証できず",
    unavailable: "取得できず",
    request_pending: "送信応答待ち（推定）",
    not_observed: "待機なし／未報告",
    waiting: "待機中",
    available: "利用可能",
    connected: "接続中",
    disconnected: "切断を観測",
  };
  const basisNames = {
    measured: "実測・記録",
    inferred: "推定",
    unavailable: "欠測",
    unknown: "未確認",
  };
  const reasonNames = {
    recorded_terminal_result: "run履歴に終端結果が記録されています",
    owned_process_exit_observed: "所有プロセスの終了を観測しました",
    run_recorded_waiting_for_resource: "run状態が資源待ちです",
    explicit_resource_wait_observed: "資源providerが待機を報告しました",
    resource_observation_conflicts_with_run_state: "run状態と資源providerの観測が一致しません",
    run_recorded_waiting_for_human: "run状態が人の確認待ちです",
    recent_acp_activity_heartbeat: "ACPから最近の活動通知を受けています",
    send_command_pending_without_recent_activity: "送信要求が未完了で、最近のACP活動がありません",
    long_pending_send_without_recent_activity: "送信要求とプロセスは残っていますが、活動heartbeatが長時間ありません",
    browser_disconnected_run_health_unconfirmed: "ブラウザー切断だけではrun状態を判定できません",
    independent_activity_or_resource_observation_missing: "活動や資源の独立した観測がありません",
  };
  const recommendationNames = {
    reconnect_dashboard: "ダッシュボードへ再接続する",
    inspect_resource_readiness: "待機中の資源・leaseを確認する",
    check_provider_and_cli_status: "provider/APIとCLIの状態を確認する",
    collect_another_observation: "時間を置いて追加観測する",
    collect_process_and_activity_observations: "プロセスとACP heartbeatを再確認する",
    review_recorded_run_state: "記録済みのrun状態を確認する",
  };
  const when = (value) =>
    value && Number.isFinite(Date.parse(value))
      ? new Date(value).toLocaleString("ja-JP")
      : "未取得";
  const age = (value) =>
    value === null || value === undefined
      ? "経過時間未計測"
      : value < 60000
        ? `${Math.floor(value / 1000)}秒前`
        : `${Math.floor(value / 60000)}分前`;
  const cards = (report.runs || []).map((run) => {
    const diagnosis = run.stall_diagnosis;
    const classification =
      classNames[diagnosis.classification] || diagnosis.classification;
    const article = node("article", undefined, "event");
    article.append(
      node("strong", `${run.run_id} · ${classification}`),
      node(
        "p",
        [
          `記録状態 ${run.recorded_state}`,
          `根拠 ${basisNames[diagnosis.confidence] || diagnosis.confidence}`,
          reasonNames[diagnosis.reason] || diagnosis.reason,
        ].join(" · "),
      ),
      node(
        "p",
        `観測時刻 ${when(diagnosis.observed_at)} · 自動停止なし`,
      ),
    );
    const evidence = node("ul");
    for (const signal of diagnosis.signals) {
      const signalName = signalNames[signal.name] || signal.name;
      const signalStatus = statusNames[signal.status] || signal.status;
      const detail = [
        `${signalName}: ${signalStatus}`,
        basisNames[signal.basis] || signal.basis,
        signal.resource_kind ? `種別 ${signal.resource_kind}` : null,
        signal.age_ms === undefined ? null : age(signal.age_ms),
        `観測 ${when(signal.observed_at)}`,
        `確認 ${when(signal.checked_at)}`,
      ]
        .filter(Boolean)
        .join(" · ");
      evidence.append(node("li", detail));
    }
    article.append(evidence);
    const next = (diagnosis.recommendations || [])
      .map((item) => recommendationNames[item] || item)
      .join(" · ");
    article.append(
      node("p", `次の確認: ${next || "追加操作は不要です"}`),
    );
    if (diagnosis.limitations?.length)
      article.append(
        node(
          "p",
          `未確認: ${diagnosis.limitations.join(" · ")}`,
          "sub",
        ),
      );
    return article;
  });
  target.replaceChildren(
    ...(cards.length ? cards : [node("p", "run履歴がありません。", "sub")]),
  );
}
$("run-diagnostics-refresh").onclick = async () => {
  $("run-diagnostics-refresh").disabled = true;
  $("run-diagnostics-status").textContent = "プロセスとrun履歴を確認中…";
  try {
    const report = await api("run-diagnostics");
    renderRunDiagnostics(report);
    const statusDetails = [
      report.recovery_required ? "履歴の末尾が未確定" : null,
      report.observation_store_status === "unavailable"
        ? "活動観測の保存内容を確認できません"
        : null,
    ]
      .filter(Boolean)
      .join(" · ");
    $("run-diagnostics-status").textContent =
      `直近 ${report.runs.length} run · 観測 ${new Date(
        report.observed_at,
      ).toLocaleString("ja-JP")}${statusDetails ? ` · ${statusDetails}` : ""}`;
  } catch (error) {
    $("run-diagnostics-status").textContent =
      `診断を取得できません: ${error.message}`;
    $("run-diagnostics-result").replaceChildren();
  } finally {
    $("run-diagnostics-refresh").disabled = false;
  }
};
const renderInstructions = createInstructionPanel($("instruction-panel"), {
  node,
  api,
  refreshState,
});
const renderCosts = createCostPanel($("cost-ledger"), node);
function render(state) {
  if (state.revision < renderedRevision) return;
  renderedRevision = state.revision;
  latestState = state;
  renderInstructions(state);
  renderCosts(state);
  renderBudget($("budget-admission"), state, node);
  updateOverview(state);
  renderReports(state);
  const unanswered = state.questions.filter((question) => question.answer === null);
  renderQuestionCards($("questions"), unanswered, state.question_contracts, {
    node,
    api,
    refreshState,
  });
  renderAnswerApplications($("reply-status"), state, node);
  $("answers").replaceChildren(
    ...state.questions
      .filter((question) => question.answer !== null)
      .slice()
      .reverse()
      .map((question) => {
        const element = node("article", undefined, "event");
        element.append(
          node("strong", question.question),
          node("p", question.answer),
        );
        const contract = state.question_contracts?.cards[question.id];
        element.append(
          node(
            "p",
            contract
              ? `版 ${contract.revision} · ${contract.status === "answered" ? "回答を保存済み" : contract.status === "expired" ? "期限切れ · 回答は無効" : "取消し · 回答は無効"} · 実行権限は発行していません`
              : "相談への返答を保存済み · 実行権限は発行していません",
            "sub",
          ),
        );
        return element;
      }),
  );
  $("connection").textContent = "接続済み · プロジェクト専用";
  $("updated").textContent =
    `最終受信: ${state.updated_at ? new Date(state.updated_at).toLocaleString("ja-JP") : "まだ報告がありません"} · 鮮度は各項目の観測時刻から判定します。累計欄は報告元のAPI換算値です。台帳は出所ごとの報告値です。`;
}
async function refreshState() {
  try {
    render(await api("state"));
  } catch (e) {
    $("connection").textContent = e.message;
    $("overview-state").textContent = "画面の更新に失敗 · 対象の現在状態は不明";
  }
}
let qrObjectUrl = null;
async function renderShare(config) {
  const share = config.share;
  $("share-message").textContent = share.message;
  $("share-url").textContent = share.url || "";
  $("qr").hidden = !share.url;
  $("qr-placeholder").hidden = Boolean(share.url);
  $("qr-placeholder").textContent =
    share.state === "login_required"
      ? "Tailscaleへのログイン待ち"
      : "接続準備中";
  if (qrObjectUrl) URL.revokeObjectURL(qrObjectUrl);
  qrObjectUrl = null;
  if (share.url) {
    const response = await fetch(base + "api/qr.svg?updated=" + Date.now(), {
      headers: browserToken ? { "x-rdsh-browser-token": browserToken } : {},
    });
    if (!response.ok) throw new Error("QRコードを取得できません");
    qrObjectUrl = URL.createObjectURL(await response.blob());
    $("qr").src = qrObjectUrl;
  }
  $("consent").hidden = !share.consent_url;
  if (share.consent_url) $("consent").href = share.consent_url;
  $("mcp-info").textContent =
    config.kind === "project"
      ? `MCPのイベント購読: ${config.events?.active || 0} 件` +
        (config.events?.failures
          ? ` · 配信エラー ${config.events.failures} 件`
          : "") +
        (config.mcp_url
          ? ` · MCP接続先: ${config.mcp_url}`
          : " · 外部接続は設定待ち")
      : "";
}
$("share-toggle").addEventListener("click", () => {
  $("share").hidden = !$("share").hidden;
  $("share-toggle").setAttribute("aria-expanded", String(!$("share").hidden));
});
$("share-refresh").addEventListener("click", async () => {
  $("share-refresh").disabled = true;
  try {
    await api("share/refresh", {});
    await renderShare(await api("config"));
  } catch (e) {
    $("share-message").textContent = e.message;
  } finally {
    $("share-refresh").disabled = false;
  }
});
// #61: コマンドパレット。既存操作への別導線であり、権限・状態チェックや
// 確認は各操作側（回答フォームなど）で行い、ここで迂回しない。
// 入力欄での誤発動を避け、Esc・Ctrl/⌘+K・元フォーカス復帰だけを扱う。
const paletteCommands = [
  {
    id: "toggle-share",
    ja: "共有表示を切り替える",
    en: "Toggle phone view",
    keys: "共有 スマホ QR share phone",
    run: () => $("share-toggle").click(),
  },
  {
    id: "refresh-share",
    ja: "共有の接続を更新する",
    en: "Refresh share connection",
    keys: "更新 refresh",
    run: () => $("share-refresh").click(),
  },
  {
    id: "goto-pending",
    ja: "未回答の質問へ移動する",
    en: "Go to pending questions",
    keys: "質問 未回答 question pending",
    run: () => navigateTo("pending-heading"),
  },
  {
    id: "toggle-answered",
    ja: "回答済みの質問を開閉する",
    en: "Toggle answered questions",
    keys: "回答済み answered",
    run: () => {
      $("answered").open = !$("answered").open;
    },
  },
  {
    id: "back-to-top",
    ja: "先頭へ戻る",
    en: "Back to top",
    keys: "先頭 top",
    run: () => window.scrollTo({ top: 0 }),
  },
];
let paletteReturnFocus = null;
function renderPalette(filter = "") {
  const query = filter.trim().toLowerCase();
  const matched = paletteCommands.filter(
    (command) =>
      !query ||
      (command.ja + " " + command.en + " " + command.keys)
        .toLowerCase()
        .includes(query),
  );
  $("palette-list").replaceChildren(
    ...matched.map((command) => {
      const item = node("li");
      const button = node("button", command.ja + " · " + command.en);
      button.type = "button";
      button.addEventListener("click", () => {
        $("palette").close();
        command.run();
      });
      item.append(button);
      return item;
    }),
  );
  $("palette-count").textContent = matched.length
    ? matched.length + " 件"
    : "該当なし";
}
function openPalette() {
  paletteReturnFocus = document.activeElement;
  renderPalette("");
  $("palette-search").value = "";
  $("palette").showModal();
  $("palette-search").focus();
}
$("palette-toggle").addEventListener("click", openPalette);
$("palette-search").addEventListener("input", (event) =>
  renderPalette(event.target.value),
);
$("palette").addEventListener("close", () => {
  if (paletteReturnFocus?.focus) paletteReturnFocus.focus();
});
document.addEventListener("keydown", (event) => {
  if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "k") {
    const tag = document.activeElement?.tagName;
    if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return;
    event.preventDefault();
    if ($("palette").open) $("palette").close();
    else openPalette();
  }
});
try {
  const config = await api("config");
  await renderShare(config);
  if (config.kind === "harness") {
    $("connection-detail").hidden = true;
    $("kind").textContent = "DEEPSEEK HARNESS";
    $("title").textContent = "Harnessを開く";
    $("location").textContent = "会話・ツール実行のWeb画面";
    $("project-content").hidden = true;
    $("harness").hidden = false;
    $("harness-open").href = config.harness_url;
    $("connection").textContent = "接続済み · Harness専用の入口";
    $("share").hidden = false;
    $("share-toggle").setAttribute("aria-expanded", "true");
    let stopRequested = false;
    let pendingStop = null;
    const refreshManaged = async () => {
      try {
        const value = await api("managed-process"),
          scope = value.scope;
        const labels = {
          running: "実行中",
          stopping: "停止要求中 · 子孫の終了を確認しています",
          exit_confirmed: "終了確認済み · 所有する子孫プロセスは0件",
          unverifiable: "終了確認不能 · 停止済みとは確認できません",
        };
        $("managed-status").textContent =
          labels[scope?.status] ?? "所有する実行はありません";
        $("managed-remaining").textContent = scope
          ? `残存プロセス ${scope.remaining_count ?? "未確認"} 件` +
            (scope.remaining_pids.length
              ? ` · PID ${scope.remaining_pids.join(", ")}`
              : "") +
            (scope.members_truncated ? " · 一覧は一部または未確認" : "") +
            (scope.confirmed && !scope.resources_released
              ? " · 管理用の資源解放は未確認"
              : "")
          : "";
        $("managed-run").textContent = value.run_id ?? "";
        const names = {
          input_interrupt: "入力中断",
          graceful: "協調終了",
          termination: "終了要求",
          kill: "期限後の強制終了",
          verification: "子孫の終了確認",
        };
        const results = {
          requested: "要求送信",
          unsupported: "非対応",
          running: "残存あり",
          exit_confirmed: "終了確認済み",
          unverifiable: "確認不能",
        };
        $("managed-stages").replaceChildren(
          ...value.stages.map((stage) =>
            node(
              "li",
              `${names[stage.stage]} · ${stage.phase === "request" ? "要求を記録" : results[stage.status]}`,
            ),
          ),
        );
        $("managed-stop").disabled =
          stopRequested || scope?.status !== "running";
        $("harness-open").hidden = scope?.status === "exit_confirmed";
      } catch {
        $("managed-status").textContent =
          "監視に接続できません · 終了は未確認です";
        $("managed-stop").disabled = true;
      }
    };
    $("managed-stop").onclick = async () => {
      try {
        const current = await api("managed-process");
        if (!current.run_id || current.scope?.status !== "running") {
          await refreshManaged();
          return;
        }
        pendingStop = {
          run_id: current.run_id,
          owner_id: current.scope.owner_id,
        };
        $("managed-stop-target").textContent =
          `run ${current.run_id} · owner ${current.scope.owner_id}`;
        $("managed-stop-impact").textContent =
          `このrunが所有する子孫プロセスを停止します。現在の残存 ${current.scope.remaining_count ?? "未確認"} 件（増減あり）。他のrun・外部プロセスは対象外です。停止後の作業結果は未確認です。`;
        $("managed-stop-error").textContent = "";
        $("managed-stop-confirm").disabled = false;
        $("managed-stop-dialog").showModal();
      } catch (error) {
        $("managed-status").textContent = error.message;
      }
    };
    $("managed-stop-cancel").onclick = () => $("managed-stop-dialog").close();
    $("managed-stop-dialog").addEventListener("close", () => {
      pendingStop = null;
      $("managed-stop").focus();
    });
    $("managed-stop-confirm").onclick = async () => {
      if (!pendingStop) return;
      const target = pendingStop;
      $("managed-stop-confirm").disabled = true;
      try {
        const current = await api("managed-process");
        if (
          current.run_id !== target.run_id ||
          current.scope?.owner_id !== target.owner_id ||
          current.scope.status !== "running"
        )
          throw new Error(
            "停止対象が変わりました。閉じて対象を確認し直してください",
          );
      } catch (error) {
        $("managed-stop-error").textContent = error.message;
        $("managed-stop-confirm").disabled = false;
        return;
      }
      $("managed-stop-dialog").close();
      stopRequested = true;
      $("managed-stop").disabled = true;
      $("managed-status").textContent =
        "停止要求中 · 子孫の終了を確認しています";
      try {
        await api("managed-stop", {});
      } catch (error) {
        $("managed-status").textContent = error.message;
      }
      await refreshManaged();
    };
    await refreshManaged();
    setInterval(refreshManaged, 500);
  } else {
    $("title").textContent = config.project.name;
    $("location").textContent = config.project.root;
    document.title = config.project.name + " · Project dashboard";
    selectionKey = "rdsh_overview_task_" + config.project.id;
    try {
      selectedTask = sessionStorage.getItem(selectionKey) || "";
    } catch {}
    if (location.hash.startsWith("#task-")) {
      try {
        selectedTask = decodeURIComponent(location.hash.slice(6));
        sessionStorage.setItem(selectionKey, selectedTask);
      } catch {}
    }
    $("quick-actions").hidden = false;
    await refreshState();
    const source = new EventSource(
      base + "api/live?key=" + encodeURIComponent(browserToken),
    );
    source.addEventListener("changed", refreshState);
    source.onerror = () => {
      $("connection").textContent = "再接続中…";
      $("overview-state").textContent = "再接続中 · 対象の現在状態は不明";
    };
    source.onopen = refreshState;
    // Expiration needs a clock update even when publishers send no SSE event.
    setInterval(refreshState, 5000);
  }
} catch (e) {
  $("connection").textContent = e.message;
}
