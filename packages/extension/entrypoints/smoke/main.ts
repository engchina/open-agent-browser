import { executeBrowserTool, getPageSnapshot } from "../../lib/browserTools.js";
import {
  listAuditEvents,
  listTaskArtifacts,
  listMemories,
  listTasks,
  clearPublishedPageSnapshot,
  getHealth,
  getProviderConfig,
  confirmMemoryWrite,
  deleteMemory,
  fetchTask,
  fetchPublishedPageSnapshot,
  openAgentEventSocket,
  publishPageSnapshot,
  reportToolResult,
  requestMemoryWrite,
  rejectApproval,
  requestToolExecution,
  sendChat,
  testProviderConfig,
  updateProviderConfig
} from "../../lib/apiClient.js";

const resultElement = document.getElementById("result")!;

runSmoke().catch((error) => {
  writeResult("failed", {
    error: error instanceof Error ? error.message : String(error)
  });
});

async function runSmoke(): Promise<void> {
  const params = new URLSearchParams(location.search);
  const fixtureUrl = params.get("fixtureUrl");
  const agentUrl = params.get("agentUrl");
  const providerUrl = params.get("providerUrl");

  if (!fixtureUrl || !agentUrl || !providerUrl) {
    throw new Error("fixtureUrl, agentUrl, and providerUrl query parameters are required.");
  }

  await chrome.storage.local.set({ agentBaseUrl: agentUrl });
  await updateProviderConfig({ type: "disabled" });
  const initialHealth = await getHealth();
  const providerConfig = await getProviderConfig();
  if (
    initialHealth.status !== "ok" ||
    initialHealth.provider.type !== "disabled" ||
    initialHealth.providerSource !== "stored"
  ) {
      throw new Error(`Expected stored disabled health response, got ${JSON.stringify(initialHealth)}.`);
  }
  const realtime = await connectRealtimeSmoke();
  const fixtureTab = await findFixtureTab(fixtureUrl);
  const snapshot = await getPageSnapshot(fixtureTab.id);
  const publishedSnapshot = await publishPageSnapshot(snapshot);
  const bridgedSnapshot = await fetchPublishedPageSnapshot(fixtureTab.id);
  if (bridgedSnapshot.title !== snapshot.title || bridgedSnapshot.tabId !== fixtureTab.id) {
    throw new Error(`Expected bridged snapshot for fixture tab, got ${JSON.stringify(bridgedSnapshot)}`);
  }
  const snapshotClearSmoke = await runSnapshotClearSmoke(fixtureTab.id, snapshot);

  const chat = await sendChat({
    contextPolicy: "interactive-elements",
    message: "Extract links from this page",
    pageSnapshot: bridgedSnapshot,
    tabId: fixtureTab.id
  });
  const extractLinksStep = chat.plan.find((step) => step.toolCall?.toolName === "extractLinks");

  if (!extractLinksStep?.toolCall) {
    throw new Error("Expected an extractLinks plan step.");
  }

  const serverResult = await requestToolExecution(extractLinksStep.toolCall);
  if (serverResult.status !== "queued") {
    throw new Error(`Expected queued tool result, got ${serverResult.status}.`);
  }

  const toolResultBindingSmoke = await runToolResultBindingSmoke(chat.taskId, extractLinksStep);
  const browserResult = await executeBrowserTool(extractLinksStep.toolCall);
  const report = await reportToolResult(chat.taskId, {
    result: {
      ...browserResult,
      auditLogId: serverResult.auditLogId
    },
    stepId: extractLinksStep.id,
    toolCallId: extractLinksStep.toolCall.id
  });
  const task = report.task;
  const updatedStep = task.plan.find((step) => step.id === extractLinksStep.id);
  const approvalSmoke = await runApprovalSmoke(fixtureTab.id, agentUrl);
  const controlledInputSmoke = await runControlledInputSmoke(fixtureTab.id);
  const rejectionSmoke = await runRejectionSmoke(fixtureTab.id);
  const browserControlSmoke = await runBrowserControlSmoke(fixtureTab.id);
  const scopedSnapshotSmoke = await runScopedSnapshotSmoke(fixtureTab.id);
  const accessibleLabelSmoke = await runAccessibleLabelSmoke(fixtureTab.id);
  const snapshotRedactionSmoke = await runSnapshotRedactionSmoke(fixtureTab.id);
  const structuredSnapshotSmoke = await runStructuredSnapshotSmoke(fixtureTab.id);
  const selectorSmoke = await runSnapshotSelectorSmoke(fixtureTab.id);
  const semanticClickSmoke = await runSemanticClickSmoke(fixtureTab.id);
  const visibilityGuardSmoke = await runSnapshotVisibilityGuardSmoke(fixtureTab.id);
  const approvalPageDriftSmoke = await runApprovalPageDriftSmoke(fixtureTab.id, fixtureUrl);
  const tabToolSmoke = await runTabToolSmoke(fixtureTab.id, fixtureUrl);
  const downloadToolSmoke = await runDownloadToolSmoke(fixtureTab.id, fixtureUrl);
  const navigationLinkSmoke = await runNavigationLinkSmoke(fixtureTab.id, fixtureUrl);
  const crossSiteNavigationApprovalSmoke = await runCrossSiteNavigationApprovalSmoke(fixtureTab.id);
  const pricingSmoke = await runPricingSmoke(fixtureTab.id, fixtureUrl);
  const memorySmoke = await runMemorySmoke();
  const providerSmoke = await runProviderSmoke(fixtureTab.id, snapshot, providerUrl);
  const providerToolPlanSmoke = await runProviderToolPlanSmoke(fixtureTab.id, snapshot);
  const providerRiskReasonSmoke = await runProviderRiskReasonSmoke(fixtureTab.id, snapshot);
  const providerContinuationSmoke = await runProviderContinuationSmoke(fixtureTab.id, snapshot);
  const ollamaProviderSmoke = await runOllamaProviderSmoke(fixtureTab.id, snapshot, providerUrl);
  const tasks = await listTasks();
  const taskDetail = await fetchTask(chat.taskId);
  const taskArtifacts = await listTaskArtifacts(chat.taskId);
  const auditEvents = await listAuditEvents();
  const hasExtractTask = tasks.some((candidate) => candidate.taskId === chat.taskId);
  const hasAuditEvents = auditEvents.some((event) => event.type === "chat.plan") &&
    auditEvents.some((event) => event.type === "task.toolResult");

  if (!hasExtractTask) {
    throw new Error("Task history did not include the extractLinks task.");
  }
  if (taskDetail.taskId !== chat.taskId || taskDetail.results.length < 1) {
    throw new Error(`Expected task detail for ${chat.taskId}, got ${JSON.stringify(taskDetail)}.`);
  }
  if (!taskArtifacts.some((artifact) => artifact.kind === "links" && artifact.content.includes("Pricing"))) {
    throw new Error(`Expected link artifact for ${chat.taskId}, got ${JSON.stringify(taskArtifacts)}.`);
  }
  if (!hasAuditEvents) {
    throw new Error("Audit history did not include expected chat/tool events.");
  }

  const realtimeTask = await waitForRealtimeMessage(realtime.messages, (message) =>
    isRecord(message) &&
    message.kind === "task" &&
    isRecord(message.task) &&
    message.task.taskId === chat.taskId
  );
  const realtimeAudit = await waitForRealtimeMessage(realtime.messages, (message) =>
    isRecord(message) &&
    message.kind === "audit" &&
    isRecord(message.event) &&
    message.event.type === "task.toolResult"
  );
  realtime.socket.close();

  writeResult("success", {
    approvalSmoke,
    approvalPageDriftSmoke,
    accessibleLabelSmoke,
    agentHealth: {
      providerSource: initialHealth.providerSource,
      providerType: initialHealth.provider.type,
      status: initialHealth.status
    },
    auditEventCount: auditEvents.length,
    browserControlSmoke,
    chatMessage: chat.message,
    controlledInputSmoke,
    crossSiteNavigationApprovalSmoke,
    downloadToolSmoke,
    historyTaskCount: tasks.length,
    historyTaskDetail: {
      artifactCount: taskArtifacts.length,
      resultCount: taskDetail.results.length,
      status: taskDetail.status,
      taskId: taskDetail.taskId
    },
    fixtureTabId: fixtureTab.id,
    linkContinuation: report.continuation?.message,
    linkCount: (browserResult.result as { links?: unknown[] }).links?.length ?? 0,
    linkOutput: task.output,
    memorySmoke,
    navigationLinkSmoke,
    ollamaProviderSmoke,
    pricingSmoke,
    providerContinuationSmoke,
    providerRiskReasonSmoke,
    providerSmoke,
    providerToolPlanSmoke,
    providerSource: providerConfig.source,
    providerType: providerConfig.config.type,
    rejectionSmoke,
    realtimeSmoke: {
      auditType: isRecord(realtimeAudit) && isRecord(realtimeAudit.event) ? realtimeAudit.event.type : undefined,
      helloKind: isRecord(realtime.hello) ? realtime.hello.kind : undefined,
      taskId: isRecord(realtimeTask) && isRecord(realtimeTask.task) ? realtimeTask.task.taskId : undefined
    },
    scopedSnapshotSmoke,
    snapshotRedactionSmoke,
    semanticClickSmoke,
    selectorSmoke,
    snapshotClearSmoke,
    snapshotBridge: {
      linkCount: bridgedSnapshot.links.length,
      publishedTitle: publishedSnapshot.title,
      readTitle: bridgedSnapshot.title
    },
    snapshotTitle: snapshot.title,
    structuredSnapshotSmoke,
    tabToolSmoke,
    taskStatus: task.status,
    toolResultBindingSmoke,
    updatedStepStatus: updatedStep?.status,
    visibilityGuardSmoke
  });
}

async function runSnapshotClearSmoke(
  tabId: number | undefined,
  snapshot: Awaited<ReturnType<typeof getPageSnapshot>>
): Promise<Record<string, unknown>> {
  const clearResult = await clearPublishedPageSnapshot(tabId);
  let missingAfterClear = false;

  try {
    await fetchPublishedPageSnapshot(tabId);
  } catch {
    missingAfterClear = true;
  }

  const restored = await publishPageSnapshot(snapshot);
  return {
    cleared: clearResult.cleared,
    missingAfterClear,
    restoredTitle: restored.title
  };
}

async function runCrossSiteNavigationApprovalSmoke(tabId: number): Promise<Record<string, unknown>> {
  const snapshot = await getPageSnapshot(tabId);
  const chat = await sendChat({
    contextPolicy: "interactive-elements",
    message: "Open https://cross-site.example/docs and extract links",
    pageSnapshot: snapshot,
    tabId
  });
  const approval = chat.approvalRequests.find((request) => request.toolCall.toolName === "navigate");

  if (!approval) {
    throw new Error("Expected a navigation approval for cross-site navigation smoke.");
  }

  return {
    risk: approval.risk,
    sourceUrl: approval.toolCall.args.sourceUrl,
    targetUrl: approval.toolCall.args.url
  };
}

async function runToolResultBindingSmoke(
  taskId: string,
  step: Awaited<ReturnType<typeof sendChat>>["plan"][number]
): Promise<Record<string, unknown>> {
  if (!step.toolCall) {
    throw new Error("Expected a planned tool call for result binding smoke.");
  }

  const rejections: string[] = [];

  try {
    await reportToolResult(taskId, {
      result: {
        result: { text: "mismatched result" },
        status: "completed",
        toolName: "extractText"
      },
      stepId: step.id,
      toolCallId: step.toolCall.id
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (message.includes("tool name")) {
      rejections.push("toolName");
    } else {
      throw error;
    }
  }

  try {
    await reportToolResult(taskId, {
      result: {
        status: "queued",
        toolName: step.toolCall.toolName
      },
      stepId: step.id,
      toolCallId: step.toolCall.id
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (message.includes("terminal browser execution result")) {
      rejections.push("status");
    } else {
      throw error;
    }
  }

  if (rejections.includes("toolName") && rejections.includes("status")) {
    return {
      reasons: rejections,
      rejected: true
    };
  }

  throw new Error(`Expected mismatched tool result reports to be rejected, got ${JSON.stringify(rejections)}.`);
}

async function runAccessibleLabelSmoke(tabId: number): Promise<Record<string, unknown>> {
  const snapshot = await getPageSnapshot(tabId);
  const target = snapshot.elements.find((element) => element.selector === "#billing-field");

  if (!target || target.attributes.label !== "Billing Email") {
    throw new Error(`Expected accessible label for #billing-field, got ${JSON.stringify(target)}.`);
  }

  return {
    label: target.attributes.label,
    selector: target.selector,
    text: target.text
  };
}

async function runSnapshotRedactionSmoke(tabId: number): Promise<Record<string, unknown>> {
  const snapshot = await getPageSnapshot(tabId);
  const serialized = JSON.stringify(snapshot);
  const resetLink = snapshot.links.find((link) => link.href.includes("/reset"));

  if (
    serialized.includes("reviewer@example.test") ||
    serialized.includes("secret-token") ||
    serialized.includes("Bearer abcdef123456")
  ) {
    throw new Error(`Expected sensitive snapshot text and URLs to be redacted, got ${serialized}.`);
  }
  if (!resetLink?.href.includes("token=%5Bredacted%5D") || !resetLink.text.includes("[redacted]")) {
    throw new Error(`Expected redacted reset link, got ${JSON.stringify(resetLink)}.`);
  }

  return {
    hasRawBearer: serialized.includes("Bearer abcdef123456"),
    hasRawEmail: serialized.includes("reviewer@example.test"),
    hasRawToken: serialized.includes("secret-token"),
    resetHref: resetLink.href,
    resetText: resetLink.text
  };
}

async function runStructuredSnapshotSmoke(tabId: number): Promise<Record<string, unknown>> {
  const snapshot = await getPageSnapshot(tabId);
  const heading = snapshot.headings?.find((candidate) => candidate.level === 1);
  const table = snapshot.tables?.find((candidate) => candidate.headers.includes("Feature"));

  if (heading?.text !== "Open Agent Fixture" || !table) {
    throw new Error(`Expected heading and table structure in snapshot, got ${JSON.stringify({
      headings: snapshot.headings,
      tables: snapshot.tables
    })}.`);
  }

  return {
    firstHeading: heading.text,
    firstHeadingLevel: heading.level,
    tableHeaders: table.headers,
    tableRows: table.rows.length,
    tableSelector: table.selector
  };
}

async function runSnapshotSelectorSmoke(tabId: number): Promise<Record<string, unknown>> {
  const snapshot = await getPageSnapshot(tabId);
  const target = snapshot.elements.find((element) => element.text === "Anonymous Target");
  if (!target) {
    throw new Error(`Expected anonymous target in snapshot, got ${JSON.stringify(snapshot.elements)}`);
  }

  const toolCall = {
    args: {
      description: "Click anonymous target",
      selector: target.selector
    },
    id: crypto.randomUUID(),
    tabId,
    toolName: "click" as const
  };
  const withoutToken = await requestToolExecution(toolCall);
  if (withoutToken.status !== "requires_approval" || !withoutToken.approvalRequest) {
    throw new Error(`Expected approval for anonymous target click, got ${JSON.stringify(withoutToken)}.`);
  }

  const approved = await requestToolExecution({
    ...withoutToken.approvalRequest.toolCall,
    confirmationToken: withoutToken.approvalRequest.token
  });
  if (approved.status !== "queued") {
    throw new Error(`Expected queued anonymous target click, got ${approved.status}.`);
  }

  const browserResult = await executeBrowserTool(withoutToken.approvalRequest.toolCall);
  const status = await readElementText(tabId, "#anonymous-click-status");

  if (status !== "anonymous-clicked") {
    throw new Error(`Expected anonymous selector click to update status, got ${status} from selector ${target.selector}.`);
  }

  return {
    browserStatus: browserResult.status,
    selector: target.selector,
    serverStatus: approved.status,
    status
  };
}

async function runSemanticClickSmoke(tabId: number): Promise<Record<string, unknown>> {
  const snapshot = await getPageSnapshot(tabId);
  const chat = await sendChat({
    contextPolicy: "interactive-elements",
    message: "Click the Delete Draft button",
    pageSnapshot: snapshot,
    tabId
  });
  const approval = chat.approvalRequests.find((request) => request.toolCall.toolName === "click");

  if (!approval) {
    throw new Error(`Expected semantic click approval, got ${JSON.stringify(chat)}.`);
  }
  if (approval.toolCall.args.selector !== "#delete-draft" || approval.risk !== "high") {
    throw new Error(`Expected high-risk delete draft click approval, got ${JSON.stringify(approval)}.`);
  }

  const approved = await requestToolExecution({
    ...approval.toolCall,
    confirmationToken: approval.token
  });
  if (approved.status !== "queued") {
    throw new Error(`Expected queued semantic click execution, got ${JSON.stringify(approved)}.`);
  }

  const browserResult = await executeBrowserTool(approval.toolCall);
  const status = await readElementText(tabId, "#semantic-click-status");
  if (status !== "delete-clicked") {
    throw new Error(`Expected semantic click to update status, got ${status}.`);
  }

  return {
    browserStatus: browserResult.status,
    reason: approval.reason,
    risk: approval.risk,
    selector: approval.toolCall.args.selector,
    serverStatus: approved.status,
    status
  };
}

async function runSnapshotVisibilityGuardSmoke(tabId: number): Promise<Record<string, unknown>> {
  const snapshot = await getPageSnapshot(tabId);
  const hiddenElement = snapshot.elements.find((element) =>
    element.selector === "#hidden-agent-action" || element.text === "Hidden Agent Trap"
  );
  if (hiddenElement) {
    throw new Error(`Expected hidden action to be omitted from snapshot, got ${JSON.stringify(hiddenElement)}.`);
  }

  let error = "";
  try {
    await executeBrowserTool({
      args: {
        selector: "#hidden-agent-action"
      },
      id: crypto.randomUUID(),
      tabId,
      toolName: "click"
    });
  } catch (caught) {
    error = caught instanceof Error ? caught.message : String(caught);
  }

  const status = await readElementText(tabId, "#hidden-action-status");
  if (!error.includes("not visible")) {
    throw new Error(`Expected hidden action click to fail as not visible, got ${error || "no error"}.`);
  }
  if (status) {
    throw new Error(`Expected hidden action not to mutate page state, got ${status}.`);
  }

  return {
    error,
    hiddenOmitted: true,
    statusUnchanged: true
  };
}

async function runApprovalPageDriftSmoke(tabId: number, fixtureUrl: string): Promise<Record<string, unknown>> {
  await executeBrowserTool({
    args: {
      url: fixtureUrl
    },
    id: crypto.randomUUID(),
    tabId,
    toolName: "navigate"
  });
  const toolCall = {
    args: {
      description: "Click inspect button before page changes",
      expectedUrl: fixtureUrl,
      selector: "#noop"
    },
    id: crypto.randomUUID(),
    tabId,
    toolName: "click" as const
  };
  const withoutToken = await requestToolExecution(toolCall);
  if (withoutToken.status !== "requires_approval" || !withoutToken.approvalRequest) {
    throw new Error(`Expected approval for stale-page click, got ${JSON.stringify(withoutToken)}.`);
  }

  await executeBrowserTool({
    args: {
      url: `${fixtureUrl}/pricing`
    },
    id: crypto.randomUUID(),
    tabId,
    toolName: "navigate"
  });
  const approved = await requestToolExecution({
    ...withoutToken.approvalRequest.toolCall,
    confirmationToken: withoutToken.approvalRequest.token
  });
  if (approved.status !== "queued") {
    throw new Error(`Expected queued stale-page click after approval, got ${approved.status}.`);
  }

  let error = "";
  try {
    await executeBrowserTool(withoutToken.approvalRequest.toolCall);
  } catch (executionError) {
    error = executionError instanceof Error ? executionError.message : String(executionError);
  }

  if (!error.includes("Page changed after approval")) {
    throw new Error(`Expected page drift guard error, got ${error || "no error"}.`);
  }

  await executeBrowserTool({
    args: {
      url: fixtureUrl
    },
    id: crypto.randomUUID(),
    tabId,
    toolName: "navigate"
  });

  return {
    approvedStatus: approved.status,
    error,
    withoutTokenStatus: withoutToken.status
  };
}

async function runTabToolSmoke(tabId: number, fixtureUrl: string): Promise<Record<string, unknown>> {
  const listCall = {
    args: {
      currentWindow: true
    },
    id: crypto.randomUUID(),
    tabId,
    toolName: "listTabs" as const
  };
  const listServerResult = await requestToolExecution(listCall);
  if (listServerResult.status !== "queued") {
    throw new Error(`Expected queued tab list request, got ${listServerResult.status}.`);
  }

  const listBrowserResult = await executeBrowserTool(listCall);
  if (listBrowserResult.status !== "completed" || !isRecord(listBrowserResult.result)) {
    throw new Error(`Expected completed tab list result, got ${JSON.stringify(listBrowserResult)}.`);
  }

  const tabs = Array.isArray(listBrowserResult.result.tabs) ? listBrowserResult.result.tabs : [];
  const fixtureTab = tabs.find((candidate) =>
    isRecord(candidate) &&
    candidate.id === tabId &&
    typeof candidate.url === "string" &&
    candidate.url.startsWith(fixtureUrl)
  );
  if (!fixtureTab) {
    throw new Error(`Expected fixture tab in tab list, got ${JSON.stringify(tabs)}.`);
  }

  const activateCall = {
    args: {
      tabId
    },
    id: crypto.randomUUID(),
    tabId,
    toolName: "activateTab" as const
  };
  const activateServerResult = await requestToolExecution(activateCall);
  if (activateServerResult.status !== "queued") {
    throw new Error(`Expected queued tab activation request, got ${activateServerResult.status}.`);
  }

  const activateBrowserResult = await executeBrowserTool(activateCall);
  if (activateBrowserResult.status !== "completed" || !isRecord(activateBrowserResult.result)) {
    throw new Error(`Expected completed tab activation result, got ${JSON.stringify(activateBrowserResult)}.`);
  }

  const openCall = {
    args: {
      active: true,
      sourceUrl: fixtureUrl,
      url: `${fixtureUrl}#opened-by-tab-tool`
    },
    id: crypto.randomUUID(),
    toolName: "openTab" as const
  };
  const openWithoutToken = await requestToolExecution(openCall);
  if (openWithoutToken.status !== "requires_approval" || !openWithoutToken.approvalRequest) {
    throw new Error(`Expected approval for opening a new tab, got ${JSON.stringify(openWithoutToken)}.`);
  }

  const openApproved = await requestToolExecution({
    ...openWithoutToken.approvalRequest.toolCall,
    confirmationToken: openWithoutToken.approvalRequest.token
  });
  if (openApproved.status !== "queued") {
    throw new Error(`Expected queued open tab request after approval, got ${openApproved.status}.`);
  }

  const openBrowserResult = await executeBrowserTool(openWithoutToken.approvalRequest.toolCall);
  if (openBrowserResult.status !== "completed" || !isRecord(openBrowserResult.result)) {
    throw new Error(`Expected completed open tab result, got ${JSON.stringify(openBrowserResult)}.`);
  }
  const openedTabId = typeof openBrowserResult.result.id === "number" ? openBrowserResult.result.id : undefined;
  if (typeof openedTabId !== "number") {
    throw new Error(`Expected opened tab ID, got ${JSON.stringify(openBrowserResult)}.`);
  }

  const closeCall = {
    args: {
      tabId: openedTabId,
      title: typeof openBrowserResult.result.title === "string" ? openBrowserResult.result.title : undefined,
      url: typeof openBrowserResult.result.url === "string" ? openBrowserResult.result.url : undefined,
      windowId: typeof openBrowserResult.result.windowId === "number" ? openBrowserResult.result.windowId : undefined
    },
    id: crypto.randomUUID(),
    toolName: "closeTab" as const
  };
  const closeWithoutToken = await requestToolExecution(closeCall);
  if (closeWithoutToken.status !== "requires_approval" || !closeWithoutToken.approvalRequest) {
    throw new Error(`Expected approval for closing a tab, got ${JSON.stringify(closeWithoutToken)}.`);
  }

  const closeApproved = await requestToolExecution({
    ...closeWithoutToken.approvalRequest.toolCall,
    confirmationToken: closeWithoutToken.approvalRequest.token
  });
  if (closeApproved.status !== "queued") {
    throw new Error(`Expected queued close tab request after approval, got ${closeApproved.status}.`);
  }
  const closeBrowserResult = await executeBrowserTool(closeWithoutToken.approvalRequest.toolCall);
  if (closeBrowserResult.status !== "completed") {
    throw new Error(`Expected completed close tab result, got ${JSON.stringify(closeBrowserResult)}.`);
  }
  await executeBrowserTool(activateCall);
  const afterCloseTabs = await executeBrowserTool(listCall);
  const afterCloseList = isRecord(afterCloseTabs.result) && Array.isArray(afterCloseTabs.result.tabs)
    ? afterCloseTabs.result.tabs
    : [];

  return {
    activatedTabId: activateBrowserResult.result.id,
    activateServerStatus: activateServerResult.status,
    closeServerStatus: closeApproved.status,
    closedTabMissing: !afterCloseList.some((candidate) => isRecord(candidate) && candidate.id === openedTabId),
    fixtureListed: true,
    listServerStatus: listServerResult.status,
    openServerStatus: openApproved.status,
    openedTabId,
    tabCount: tabs.length
  };
}

async function runDownloadToolSmoke(tabId: number, fixtureUrl: string): Promise<Record<string, unknown>> {
  const toolCall = {
    args: {
      conflictAction: "overwrite",
      filename: "open-agent-browser-smoke/download.txt",
      saveAs: false,
      sourceUrl: fixtureUrl,
      url: `${fixtureUrl}/download.txt`
    },
    id: crypto.randomUUID(),
    tabId,
    toolName: "downloadUrl" as const
  };
  const withoutToken = await requestToolExecution(toolCall);
  if (withoutToken.status !== "requires_approval" || !withoutToken.approvalRequest) {
    throw new Error(`Expected approval for URL download, got ${JSON.stringify(withoutToken)}.`);
  }

  const approved = await requestToolExecution({
    ...withoutToken.approvalRequest.toolCall,
    confirmationToken: withoutToken.approvalRequest.token
  });
  if (approved.status !== "queued") {
    throw new Error(`Expected queued download request after approval, got ${approved.status}.`);
  }

  const browserResult = await executeBrowserTool(withoutToken.approvalRequest.toolCall);
  if (browserResult.status !== "completed" || !isRecord(browserResult.result)) {
    throw new Error(`Expected completed download result, got ${JSON.stringify(browserResult)}.`);
  }

  const resultUrl = typeof browserResult.result.url === "string" ? browserResult.result.url : "";

  return {
    approvedStatus: approved.status,
    browserStatus: browserResult.status,
    downloadId: browserResult.result.downloadId,
    state: browserResult.result.state,
    urlMatches: resultUrl === `${fixtureUrl}/download.txt`,
    withoutTokenStatus: withoutToken.status
  };
}

async function runScopedSnapshotSmoke(tabId: number): Promise<Record<string, unknown>> {
  const toolCall = {
    args: {
      includeInputs: false,
      includeLinks: false
    },
    id: crypto.randomUUID(),
    tabId,
    toolName: "getPageSnapshot" as const
  };
  const serverResult = await requestToolExecution(toolCall);
  if (serverResult.status !== "queued") {
    throw new Error(`Expected queued scoped snapshot request, got ${serverResult.status}.`);
  }

  const browserResult = await executeBrowserTool(toolCall);
  if (browserResult.status !== "completed" || !isRecord(browserResult.result)) {
    throw new Error(`Expected completed scoped snapshot, got ${JSON.stringify(browserResult)}.`);
  }

  const links = Array.isArray(browserResult.result.links) ? browserResult.result.links : [];
  const elements = Array.isArray(browserResult.result.elements) ? browserResult.result.elements : [];
  const tagNames = elements.flatMap((element) =>
    isRecord(element) && typeof element.tagName === "string" ? [element.tagName] : []
  );
  const hasInputs = tagNames.some((tagName) => ["input", "select", "textarea"].includes(tagName));
  const hasAnchors = tagNames.includes("a");
  const hasButtons = tagNames.includes("button");

  if (links.length > 0 || hasInputs || hasAnchors || !hasButtons) {
    throw new Error(`Expected snapshot without links/inputs but with buttons, got ${JSON.stringify({
      hasAnchors,
      hasButtons,
      hasInputs,
      linkCount: links.length,
      tagNames
    })}`);
  }

  return {
    hasAnchors,
    hasButtons,
    hasInputs,
    linkCount: links.length,
    serverStatus: serverResult.status
  };
}

async function runControlledInputSmoke(tabId: number): Promise<Record<string, unknown>> {
  const email = "controlled@example.test";
  const toolCall = {
    args: {
      clearFirst: true,
      selector: "#controlled-email",
      text: email
    },
    id: crypto.randomUUID(),
    tabId,
    toolName: "type" as const
  };
  const withoutToken = await requestToolExecution(toolCall);
  if (withoutToken.status !== "requires_approval" || !withoutToken.approvalRequest) {
    throw new Error(`Expected controlled input type approval, got ${JSON.stringify(withoutToken)}.`);
  }

  const approved = await requestToolExecution({
    ...withoutToken.approvalRequest.toolCall,
    confirmationToken: withoutToken.approvalRequest.token
  });
  if (approved.status !== "queued") {
    throw new Error(`Expected queued controlled input type, got ${approved.status}.`);
  }

  const browserResult = await executeBrowserTool(withoutToken.approvalRequest.toolCall);
  const domValue = await readInputValue(tabId, "#controlled-email");
  const observedValue = await readElementText(tabId, "#controlled-status");

  if (browserResult.status !== "completed" || domValue !== email || observedValue !== email) {
    throw new Error(`Expected controlled input value ${email}, got ${JSON.stringify({ browserResult, domValue, observedValue })}.`);
  }

  return {
    approvedStatus: approved.status,
    browserStatus: browserResult.status,
    domValue,
    observedValue,
    withoutTokenStatus: withoutToken.status
  };
}

async function runRejectionSmoke(tabId: number): Promise<Record<string, unknown>> {
  const rejectedEmail = "rejected@example.test";
  const snapshot = await getPageSnapshot(tabId);
  const chat = await sendChat({
    contextPolicy: "interactive-elements",
    message: `Fill the form with ${rejectedEmail}`,
    pageSnapshot: snapshot,
    tabId
  });
  const approval = chat.approvalRequests.find((request) => request.toolCall.toolName === "type");
  const step = chat.plan.find((candidate) => candidate.toolCall?.id === approval?.toolCall.id);

  if (!approval || !step?.toolCall) {
    throw new Error(`Expected a type approval to reject, got ${JSON.stringify(chat)}.`);
  }

  const rejected = await rejectApproval({
    approvalId: approval.id,
    reason: "Smoke test rejected form typing.",
    stepId: step.id,
    taskId: chat.taskId,
    token: approval.token,
    toolCallId: approval.toolCall.id
  });
  const emailAfterReject = await readInputValue(tabId, "input[name=\"email\"]");
  const rejectedStep = rejected.task?.plan.find((candidate) => candidate.id === step.id);

  if (emailAfterReject === rejectedEmail) {
    throw new Error("Rejected approval still changed the email field.");
  }

  return {
    emailAfterReject,
    rejectedStatus: rejected.result.status,
    stepStatus: rejectedStep?.status,
    taskStatus: rejected.task?.status
  };
}

async function runBrowserControlSmoke(tabId: number): Promise<Record<string, unknown>> {
  await scrollToTop(tabId);
  await focusElement(tabId, "#keyboard-target");
  const snapshot = await getPageSnapshot(tabId);
  const chat = await sendChat({
    contextPolicy: "interactive-elements",
    message: "Scroll down, press Enter, and take a full page screenshot",
    pageSnapshot: snapshot,
    tabId
  });
  const scrollStep = chat.plan.find((step) => step.toolCall?.toolName === "scroll");
  const pressStep = chat.plan.find((step) => step.toolCall?.toolName === "press");
  const screenshotStep = chat.plan.find((step) => step.toolCall?.toolName === "screenshot");

  if (!scrollStep?.toolCall || !pressStep?.toolCall || !screenshotStep?.toolCall) {
    throw new Error(`Expected scroll, press, and screenshot steps, got ${JSON.stringify(chat.plan)}.`);
  }

  const scrollServerResult = await requestToolExecution(scrollStep.toolCall);
  if (scrollServerResult.status !== "queued") {
    throw new Error(`Expected queued scroll, got ${scrollServerResult.status}.`);
  }
  const scrollResult = await executeBrowserTool(scrollStep.toolCall);
  await reportToolResult(chat.taskId, {
    result: {
      ...scrollResult,
      auditLogId: scrollServerResult.auditLogId
    },
    stepId: scrollStep.id,
    toolCallId: scrollStep.toolCall.id
  });
  const scrollY = await waitForScrollY(tabId);

  await focusElement(tabId, "#keyboard-target");
  const pressWithoutToken = await requestToolExecution(pressStep.toolCall);
  if (pressWithoutToken.status !== "requires_approval") {
    throw new Error(`Expected requires_approval for press without token, got ${pressWithoutToken.status}.`);
  }
  const pressReport = await approveAndRunStep(chat.taskId, pressStep, chat.approvalRequests);
  const keyStatus = await readElementText(tabId, "#key-status");

  if (keyStatus !== "Enter") {
    throw new Error(`Expected key status Enter after approved press, got ${keyStatus}.`);
  }

  const screenshotServerResult = await requestToolExecution(screenshotStep.toolCall);
  if (screenshotServerResult.status !== "queued") {
    throw new Error(`Expected queued screenshot, got ${screenshotServerResult.status}.`);
  }
  const screenshotResult = await executeBrowserTool(screenshotStep.toolCall);
  const screenshotReport = await reportToolResult(chat.taskId, {
    result: {
      ...screenshotResult,
      auditLogId: screenshotServerResult.auditLogId
    },
    stepId: screenshotStep.id,
    toolCallId: screenshotStep.toolCall.id
  });
  const screenshotPayload = screenshotResult.result as { dataUrl?: string; fullPage?: boolean };
  const dataUrl = screenshotPayload.dataUrl ?? "";
  const storedScreenshotResult = screenshotReport.task.results.find((result) =>
    result.toolCallId === screenshotStep.toolCall?.id
  )?.result.result as { dataUrl?: string; mimeType?: string; redacted?: boolean } | undefined;
  const pressTaskStep = pressReport.task.plan.find((step) => step.id === pressStep.id);
  const screenshotTaskStep = screenshotReport.task.plan.find((step) => step.id === screenshotStep.id);

  return {
    keyStatus,
    pressApprovedStatus: pressReport.approvedStatus,
    pressStepStatus: pressTaskStep?.status,
    pressWithoutTokenStatus: pressWithoutToken.status,
    screenshotFullPage: screenshotPayload.fullPage,
    screenshotPrefix: dataUrl.slice(0, 22),
    screenshotStoredDataUrl: storedScreenshotResult?.dataUrl,
    screenshotStoredMimeType: storedScreenshotResult?.mimeType,
    screenshotStoredRedacted: storedScreenshotResult?.redacted,
    screenshotStepStatus: screenshotTaskStep?.status,
    scrollY,
    taskStatus: screenshotReport.task.status
  };
}

async function connectRealtimeSmoke(): Promise<{ hello: unknown; messages: unknown[]; socket: WebSocket }> {
  const messages: unknown[] = [];
  const socket = await openAgentEventSocket();
  socket.addEventListener("message", (event) => {
    messages.push(JSON.parse(String(event.data)) as unknown);
  });
  await waitForSocketOpen(socket);
  const hello = await waitForRealtimeMessage(messages, (message) =>
    isRecord(message) && message.kind === "hello"
  );

  return { hello, messages, socket };
}

async function runOllamaProviderSmoke(
  tabId: number,
  snapshot: Awaited<ReturnType<typeof getPageSnapshot>>,
  providerUrl: string
): Promise<Record<string, unknown>> {
  const config = {
    baseUrl: providerUrl,
    model: "fake-local-model",
    type: "ollama" as const
  };
  const saved = await updateProviderConfig(config);
  const testResult = await testProviderConfig(config);
  const health = await getHealth();

  if (!testResult.ok) {
    throw new Error(`Expected fake Ollama provider test to pass, got ${testResult.message}.`);
  }
  if (
    health.status !== "ok" ||
    health.provider.type !== "ollama" ||
    health.providerSource !== "stored"
  ) {
    throw new Error(`Expected stored Ollama health response, got ${JSON.stringify(health)}.`);
  }

  const chat = await sendChat({
    contextPolicy: "interactive-elements",
    message: "Summarize this page through the local Ollama provider",
    pageSnapshot: snapshot,
    tabId
  });

  if (!chat.message.includes("Fake Ollama saw Open Agent Fixture and confirmed memory")) {
    throw new Error(`Expected fake Ollama chat response, got ${chat.message}.`);
  }

  return {
    chatMessage: chat.message,
    configSource: saved.source,
    configType: saved.config.type,
    healthSource: health.providerSource,
    healthStatus: health.status,
    healthType: health.provider.type,
    testMessage: testResult.message,
    testOk: testResult.ok
  };
}

async function runNavigationLinkSmoke(tabId: number, fixtureUrl: string): Promise<Record<string, unknown>> {
  const snapshot = await getPageSnapshot(tabId);
  const chat = await sendChat({
    contextPolicy: "interactive-elements",
    message: `Open ${fixtureUrl}/pricing and extract links`,
    pageSnapshot: snapshot,
    tabId
  });
  const approval = chat.approvalRequests.find((request) => request.toolCall.toolName === "navigate");
  const navigateStep = chat.plan.find((step) => step.toolCall?.toolName === "navigate");
  const linkStepBeforeNavigation = chat.plan.find((step) => step.toolCall?.toolName === "extractLinks");

  if (!approval || !navigateStep?.toolCall || !linkStepBeforeNavigation?.toolCall) {
    throw new Error("Expected guarded navigation followed by extractLinks.");
  }
  if (linkStepBeforeNavigation.status !== "blocked") {
    throw new Error(`Expected extractLinks blocked before navigation, got ${linkStepBeforeNavigation.status}.`);
  }

  const approved = await requestToolExecution({
    ...approval.toolCall,
    confirmationToken: approval.token
  });
  if (approved.status !== "queued") {
    throw new Error(`Expected queued approved navigation, got ${approved.status}.`);
  }

  const navigateResult = await executeBrowserTool(approval.toolCall);
  const report = await reportToolResult(chat.taskId, {
    result: {
      ...navigateResult,
      auditLogId: approved.auditLogId
    },
    stepId: navigateStep.id,
    toolCallId: approval.toolCall.id
  });
  const linkStepAfterNavigation = report.task.plan.find((step) => step.toolCall?.toolName === "extractLinks");

  if (linkStepAfterNavigation?.status !== "pending") {
    throw new Error(`Expected extractLinks pending after navigation, got ${JSON.stringify(report.task.plan)}.`);
  }

  return {
    approvedStatus: approved.status,
    beforeStatus: linkStepBeforeNavigation.status,
    afterStatus: linkStepAfterNavigation.status
  };
}

async function runPricingSmoke(tabId: number, fixtureUrl: string): Promise<Record<string, unknown>> {
  const snapshot = await getPageSnapshot(tabId);
  const chat = await sendChat({
    contextPolicy: "interactive-elements",
    message: `Open ${fixtureUrl}/pricing and extract pricing as JSON`,
    pageSnapshot: snapshot,
    tabId
  });
  const approval = chat.approvalRequests.find((request) => request.toolCall.toolName === "navigate");
  const navigateStep = chat.plan.find((step) => step.toolCall?.toolName === "navigate");

  if (!approval || !navigateStep?.toolCall) {
    throw new Error("Expected a guarded navigate approval request.");
  }

  const approved = await requestToolExecution({
    ...approval.toolCall,
    confirmationToken: approval.token
  });
  if (approved.status !== "queued") {
    throw new Error(`Expected queued approved navigation, got ${approved.status}.`);
  }

  const navigateResult = await executeBrowserTool(approval.toolCall);
  const navigateReport = await reportToolResult(chat.taskId, {
    result: {
      ...navigateResult,
      auditLogId: approved.auditLogId
    },
    stepId: navigateStep.id,
    toolCallId: approval.toolCall.id
  });
  const snapshotStep = navigateReport.task.plan.find((step) => step.toolCall?.toolName === "getPageSnapshot");

  if (!snapshotStep?.toolCall || snapshotStep.status !== "pending") {
    throw new Error(`Expected pending getPageSnapshot after navigation, got ${JSON.stringify(navigateReport.task.plan)}.`);
  }

  const serverResult = await requestToolExecution(snapshotStep.toolCall);
  if (serverResult.status !== "queued") {
    throw new Error(`Expected queued getPageSnapshot, got ${serverResult.status}.`);
  }

  const snapshotResult = await executeBrowserTool(snapshotStep.toolCall);
  const snapshotReport = await reportToolResult(chat.taskId, {
    result: {
      ...snapshotResult,
      auditLogId: serverResult.auditLogId
    },
    stepId: snapshotStep.id,
    toolCallId: snapshotStep.toolCall.id
  });
  const continuation = snapshotReport.continuation?.message ?? "";

  if (!continuation.includes("\"Starter\"") || !continuation.includes("\"Pro\"")) {
    throw new Error(`Expected pricing JSON continuation, got ${continuation}`);
  }

  return {
    continuation,
    output: snapshotReport.task.output,
    taskStatus: snapshotReport.task.status
  };
}

async function runMemorySmoke(): Promise<Record<string, unknown>> {
  const content = "Remember that smoke tests prefer local providers.";
  const pending = await requestMemoryWrite(content, ["smoke", "preference"]);
  const beforeConfirm = await listMemories();

  if (beforeConfirm.some((memory) => memory.content === content)) {
    throw new Error("Memory was persisted before confirmation.");
  }

  const confirmed = await confirmMemoryWrite(pending.pending.token);
  const afterConfirm = await listMemories();
  const saved = afterConfirm.find((memory) => memory.id === confirmed.memory.id);

  if (!saved) {
    throw new Error("Confirmed memory was not returned by memory list.");
  }

  const deletedContent = "Delete this temporary smoke memory.";
  const deletePending = await requestMemoryWrite(deletedContent, ["smoke", "temporary"]);
  const deleteConfirmed = await confirmMemoryWrite(deletePending.pending.token);
  const deleteResult = await deleteMemory(deleteConfirmed.memory.id);
  const afterDelete = await listMemories();

  if (afterDelete.some((memory) => memory.id === deleteConfirmed.memory.id)) {
    throw new Error("Deleted memory was still returned by memory list.");
  }

  return {
    confirmedContent: confirmed.memory.content,
    deletedMemoryId: deleteResult.memoryId,
    deletedMissing: !afterDelete.some((memory) => memory.content === deletedContent),
    memoryCount: afterDelete.length,
    pendingStatus: pending.status,
    savedTags: saved.tags
  };
}

async function runProviderSmoke(
  tabId: number,
  snapshot: Awaited<ReturnType<typeof getPageSnapshot>>,
  providerUrl: string
): Promise<Record<string, unknown>> {
  const config = {
    apiKey: "fake-key",
    baseUrl: `${providerUrl}/v1`,
    model: "fake-model",
    type: "openai-compatible" as const
  };
  const saved = await updateProviderConfig(config);
  const testResult = await testProviderConfig(config);
  const health = await getHealth();

  if (!testResult.ok) {
    throw new Error(`Expected fake provider test to pass, got ${testResult.message}.`);
  }
  if (
    health.status !== "ok" ||
    health.provider.type !== "openai-compatible" ||
    health.providerSource !== "stored"
  ) {
    throw new Error(`Expected stored OpenAI-compatible health response, got ${JSON.stringify(health)}.`);
  }

  const chat = await sendChat({
    contextPolicy: "interactive-elements",
    message: "Summarize this page through the configured provider",
    pageSnapshot: snapshot,
    tabId
  });

  if (!chat.message.includes("Fake provider saw Open Agent Fixture and confirmed memory")) {
    throw new Error(`Expected fake provider chat response, got ${chat.message}.`);
  }

  return {
    chatMessage: chat.message,
    configSource: saved.source,
    configType: saved.config.type,
    healthSource: health.providerSource,
    healthStatus: health.status,
    healthType: health.provider.type,
    testMessage: testResult.message,
    testOk: testResult.ok
  };
}

async function runProviderToolPlanSmoke(
  tabId: number,
  snapshot: Awaited<ReturnType<typeof getPageSnapshot>>
): Promise<Record<string, unknown>> {
  const chat = await sendChat({
    contextPolicy: "interactive-elements",
    message: "Provider tool proposal smoke: extract main page text",
    pageSnapshot: snapshot,
    tabId
  });
  const proposedStep = chat.plan.find((step) => step.toolCall?.toolName === "extractText");

  if (!proposedStep?.toolCall) {
    throw new Error(`Expected provider-proposed extractText step, got ${JSON.stringify(chat)}.`);
  }
  if (proposedStep.status !== "pending") {
    throw new Error(`Expected provider-proposed extractText to be pending, got ${proposedStep.status}.`);
  }

  const serverResult = await requestToolExecution(proposedStep.toolCall);
  if (serverResult.status !== "queued") {
    throw new Error(`Expected queued provider-proposed extractText, got ${serverResult.status}.`);
  }

  const browserResult = await executeBrowserTool(proposedStep.toolCall);
  const report = await reportToolResult(chat.taskId, {
    result: {
      ...browserResult,
      auditLogId: serverResult.auditLogId
    },
    stepId: proposedStep.id,
    toolCallId: proposedStep.toolCall.id
  });
  const updatedStep = report.task.plan.find((step) => step.id === proposedStep.id);
  const text = (browserResult.result as { text?: string }).text ?? "";

  return {
    message: chat.message,
    serverStatus: serverResult.status,
    stepStatus: updatedStep?.status,
    taskStatus: report.task.status,
    textIncludesPageContent: text.includes("Open Agent Fixture") || text.includes("Pricing"),
    toolName: proposedStep.toolCall.toolName
  };
}

async function runProviderRiskReasonSmoke(
  tabId: number,
  snapshot: Awaited<ReturnType<typeof getPageSnapshot>>
): Promise<Record<string, unknown>> {
  const chat = await sendChat({
    contextPolicy: "interactive-elements",
    message: "Provider risky reason smoke: review provider delete proposal",
    pageSnapshot: snapshot,
    tabId
  });
  const approval = chat.approvalRequests.find((request) => request.toolCall.toolName === "click");

  if (!approval) {
    throw new Error(`Expected provider risky click approval, got ${JSON.stringify(chat)}.`);
  }
  if (
    approval.toolCall.args.selector !== "#delete-draft" ||
    approval.risk !== "high" ||
    !approval.reason.includes("sensitive page action") ||
    !approval.reason.includes("Provider note: This is safe and does not need review.")
  ) {
    throw new Error(`Expected local risk reason plus provider note, got ${JSON.stringify(approval)}.`);
  }

  return {
    hasLocalReason: approval.reason.includes("sensitive page action"),
    hasProviderNote: approval.reason.includes("Provider note: This is safe and does not need review."),
    risk: approval.risk,
    selector: approval.toolCall.args.selector
  };
}

async function runProviderContinuationSmoke(
  tabId: number,
  snapshot: Awaited<ReturnType<typeof getPageSnapshot>>
): Promise<Record<string, unknown>> {
  const chat = await sendChat({
    contextPolicy: "interactive-elements",
    message: "Provider continuation smoke: take a screenshot, then decide the next read action",
    pageSnapshot: snapshot,
    tabId
  });
  const screenshotStep = chat.plan.find((step) => step.toolCall?.toolName === "screenshot");

  if (!screenshotStep?.toolCall) {
    throw new Error(`Expected screenshot step for provider continuation seed, got ${JSON.stringify(chat)}.`);
  }

  const screenshotServerResult = await requestToolExecution(screenshotStep.toolCall);
  if (screenshotServerResult.status !== "queued") {
    throw new Error(`Expected queued screenshot for provider continuation, got ${screenshotServerResult.status}.`);
  }

  const screenshotResult = await executeBrowserTool(screenshotStep.toolCall);
  const screenshotReport = await reportToolResult(chat.taskId, {
    result: {
      ...screenshotResult,
      auditLogId: screenshotServerResult.auditLogId
    },
    stepId: screenshotStep.id,
    toolCallId: screenshotStep.toolCall.id
  });
  const proposedStep = screenshotReport.task.plan.find((step) => step.toolCall?.toolName === "extractText");

  if (!proposedStep?.toolCall) {
    throw new Error(`Expected provider continuation to append extractText, got ${JSON.stringify(screenshotReport)}.`);
  }

  const serverResult = await requestToolExecution(proposedStep.toolCall);
  if (serverResult.status !== "queued") {
    throw new Error(`Expected queued provider continuation extractText, got ${serverResult.status}.`);
  }

  const browserResult = await executeBrowserTool(proposedStep.toolCall);
  const report = await reportToolResult(screenshotReport.task.taskId, {
    result: {
      ...browserResult,
      auditLogId: serverResult.auditLogId
    },
    stepId: proposedStep.id,
    toolCallId: proposedStep.toolCall.id
  });
  const text = (browserResult.result as { text?: string }).text ?? "";

  return {
    continuationMessage: screenshotReport.continuation?.message,
    proposedStepStatus: proposedStep.status,
    serverStatus: serverResult.status,
    taskStatus: report.task.status,
    textIncludesPageContent: text.includes("Open Agent Fixture") || text.includes("Pricing"),
    toolName: proposedStep.toolCall.toolName
  };
}

async function runApprovalSmoke(tabId: number, agentUrl: string): Promise<Record<string, unknown>> {
  await chrome.storage.local.set({ agentBaseUrl: agentUrl });
  const snapshot = await getPageSnapshot(tabId);
  const name = "Smoke User";
  const email = "smoke-approved@example.test";
  const chat = await sendChat({
    contextPolicy: "interactive-elements",
    message: `Fill the form with name ${name} and email ${email}, then submit`,
    pageSnapshot: snapshot,
    tabId
  });
  const nameStep = chat.plan.find((step) =>
    step.toolCall?.toolName === "type" && String(step.toolCall.args.selector).includes("name")
  );
  const emailStep = chat.plan.find((step) =>
    step.toolCall?.toolName === "type" && String(step.toolCall.args.selector).includes("email")
  );
  const submitStep = chat.plan.find((step) => step.toolCall?.toolName === "click");

  if (!nameStep?.toolCall || !emailStep?.toolCall || !submitStep?.toolCall) {
    throw new Error(`Expected guarded name, email, and submit steps, got ${JSON.stringify(chat.plan)}.`);
  }

  const withoutToken = await requestToolExecution(submitStep.toolCall);
  if (withoutToken.status !== "requires_approval") {
    throw new Error(`Expected requires_approval without token, got ${withoutToken.status}.`);
  }

  const statusBeforeApproval = await readElementText(tabId, "#form-status");
  if (statusBeforeApproval !== "") {
    throw new Error(`Expected empty submit status before approval, got ${statusBeforeApproval}.`);
  }

  await approveAndRunStep(chat.taskId, nameStep, chat.approvalRequests);
  await approveAndRunStep(chat.taskId, emailStep, chat.approvalRequests);
  const nameAfterApproval = await readInputValue(tabId, "input[name=\"name\"]");
  const emailAfterApproval = await readInputValue(tabId, "input[name=\"email\"]");
  const statusBeforeSubmit = await readElementText(tabId, "#form-status");

  if (nameAfterApproval !== name) {
    throw new Error(`Expected approved name value ${name}, got ${nameAfterApproval}.`);
  }
  if (emailAfterApproval !== email) {
    throw new Error(`Expected approved email value ${email}, got ${emailAfterApproval}.`);
  }
  if (statusBeforeSubmit !== "") {
    throw new Error(`Expected form not submitted before submit approval, got ${statusBeforeSubmit}.`);
  }

  const submitReport = await approveAndRunStep(chat.taskId, submitStep, chat.approvalRequests);
  const task = submitReport.task;
  const submitStatus = await readElementText(tabId, "#form-status");
  const updatedStep = task.plan.find((step) => step.id === submitStep.id);

  if (!submitStatus.includes(name) || !submitStatus.includes(email) || !submitStatus.includes("submitted")) {
    throw new Error(`Expected approved form submission status, got ${submitStatus}.`);
  }

  return {
    approvedStatus: submitReport.approvedStatus,
    nameValue: nameAfterApproval,
    submitStatus,
    taskStatus: task.status,
    typedValue: emailAfterApproval,
    updatedStepStatus: updatedStep?.status,
    withoutTokenStatus: withoutToken.status
  };
}

async function approveAndRunStep(
  taskId: string,
  step: Awaited<ReturnType<typeof sendChat>>["plan"][number],
  approvals: Awaited<ReturnType<typeof sendChat>>["approvalRequests"]
): Promise<{ approvedStatus: string; task: Awaited<ReturnType<typeof reportToolResult>>["task"] }> {
  if (!step.toolCall) {
    throw new Error(`Expected tool call for step ${step.id}.`);
  }

  const approval = approvals.find((request) => request.toolCall.id === step.toolCall?.id);
  if (!approval) {
    throw new Error(`Missing approval for ${step.toolCall.toolName} ${step.toolCall.id}.`);
  }

  const approved = await requestToolExecution({
    ...approval.toolCall,
    confirmationToken: approval.token
  });
  if (approved.status !== "queued") {
    throw new Error(`Expected queued approved tool, got ${approved.status}.`);
  }

  const browserResult = await executeBrowserTool(approval.toolCall);
  const report = await reportToolResult(taskId, {
    result: {
      ...browserResult,
      auditLogId: approved.auditLogId
    },
    stepId: step.id,
    toolCallId: approval.toolCall.id
  });

  return {
    approvedStatus: approved.status,
    task: report.task
  };
}

async function findFixtureTab(fixtureUrl: string): Promise<chrome.tabs.Tab & { id: number }> {
  const tabs = await chrome.tabs.query({});
  const tab = tabs.find((candidate) => typeof candidate.id === "number" && candidate.url?.startsWith(fixtureUrl));

  if (!tab || typeof tab.id !== "number") {
    throw new Error(`Fixture tab not found for ${fixtureUrl}`);
  }

  return tab as chrome.tabs.Tab & { id: number };
}

function writeResult(status: "failed" | "success", body: unknown): void {
  resultElement.dataset.status = status;
  resultElement.textContent = JSON.stringify(body, null, 2);
}

async function readInputValue(tabId: number, selector: string): Promise<string> {
  const results = await chrome.scripting.executeScript({
    args: [selector],
    func: (targetSelector: string) => {
      const input = document.querySelector(targetSelector) as HTMLInputElement | HTMLTextAreaElement | null;
      return input?.value ?? "";
    },
    target: { tabId }
  });

  return results[0]?.result ?? "";
}

async function readElementText(tabId: number, selector: string): Promise<string> {
  const results = await chrome.scripting.executeScript({
    args: [selector],
    func: (targetSelector: string) => {
      const element = document.querySelector(targetSelector) as HTMLElement | null;
      return element?.textContent ?? "";
    },
    target: { tabId }
  });

  return results[0]?.result ?? "";
}

async function focusElement(tabId: number, selector: string): Promise<void> {
  await chrome.scripting.executeScript({
    args: [selector],
    func: (targetSelector: string) => {
      const element = document.querySelector(targetSelector) as HTMLElement | null;
      element?.focus();
    },
    target: { tabId }
  });
}

async function scrollToTop(tabId: number): Promise<void> {
  await chrome.scripting.executeScript({
    func: () => window.scrollTo({ left: 0, top: 0 }),
    target: { tabId }
  });
}

async function readScrollY(tabId: number): Promise<number> {
  const results = await chrome.scripting.executeScript({
    func: () => window.scrollY,
    target: { tabId }
  });

  return results[0]?.result ?? 0;
}

async function waitForScrollY(tabId: number): Promise<number> {
  const startedAt = Date.now();

  while (Date.now() - startedAt < 1500) {
    const scrollY = await readScrollY(tabId);
    if (scrollY > 0) {
      return scrollY;
    }

    await new Promise((resolve) => window.setTimeout(resolve, 50));
  }

  return readScrollY(tabId);
}

async function waitForSocketOpen(socket: WebSocket): Promise<void> {
  if (socket.readyState === WebSocket.OPEN) {
    return;
  }

  await new Promise<void>((resolve, reject) => {
    const timeout = window.setTimeout(() => reject(new Error("Timed out opening local event stream.")), 5000);
    socket.addEventListener("open", () => {
      window.clearTimeout(timeout);
      resolve();
    }, { once: true });
    socket.addEventListener("error", () => {
      window.clearTimeout(timeout);
      reject(new Error("Failed to open local event stream."));
    }, { once: true });
  });
}

async function waitForRealtimeMessage(
  messages: unknown[],
  predicate: (message: unknown) => boolean
): Promise<unknown> {
  const startedAt = Date.now();

  while (Date.now() - startedAt < 5000) {
    const found = messages.find(predicate);
    if (found) {
      return found;
    }

    await new Promise((resolve) => window.setTimeout(resolve, 25));
  }

  throw new Error(`Timed out waiting for local event stream message. Received: ${JSON.stringify(messages)}`);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
