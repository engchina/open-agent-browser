import { createServer, type IncomingMessage, type Server } from "node:http";
import { existsSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { chromium, type BrowserContext, type Page } from "playwright-core";
import { ApprovalRegistry } from "../packages/agent-server/src/approval.js";
import { AuditLog } from "../packages/agent-server/src/audit.js";
import { SqliteMemoryStore } from "../packages/agent-server/src/memory.js";
import { PageSnapshotStore } from "../packages/agent-server/src/pageSnapshotStore.js";
import { createAgentServer } from "../packages/agent-server/src/server.js";
import { openSqliteDatabase } from "../packages/agent-server/src/sqlite.js";
import { ProviderConfigStore } from "../packages/agent-server/src/providerStore.js";
import { TaskStore } from "../packages/agent-server/src/taskStore.js";
import { resolveBrowserExecutable } from "../packages/browser/src/index.js";

const root = process.cwd();
const extensionDirectory = resolve(root, "packages/extension/.output/chrome-mv3");

interface ListedTask {
  message: string;
  plan: Array<{
    status: string;
    toolCall?: {
      toolName?: string;
    };
  }>;
  results: Array<{
    result: {
      error?: string;
      status?: string;
      toolName?: string;
    };
  }>;
  status: string;
  taskId: string;
}

if (!existsSync(extensionDirectory)) {
  throw new Error(`Extension output is missing: ${extensionDirectory}. Run pnpm --filter @open-agent-browser/extension build first.`);
}

const extensionManifestSmoke = readExtensionManifestSmoke();
if (
  extensionManifestSmoke.contextMenusPermission !== true ||
  extensionManifestSmoke.omniboxKeyword !== "agent" ||
  !Array.isArray(extensionManifestSmoke.commands) ||
  !extensionManifestSmoke.commands.includes("open-agent-browser.open-panel") ||
  !extensionManifestSmoke.commands.includes("open-agent-browser.summarize-page")
) {
  throw new Error(`Expected extension manifest browser entry points, got ${JSON.stringify(extensionManifestSmoke)}`);
}

const database = await openSqliteDatabase(":memory:");
const memory = new SqliteMemoryStore(database);
const agentServer = createAgentServer({
  context: {
    approvals: new ApprovalRegistry(),
    auditLog: new AuditLog(database),
    memory,
    pageSnapshots: new PageSnapshotStore(database),
    providerConfigStore: new ProviderConfigStore(database),
    taskStore: new TaskStore(database)
  }
});
const fixtureServer = createFixtureServer();
const fakeProviderServer = createFakeProviderServer();
const userDataDir = join(tmpdir(), `open-agent-browser-e2e-${Date.now()}`);
let context: Awaited<ReturnType<typeof chromium.launchPersistentContext>> | undefined;

try {
  const agentUrl = await listen(agentServer);
  const fixtureUrl = await listen(fixtureServer);
  const providerUrl = await listen(fakeProviderServer);
  const executablePath = resolveBrowserExecutable();

  context = await chromium.launchPersistentContext(userDataDir, {
    acceptDownloads: true,
    args: [
      "--disable-features=DisableLoadExtensionCommandLineSwitch",
      `--disable-extensions-except=${extensionDirectory}`,
      `--load-extension=${extensionDirectory}`,
      "--no-first-run",
      "--no-default-browser-check"
    ],
    downloadsPath: join(userDataDir, "downloads"),
    executablePath,
    headless: process.env.OAB_E2E_HEADLESS === "1"
  });

  const extensionId = await resolveExtensionId(context);
  const fixturePage = await context.newPage();
  await fixturePage.goto(fixtureUrl, { waitUntil: "domcontentloaded" });
  const browserOriginSecurity = await runBrowserOriginSecuritySmoke(fixturePage, agentUrl);

  const smokePage = await context.newPage();
  await smokePage.goto(
    `chrome-extension://${extensionId}/smoke.html?fixtureUrl=${encodeURIComponent(fixtureUrl)}&agentUrl=${encodeURIComponent(agentUrl)}&providerUrl=${encodeURIComponent(providerUrl)}`,
    { waitUntil: "domcontentloaded" }
  );
  const resultLocator = smokePage.locator("#result");
  await resultLocator.waitFor({ state: "visible", timeout: 15000 });
  await smokePage.waitForFunction(() => {
    const element = document.querySelector("#result") as HTMLElement | null;
    return element?.dataset.status === "success" || element?.dataset.status === "failed";
  }, undefined, { timeout: 60000 });

  const status = await resultLocator.getAttribute("data-status");
  const text = await resultLocator.textContent();
  if (status !== "success") {
    throw new Error(`Extension smoke failed: ${text}`);
  }

  const result = JSON.parse(text ?? "{}") as {
    agentHealth?: {
      providerSource?: string;
      providerType?: string;
      status?: string;
    };
    accessibleLabelSmoke?: {
      label?: string;
      selector?: string;
      text?: string;
    };
    approvalSmoke?: {
      approvedStatus?: string;
      nameValue?: string;
      submitStatus?: string;
      taskStatus?: string;
      typedValue?: string;
      updatedStepStatus?: string;
      withoutTokenStatus?: string;
    };
    approvalPageDriftSmoke?: {
      approvedStatus?: string;
      error?: string;
      withoutTokenStatus?: string;
    };
    auditEventCount?: number;
    browserControlSmoke?: {
      keyStatus?: string;
      pressApprovedStatus?: string;
      pressStepStatus?: string;
      pressWithoutTokenStatus?: string;
      screenshotFullPage?: boolean;
      screenshotPrefix?: string;
      screenshotStoredDataUrl?: string;
      screenshotStoredMimeType?: string;
      screenshotStoredRedacted?: boolean;
      screenshotStepStatus?: string;
      scrollY?: number;
      taskStatus?: string;
    };
    controlledInputSmoke?: {
      approvedStatus?: string;
      browserStatus?: string;
      domValue?: string;
      observedValue?: string;
      withoutTokenStatus?: string;
    };
    downloadToolSmoke?: {
      approvedStatus?: string;
      browserStatus?: string;
      downloadId?: number;
      state?: string;
      urlMatches?: boolean;
      withoutTokenStatus?: string;
    };
    crossSiteNavigationApprovalSmoke?: {
      risk?: string;
      sourceUrl?: string;
      targetUrl?: string;
    };
    fixtureTabId?: number;
    historyTaskCount?: number;
    historyTaskDetail?: {
      artifactCount?: number;
      resultCount?: number;
      status?: string;
      taskId?: string;
    };
    linkCount?: number;
    linkContinuation?: string;
    linkOutput?: string;
    memorySmoke?: {
      confirmedContent?: string;
      deletedMemoryId?: string;
      deletedMissing?: boolean;
      memoryCount?: number;
      pendingStatus?: string;
      savedTags?: string[];
    };
    navigationLinkSmoke?: {
      afterStatus?: string;
      approvedStatus?: string;
      beforeStatus?: string;
    };
    ollamaProviderSmoke?: {
      chatMessage?: string;
      configSource?: string;
      configType?: string;
      healthSource?: string;
      healthStatus?: string;
      healthType?: string;
      testOk?: boolean;
    };
    providerSmoke?: {
      chatMessage?: string;
      configSource?: string;
      configType?: string;
      healthSource?: string;
      healthStatus?: string;
      healthType?: string;
      testOk?: boolean;
    };
    providerContinuationSmoke?: {
      continuationMessage?: string;
      proposedStepStatus?: string;
      serverStatus?: string;
      taskStatus?: string;
      textIncludesPageContent?: boolean;
      toolName?: string;
    };
    providerRiskReasonSmoke?: {
      hasLocalReason?: boolean;
      hasProviderNote?: boolean;
      risk?: string;
      selector?: string;
    };
    providerToolPlanSmoke?: {
      message?: string;
      serverStatus?: string;
      stepStatus?: string;
      taskStatus?: string;
      textIncludesPageContent?: boolean;
      toolName?: string;
    };
    pricingSmoke?: {
      continuation?: string;
      output?: string;
      taskStatus?: string;
    };
    providerSource?: string;
    providerType?: string;
    rejectionSmoke?: {
      emailAfterReject?: string;
      rejectedStatus?: string;
      stepStatus?: string;
      taskStatus?: string;
    };
    snapshotBridge?: {
      linkCount?: number;
      publishedTitle?: string;
      readTitle?: string;
    };
    snapshotClearSmoke?: {
      cleared?: number;
      missingAfterClear?: boolean;
      restoredTitle?: string;
    };
    snapshotRedactionSmoke?: {
      hasRawBearer?: boolean;
      hasRawEmail?: boolean;
      hasRawToken?: boolean;
      resetHref?: string;
      resetText?: string;
    };
    snapshotTitle?: string;
    scopedSnapshotSmoke?: {
      hasAnchors?: boolean;
      hasButtons?: boolean;
      hasInputs?: boolean;
      linkCount?: number;
      serverStatus?: string;
    };
    semanticClickSmoke?: {
      browserStatus?: string;
      reason?: string;
      risk?: string;
      selector?: string;
      serverStatus?: string;
      status?: string;
    };
    selectorSmoke?: {
      browserStatus?: string;
      selector?: string;
      serverStatus?: string;
      status?: string;
    };
    structuredSnapshotSmoke?: {
      firstHeading?: string;
      firstHeadingLevel?: number;
      tableHeaders?: string[];
      tableRows?: number;
      tableSelector?: string;
    };
    tabToolSmoke?: {
      activatedTabId?: number;
      activateServerStatus?: string;
      closedTabMissing?: boolean;
      closeServerStatus?: string;
      fixtureListed?: boolean;
      listServerStatus?: string;
      openedTabId?: number;
      openServerStatus?: string;
      tabCount?: number;
    };
    taskStatus?: string;
    toolResultBindingSmoke?: {
      reasons?: string[];
      rejected?: boolean;
    };
    updatedStepStatus?: string;
    visibilityGuardSmoke?: {
      error?: string;
      hiddenOmitted?: boolean;
      statusUnchanged?: boolean;
    };
  };

  if (result.snapshotTitle !== "Open Agent Fixture") {
    throw new Error(`Unexpected snapshot title: ${result.snapshotTitle}`);
  }
  if (
    result.snapshotBridge?.publishedTitle !== "Open Agent Fixture" ||
    result.snapshotBridge.readTitle !== "Open Agent Fixture" ||
    (result.snapshotBridge.linkCount ?? 0) < 1
  ) {
    throw new Error(`Expected published snapshot bridge, got ${JSON.stringify(result.snapshotBridge)}`);
  }
  if (
    (result.snapshotClearSmoke?.cleared ?? 0) < 1 ||
    result.snapshotClearSmoke?.missingAfterClear !== true ||
    result.snapshotClearSmoke.restoredTitle !== "Open Agent Fixture"
  ) {
    throw new Error(`Expected snapshot clear smoke to clear and restore context, got ${JSON.stringify(result.snapshotClearSmoke)}`);
  }
  if (
    result.snapshotRedactionSmoke?.hasRawBearer !== false ||
    result.snapshotRedactionSmoke.hasRawEmail !== false ||
    result.snapshotRedactionSmoke.hasRawToken !== false ||
    !result.snapshotRedactionSmoke.resetHref?.includes("token=%5Bredacted%5D") ||
    !result.snapshotRedactionSmoke.resetText?.includes("[redacted]")
  ) {
    throw new Error(`Expected snapshot sensitive text and URL redaction, got ${JSON.stringify(result.snapshotRedactionSmoke)}`);
  }
  if (
    result.scopedSnapshotSmoke?.serverStatus !== "queued" ||
    result.scopedSnapshotSmoke.linkCount !== 0 ||
    result.scopedSnapshotSmoke.hasInputs !== false ||
    result.scopedSnapshotSmoke.hasAnchors !== false ||
    result.scopedSnapshotSmoke.hasButtons !== true
  ) {
    throw new Error(`Expected scoped getPageSnapshot to omit links and inputs, got ${JSON.stringify(result.scopedSnapshotSmoke)}`);
  }
  if (
    result.accessibleLabelSmoke?.label !== "Billing Email" ||
    result.accessibleLabelSmoke.selector !== "#billing-field"
  ) {
    throw new Error(`Expected accessible label snapshot capture, got ${JSON.stringify(result.accessibleLabelSmoke)}`);
  }
  if (
    result.structuredSnapshotSmoke?.firstHeading !== "Open Agent Fixture" ||
    result.structuredSnapshotSmoke.firstHeadingLevel !== 1 ||
    !result.structuredSnapshotSmoke.tableHeaders?.includes("Feature") ||
    (result.structuredSnapshotSmoke.tableRows ?? 0) < 1
  ) {
    throw new Error(`Expected structured snapshot capture, got ${JSON.stringify(result.structuredSnapshotSmoke)}`);
  }
  if (
    result.selectorSmoke?.serverStatus !== "queued" ||
    result.selectorSmoke.browserStatus !== "completed" ||
    result.selectorSmoke.status !== "anonymous-clicked" ||
    !result.selectorSmoke.selector?.includes("#selector-lab")
  ) {
    throw new Error(`Expected stable snapshot selector click, got ${JSON.stringify(result.selectorSmoke)}`);
  }
  if (
    result.semanticClickSmoke?.serverStatus !== "queued" ||
    result.semanticClickSmoke.browserStatus !== "completed" ||
    result.semanticClickSmoke.selector !== "#delete-draft" ||
    result.semanticClickSmoke.risk !== "high" ||
    result.semanticClickSmoke.status !== "delete-clicked" ||
    !result.semanticClickSmoke.reason?.includes("sensitive page control")
  ) {
    throw new Error(`Expected semantic high-risk click planning and execution, got ${JSON.stringify(result.semanticClickSmoke)}`);
  }
  if (
    result.visibilityGuardSmoke?.hiddenOmitted !== true ||
    result.visibilityGuardSmoke.statusUnchanged !== true ||
    !result.visibilityGuardSmoke.error?.includes("not visible")
  ) {
    throw new Error(`Expected hidden snapshot action to be omitted and blocked, got ${JSON.stringify(result.visibilityGuardSmoke)}`);
  }
  if (
    result.tabToolSmoke?.listServerStatus !== "queued" ||
    result.tabToolSmoke.activateServerStatus !== "queued" ||
    result.tabToolSmoke.openServerStatus !== "queued" ||
    result.tabToolSmoke.closeServerStatus !== "queued" ||
    result.tabToolSmoke.fixtureListed !== true ||
    result.tabToolSmoke.closedTabMissing !== true ||
    result.tabToolSmoke.activatedTabId !== result.fixtureTabId
  ) {
    throw new Error(`Expected tab list and activation tools to work, got ${JSON.stringify(result.tabToolSmoke)}`);
  }
  if ((result.linkCount ?? 0) < 1) {
    throw new Error("Expected at least one extracted link.");
  }
  if (!result.linkContinuation?.includes("\"Pricing\"") || !result.linkOutput?.includes("\"href\"")) {
    throw new Error(`Expected link extraction continuation output, got ${JSON.stringify({
      linkContinuation: result.linkContinuation,
      linkOutput: result.linkOutput
    })}`);
  }
  if (result.taskStatus !== "completed" || result.updatedStepStatus !== "completed") {
    throw new Error(`Expected completed task, got ${JSON.stringify(result)}`);
  }
  if (
    result.toolResultBindingSmoke?.rejected !== true ||
    !result.toolResultBindingSmoke.reasons?.includes("toolName") ||
    !result.toolResultBindingSmoke.reasons.includes("status")
  ) {
    throw new Error(`Expected mismatched tool result report rejection, got ${JSON.stringify(result.toolResultBindingSmoke)}`);
  }
  if (
    result.approvalSmoke?.withoutTokenStatus !== "requires_approval" ||
    result.approvalSmoke.approvedStatus !== "queued" ||
    result.approvalSmoke.nameValue !== "Smoke User" ||
    result.approvalSmoke.typedValue !== "smoke-approved@example.test" ||
    !result.approvalSmoke.submitStatus?.includes("submitted") ||
    result.approvalSmoke.taskStatus !== "completed" ||
    result.approvalSmoke.updatedStepStatus !== "completed"
  ) {
    throw new Error(`Expected approved form typing flow, got ${JSON.stringify(result.approvalSmoke)}`);
  }
  if (
    result.approvalPageDriftSmoke?.withoutTokenStatus !== "requires_approval" ||
    result.approvalPageDriftSmoke.approvedStatus !== "queued" ||
    !result.approvalPageDriftSmoke.error?.includes("Page changed after approval")
  ) {
    throw new Error(`Expected approval page drift guard, got ${JSON.stringify(result.approvalPageDriftSmoke)}`);
  }
  if (
    result.browserControlSmoke?.pressWithoutTokenStatus !== "requires_approval" ||
    result.browserControlSmoke.pressApprovedStatus !== "queued" ||
    result.browserControlSmoke.pressStepStatus !== "completed" ||
    result.browserControlSmoke.screenshotStepStatus !== "completed" ||
    result.browserControlSmoke.screenshotFullPage !== true ||
    result.browserControlSmoke.keyStatus !== "Enter" ||
    !result.browserControlSmoke.screenshotPrefix?.startsWith("data:image/png;base64") ||
    result.browserControlSmoke.screenshotStoredDataUrl !== "[redacted]" ||
    result.browserControlSmoke.screenshotStoredMimeType !== "image/png" ||
    result.browserControlSmoke.screenshotStoredRedacted !== true ||
    (result.browserControlSmoke.scrollY ?? 0) <= 0 ||
    result.browserControlSmoke.taskStatus !== "completed"
  ) {
    throw new Error(`Expected scroll, press, and screenshot browser controls, got ${JSON.stringify(result.browserControlSmoke)}`);
  }
  if (
    result.controlledInputSmoke?.withoutTokenStatus !== "requires_approval" ||
    result.controlledInputSmoke.approvedStatus !== "queued" ||
    result.controlledInputSmoke.browserStatus !== "completed" ||
    result.controlledInputSmoke.domValue !== "controlled@example.test" ||
    result.controlledInputSmoke.observedValue !== "controlled@example.test"
  ) {
    throw new Error(`Expected controlled input typing flow, got ${JSON.stringify(result.controlledInputSmoke)}`);
  }
  if (
    result.downloadToolSmoke?.withoutTokenStatus !== "requires_approval" ||
    result.downloadToolSmoke.approvedStatus !== "queued" ||
    result.downloadToolSmoke.browserStatus !== "completed" ||
    typeof result.downloadToolSmoke.downloadId !== "number" ||
    result.downloadToolSmoke.urlMatches !== true
  ) {
    throw new Error(`Expected approval-gated download tool flow, got ${JSON.stringify(result.downloadToolSmoke)}`);
  }
  if (
    result.rejectionSmoke?.rejectedStatus !== "rejected" ||
    result.rejectionSmoke.stepStatus !== "failed" ||
    result.rejectionSmoke.taskStatus !== "failed" ||
    result.rejectionSmoke.emailAfterReject === "rejected@example.test"
  ) {
    throw new Error(`Expected explicit approval rejection flow, got ${JSON.stringify(result.rejectionSmoke)}`);
  }
  if ((result.historyTaskCount ?? 0) < 2 || (result.auditEventCount ?? 0) < 4) {
    throw new Error(`Expected persisted history and audit events, got ${JSON.stringify(result)}`);
  }
  if (
    result.historyTaskDetail?.status !== "completed" ||
    (result.historyTaskDetail.artifactCount ?? 0) < 1 ||
    (result.historyTaskDetail.resultCount ?? 0) < 1
  ) {
    throw new Error(`Expected fetchable task detail, got ${JSON.stringify(result.historyTaskDetail)}`);
  }
  if (
    result.memorySmoke?.pendingStatus !== "requires_approval" ||
    result.memorySmoke.confirmedContent !== "Remember that smoke tests prefer local providers." ||
    result.memorySmoke.deletedMissing !== true ||
    typeof result.memorySmoke.deletedMemoryId !== "string" ||
    (result.memorySmoke.memoryCount ?? 0) < 1 ||
    !result.memorySmoke.savedTags?.includes("smoke")
  ) {
    throw new Error(`Expected confirmed local memory flow, got ${JSON.stringify(result.memorySmoke)}`);
  }
  if (result.providerType !== "disabled" || result.providerSource !== "stored") {
    throw new Error(`Expected stored disabled provider config, got ${JSON.stringify(result)}`);
  }
  if (
    result.agentHealth?.status !== "ok" ||
    result.agentHealth.providerType !== "disabled" ||
    result.agentHealth.providerSource !== "stored"
  ) {
    throw new Error(`Expected stored disabled agent health, got ${JSON.stringify(result.agentHealth)}`);
  }
  if (
    result.pricingSmoke?.taskStatus !== "completed" ||
    !result.pricingSmoke.continuation?.includes("\"Starter\"") ||
    !result.pricingSmoke.output?.includes("\"Pro\"")
  ) {
    throw new Error(`Expected pricing JSON continuation, got ${JSON.stringify(result.pricingSmoke)}`);
  }
  if (
    result.navigationLinkSmoke?.approvedStatus !== "queued" ||
    result.navigationLinkSmoke.beforeStatus !== "blocked" ||
    result.navigationLinkSmoke.afterStatus !== "pending"
  ) {
    throw new Error(`Expected navigation-gated link extraction, got ${JSON.stringify(result.navigationLinkSmoke)}`);
  }
  if (
    result.crossSiteNavigationApprovalSmoke?.risk !== "high" ||
    !result.crossSiteNavigationApprovalSmoke.sourceUrl?.startsWith(fixtureUrl) ||
    result.crossSiteNavigationApprovalSmoke.targetUrl !== "https://cross-site.example/docs"
  ) {
    throw new Error(`Expected cross-site navigation approval context, got ${JSON.stringify(result.crossSiteNavigationApprovalSmoke)}`);
  }
  if (
    result.providerSmoke?.testOk !== true ||
    result.providerSmoke.configType !== "openai-compatible" ||
    result.providerSmoke.configSource !== "stored" ||
    result.providerSmoke.healthStatus !== "ok" ||
    result.providerSmoke.healthType !== "openai-compatible" ||
    result.providerSmoke.healthSource !== "stored" ||
    !result.providerSmoke.chatMessage?.includes("Fake provider saw Open Agent Fixture and confirmed memory")
  ) {
    throw new Error(`Expected fake provider chat flow, got ${JSON.stringify(result.providerSmoke)}`);
  }
  if (
    result.providerToolPlanSmoke?.message !== "Fake provider proposed extractText" ||
    result.providerToolPlanSmoke.toolName !== "extractText" ||
    result.providerToolPlanSmoke.serverStatus !== "queued" ||
    result.providerToolPlanSmoke.stepStatus !== "completed" ||
    result.providerToolPlanSmoke.taskStatus !== "completed" ||
    result.providerToolPlanSmoke.textIncludesPageContent !== true
  ) {
    throw new Error(`Expected provider-proposed tool plan flow, got ${JSON.stringify(result.providerToolPlanSmoke)}`);
  }
  if (
    result.providerRiskReasonSmoke?.selector !== "#delete-draft" ||
    result.providerRiskReasonSmoke.risk !== "high" ||
    result.providerRiskReasonSmoke.hasLocalReason !== true ||
    result.providerRiskReasonSmoke.hasProviderNote !== true
  ) {
    throw new Error(`Expected provider risk reason hardening, got ${JSON.stringify(result.providerRiskReasonSmoke)}`);
  }
  if (
    result.providerContinuationSmoke?.continuationMessage !== "Fake provider continued after observation" ||
    result.providerContinuationSmoke.toolName !== "extractText" ||
    result.providerContinuationSmoke.proposedStepStatus !== "pending" ||
    result.providerContinuationSmoke.serverStatus !== "queued" ||
    result.providerContinuationSmoke.taskStatus !== "completed" ||
    result.providerContinuationSmoke.textIncludesPageContent !== true
  ) {
    throw new Error(`Expected provider continuation flow after tool result, got ${JSON.stringify(result.providerContinuationSmoke)}`);
  }
  if (
    result.ollamaProviderSmoke?.testOk !== true ||
    result.ollamaProviderSmoke.configType !== "ollama" ||
    result.ollamaProviderSmoke.configSource !== "stored" ||
    result.ollamaProviderSmoke.healthStatus !== "ok" ||
    result.ollamaProviderSmoke.healthType !== "ollama" ||
    result.ollamaProviderSmoke.healthSource !== "stored" ||
    !result.ollamaProviderSmoke.chatMessage?.includes("Fake Ollama saw Open Agent Fixture and confirmed memory")
  ) {
    throw new Error(`Expected fake Ollama provider chat flow, got ${JSON.stringify(result.ollamaProviderSmoke)}`);
  }

  await runSidePanelHistorySmoke(extensionId, result.historyTaskDetail.taskId);
  const sidePanelApprovalDetails = await runSidePanelApprovalDetailsSmoke(
    extensionId,
    result.fixtureTabId,
    fixtureUrl
  );
  if (
    sidePanelApprovalDetails.emailVisible !== true ||
    sidePanelApprovalDetails.expiresVisible !== true ||
    sidePanelApprovalDetails.nameVisible !== true ||
    sidePanelApprovalDetails.riskVisible !== true ||
    sidePanelApprovalDetails.selectorVisible !== true ||
    sidePanelApprovalDetails.targetDescriptionVisible !== true ||
    sidePanelApprovalDetails.titleVisible !== true
  ) {
    throw new Error(`Expected side panel approval details, got ${JSON.stringify(sidePanelApprovalDetails)}`);
  }
  const sidePanelAutoContinuation = await runSidePanelAutoContinuationSmoke(
    extensionId,
    result.fixtureTabId,
    agentUrl,
    providerUrl
  );
  const sidePanelToolError = await runSidePanelToolErrorSmoke(
    extensionId,
    result.fixtureTabId,
    agentUrl,
    providerUrl
  );
  if (
    sidePanelToolError.taskStatus !== "failed" ||
    sidePanelToolError.stepStatus !== "failed" ||
    sidePanelToolError.resultStatus !== "error" ||
    !sidePanelToolError.error?.includes("Element not found: #missing-smoke-target")
  ) {
    throw new Error(`Expected side panel tool errors to persist in task history, got ${JSON.stringify(sidePanelToolError)}`);
  }
  const sidePanelChat = await runSidePanelChatSmoke(extensionId, result.fixtureTabId);
  const sidePanelCancel = await runSidePanelCancelSmoke(extensionId, result.fixtureTabId, agentUrl);
  if (
    sidePanelCancel.canceledVisible !== true ||
    sidePanelCancel.globalStopCleared !== true ||
    sidePanelCancel.globalStopVisible !== true ||
    sidePanelCancel.historyVisible !== true
  ) {
    throw new Error(`Expected side panel cancel controls, got ${JSON.stringify(sidePanelCancel)}`);
  }
  const newTab = await runNewTabSmoke(extensionId);
  if (
    newTab.connected !== true ||
    newTab.draftPrefilled !== true ||
    newTab.endpointVisible !== true ||
    newTab.openSidePanelVisible !== true ||
    newTab.providerVisible !== true
  ) {
    throw new Error(`Expected new tab launch panel, got ${JSON.stringify(newTab)}`);
  }

  console.log(JSON.stringify({
    browserOriginSecurity,
    extensionManifestSmoke,
    fixtureUrl,
    newTab,
    result,
    sidePanelApprovalDetails,
    sidePanelAutoContinuation,
    sidePanelCancel,
    sidePanelChat,
    sidePanelToolError,
    status: "ok"
  }, null, 2));
} finally {
  await context?.close();
  await closeServer(agentServer);
  await closeServer(fixtureServer);
  await closeServer(fakeProviderServer);
  database.close();
  await removeDirectoryBestEffort(userDataDir);
}

async function resolveExtensionId(context: BrowserContext): Promise<string> {
  const existingWorker = context.serviceWorkers()[0];
  if (existingWorker) {
    return new URL(existingWorker.url()).host;
  }

  const newTabPage = await context.newPage();
  try {
    await newTabPage.goto("chrome://newtab/", { waitUntil: "domcontentloaded", timeout: 30000 });
    const url = newTabPage.url();
    if (url.startsWith("chrome-extension://")) {
      return new URL(url).host;
    }
  } finally {
    await newTabPage.close().catch(() => undefined);
  }

  const serviceWorker = context.serviceWorkers()[0] ?? await context.waitForEvent("serviceworker", { timeout: 30000 });
  return new URL(serviceWorker.url()).host;
}

async function runBrowserOriginSecuritySmoke(page: Page, agentUrl: string): Promise<Record<string, unknown>> {
  const result = await page.evaluate(async (baseUrl) => {
    try {
      await fetch(`${baseUrl}/v1/tasks`, {
        method: "GET"
      });
      return { blocked: false };
    } catch (error) {
      return {
        blocked: true,
        errorName: error instanceof Error ? error.name : String(error)
      };
    }
  }, agentUrl);

  if (!result.blocked) {
    throw new Error("Expected ordinary web page origin to be blocked from local agent API.");
  }

  return result;
}

function readExtensionManifestSmoke(): Record<string, unknown> {
  const manifestPath = join(extensionDirectory, "manifest.json");
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as {
    commands?: Record<string, {
      description?: string;
      suggested_key?: Record<string, string>;
    }>;
    omnibox?: {
      keyword?: string;
    };
    permissions?: string[];
  };
  const permissions = manifest.permissions ?? [];
  if (!permissions.includes("contextMenus")) {
    throw new Error("Expected extension manifest to include contextMenus permission.");
  }
  if (!manifest.commands?.["open-agent-browser.open-panel"] || !manifest.commands["open-agent-browser.summarize-page"]) {
    throw new Error("Expected extension manifest to include Open Agent browser commands.");
  }

  return {
    commands: Object.keys(manifest.commands).sort(),
    contextMenusPermission: true,
    omniboxKeyword: manifest.omnibox?.keyword
  };
}

async function runNewTabSmoke(extensionId: string): Promise<Record<string, unknown>> {
  if (!context) {
    throw new Error("Expected browser context for new tab smoke.");
  }

  const page = await context.newPage();
  await page.goto(`chrome-extension://${extensionId}/newtab.html`, { waitUntil: "domcontentloaded" });
  await page.locator(".status-band[data-state='connected']").waitFor({ state: "visible", timeout: 10000 });
  await page.getByRole("button", { name: /Refresh/ }).click();
  await page.locator(".status-band[data-state='connected']").waitFor({ state: "visible", timeout: 10000 });

  const bodyText = await page.textContent("body");
  const openSidePanelVisible = await page.getByRole("button", { name: /Open Side Panel/ }).isVisible();
  const draftMessage = "Open https://example.test and summarize the visible page";
  await page.evaluate((message) => {
    return chrome.storage.local.set({
      "openAgentBrowser.launchDraft": {
        createdAt: new Date().toISOString(),
        message
      }
    });
  }, draftMessage);
  const sidePanelPage = await context.newPage();
  await sidePanelPage.goto(`chrome-extension://${extensionId}/sidepanel.html`, { waitUntil: "domcontentloaded" });
  await expectInputValue(sidePanelPage, /^Task$/, draftMessage);
  await sidePanelPage.close();

  await page.getByRole("textbox", { name: /^Task$/ }).fill(draftMessage);
  await page.getByRole("button", { name: /^Start$/ }).click();
  await page.getByText(/Side panel requested/).waitFor({ state: "visible", timeout: 10000 });
  await page.close();

  return {
    connected: bodyText?.includes("Connected") ?? false,
    draftPrefilled: true,
    endpointVisible: bodyText?.includes("http://127.0.0.1:") ?? false,
    openSidePanelVisible,
    providerVisible: bodyText?.includes("Provider") ?? false
  };
}

async function expectInputValue(page: Page, name: RegExp, expected: string): Promise<void> {
  const input = page.getByRole("textbox", { name });
  await input.waitFor({ state: "visible", timeout: 10000 });
  for (let attempt = 0; attempt < 20; attempt += 1) {
    if (await input.inputValue() === expected) {
      return;
    }
    await page.waitForTimeout(100);
  }

  throw new Error(`Expected textbox ${name} to contain ${expected}, got ${await input.inputValue()}.`);
}

async function runSidePanelHistorySmoke(extensionId: string, taskId?: string): Promise<void> {
  if (!context || !taskId) {
    throw new Error(`Expected browser context and task ID for side panel history smoke, got ${taskId}.`);
  }

  const sidePanelPage = await context.newPage();
  await sidePanelPage.goto(`chrome-extension://${extensionId}/sidepanel.html`, { waitUntil: "domcontentloaded" });
  await sidePanelPage.getByRole("button", { name: /History/ }).click();
  const targetTask = sidePanelPage.locator(".history-item").filter({ hasText: taskId.slice(0, 8) }).first();
  await targetTask.waitFor({ state: "visible", timeout: 10000 });
  await targetTask.getByRole("button", { name: /Details/ }).click();
  await sidePanelPage.locator(".task-detail").waitFor({ state: "visible", timeout: 10000 });
  const linkArtifact = sidePanelPage.locator(".artifact-card").filter({ hasText: "Extracted links" }).first();
  await linkArtifact.waitFor({ state: "visible", timeout: 10000 });
  const detailText = await sidePanelPage.locator(".task-detail").textContent();

  if (!detailText?.includes(taskId) || !detailText.includes("Artifacts") || !detailText.includes("Extracted links")) {
    throw new Error(`Expected side panel task detail for ${taskId}, got ${detailText}.`);
  }

  await linkArtifact.getByRole("button", { name: /Delete/ }).click();
  await linkArtifact.waitFor({ state: "detached", timeout: 10000 });
  await targetTask.getByRole("button", { name: /Delete/ }).click();
  await targetTask.waitFor({ state: "detached", timeout: 10000 });

  await sidePanelPage.close();
}

async function runSidePanelChatSmoke(extensionId: string, fixtureTabId?: number): Promise<Record<string, unknown>> {
  if (!context || typeof fixtureTabId !== "number") {
    throw new Error(`Expected browser context and fixture tab ID for side panel chat smoke, got ${fixtureTabId}.`);
  }

  const sidePanelPage = await context.newPage();
  await sidePanelPage.goto(`chrome-extension://${extensionId}/sidepanel.html?tabId=${fixtureTabId}`, { waitUntil: "domcontentloaded" });
  await sidePanelPage.locator(".agent-status[data-state='connected']").waitFor({ state: "visible", timeout: 10000 });
  await sidePanelPage.getByRole("textbox", { name: /^Task$/ }).fill("Extract links from this page");
  await sidePanelPage.getByRole("button", { name: /Send task/ }).click();
  await sidePanelPage.getByText(/extractLinks completed/).waitFor({ state: "visible", timeout: 15000 });
  await sidePanelPage.getByRole("button", { name: /History/ }).click();
  await sidePanelPage.locator(".history-item").filter({ hasText: "completed" }).first().waitFor({ state: "visible", timeout: 10000 });
  const bodyText = await sidePanelPage.textContent("body");

  if (!bodyText?.includes("Extract links from this page")) {
    throw new Error(`Expected side panel Chat task in history, got ${bodyText}.`);
  }

  await sidePanelPage.close();
  return {
    historyContainsUserTask: true
  };
}

async function runSidePanelCancelSmoke(
  extensionId: string,
  fixtureTabId: number | undefined,
  agentUrl: string
): Promise<Record<string, unknown>> {
  if (!context || typeof fixtureTabId !== "number") {
    throw new Error(`Expected browser context and fixture tab ID for side panel cancel smoke, got ${fixtureTabId}.`);
  }

  await fetch(`${agentUrl}/v1/provider-config`, {
    body: JSON.stringify({ type: "disabled" }),
    headers: {
      "Content-Type": "application/json"
    },
    method: "PUT"
  });

  const sidePanelPage = await context.newPage();
  await sidePanelPage.goto(`chrome-extension://${extensionId}/sidepanel.html?tabId=${fixtureTabId}`, { waitUntil: "domcontentloaded" });
  await sidePanelPage.locator(".agent-status[data-state='connected']").waitFor({ state: "visible", timeout: 10000 });
  await sidePanelPage.getByRole("textbox", { name: /^Task$/ }).fill("Press Enter on this page");
  await sidePanelPage.getByRole("button", { name: /Send task/ }).click();
  await sidePanelPage.getByText(/Review required/).waitFor({ state: "visible", timeout: 15000 });
  await sidePanelPage.getByRole("button", { name: /Stop/ }).click();
  await sidePanelPage.getByText(/Canceled task/).waitFor({ state: "visible", timeout: 10000 });
  const canceledBodyText = await sidePanelPage.textContent("body");
  await sidePanelPage.getByRole("button", { name: /History/ }).click();
  await sidePanelPage.locator(".history-item").filter({ hasText: "canceled" }).first().waitFor({ state: "visible", timeout: 10000 });
  const stopActiveButton = sidePanelPage.getByRole("button", { name: /Stop active/ });
  const globalStopVisible = await stopActiveButton.isVisible();
  const globalStopEnabled = await stopActiveButton.isEnabled();
  if (globalStopEnabled) {
    await stopActiveButton.click();
    await sidePanelPage.getByText(/0 active/).waitFor({ state: "visible", timeout: 10000 });
  }
  const historyBodyText = await sidePanelPage.textContent("body");

  await sidePanelPage.close();
  return {
    canceledVisible: canceledBodyText?.includes("Canceled task") === true && canceledBodyText.includes("canceled"),
    globalStopCleared: historyBodyText?.includes("0 active") === true,
    globalStopVisible,
    historyVisible: historyBodyText?.includes("canceled") === true
  };
}

async function runSidePanelApprovalDetailsSmoke(
  extensionId: string,
  fixtureTabId: number | undefined,
  fixtureUrl: string
): Promise<Record<string, unknown>> {
  if (!context || typeof fixtureTabId !== "number") {
    throw new Error(`Expected browser context and fixture tab ID for side panel approval details smoke, got ${fixtureTabId}.`);
  }

  const fixturePage = context.pages().find((page) => page.url().startsWith(fixtureUrl));
  await fixturePage?.goto(fixtureUrl, { waitUntil: "domcontentloaded" });

  const sidePanelPage = await context.newPage();
  const name = "Review User";
  const email = "review-user@example.test";
  await sidePanelPage.goto(`chrome-extension://${extensionId}/sidepanel.html?tabId=${fixtureTabId}`, { waitUntil: "domcontentloaded" });
  await sidePanelPage.locator(".agent-status[data-state='connected']").waitFor({ state: "visible", timeout: 10000 });
  await sidePanelPage.getByRole("textbox", { name: /^Task$/ }).fill(`Fill the form with name ${name} and email ${email}, then submit`);
  await sidePanelPage.getByRole("button", { name: /Send task/ }).click();
  await sidePanelPage.getByText(/Review required/).waitFor({ state: "visible", timeout: 15000 });
  await sidePanelPage.getByText(/Type into page/).first().waitFor({ state: "visible", timeout: 15000 });
  const bodyText = await sidePanelPage.textContent("body");

  await sidePanelPage.close();
  return {
    emailVisible: bodyText?.includes(email) ?? false,
    expiresVisible: bodyText?.includes("Expires") ?? false,
    nameVisible: bodyText?.includes(name) ?? false,
    riskVisible: bodyText?.includes("high risk") ?? false,
    selectorVisible: bodyText?.includes("input[name=\"email\"]") ?? false,
    targetDescriptionVisible: bodyText?.includes("Submit form: Submit (#submit-contact)") ?? false,
    titleVisible: bodyText?.includes("Type into page") ?? false
  };
}

async function runSidePanelAutoContinuationSmoke(
  extensionId: string,
  fixtureTabId: number | undefined,
  agentUrl: string,
  providerUrl: string
): Promise<Record<string, unknown>> {
  if (!context || typeof fixtureTabId !== "number") {
    throw new Error(`Expected browser context and fixture tab ID for side panel auto-continuation smoke, got ${fixtureTabId}.`);
  }

  await fetch(`${agentUrl}/v1/provider-config`, {
    body: JSON.stringify({
      apiKey: "fake-key",
      baseUrl: `${providerUrl}/v1`,
      model: "fake-model",
      type: "openai-compatible"
    }),
    headers: {
      "Content-Type": "application/json"
    },
    method: "PUT"
  });

  const sidePanelPage = await context.newPage();
  await sidePanelPage.goto(`chrome-extension://${extensionId}/sidepanel.html?tabId=${fixtureTabId}`, { waitUntil: "domcontentloaded" });
  await sidePanelPage.locator(".agent-status[data-state='connected']").waitFor({ state: "visible", timeout: 10000 });
  await sidePanelPage.getByRole("textbox", { name: /^Task$/ }).fill("Provider continuation smoke: take a screenshot, then decide the next read action");
  await sidePanelPage.getByRole("button", { name: /Send task/ }).click();
  await sidePanelPage.getByText(/screenshot completed/).waitFor({ state: "visible", timeout: 15000 });
  await sidePanelPage.getByText(/Fake provider continued after observation/).first().waitFor({ state: "visible", timeout: 15000 });
  await sidePanelPage.getByText(/extractText completed/).waitFor({ state: "visible", timeout: 15000 });
  const bodyText = await sidePanelPage.textContent("body");

  await sidePanelPage.close();
  return {
    continuationMessageVisible: bodyText?.includes("Fake provider continued after observation") ?? false,
    extractTextAutoRan: bodyText?.includes("extractText completed") ?? false,
    screenshotRan: bodyText?.includes("screenshot completed") ?? false
  };
}

async function runSidePanelToolErrorSmoke(
  extensionId: string,
  fixtureTabId: number | undefined,
  agentUrl: string,
  providerUrl: string
): Promise<Record<string, unknown>> {
  if (!context || typeof fixtureTabId !== "number") {
    throw new Error(`Expected browser context and fixture tab ID for side panel tool error smoke, got ${fixtureTabId}.`);
  }

  await fetch(`${agentUrl}/v1/provider-config`, {
    body: JSON.stringify({
      apiKey: "fake-key",
      baseUrl: `${providerUrl}/v1`,
      model: "fake-model",
      type: "openai-compatible"
    }),
    headers: {
      "Content-Type": "application/json"
    },
    method: "PUT"
  });

  const sidePanelPage = await context.newPage();
  const message = "Provider missing click smoke";
  try {
    await sidePanelPage.goto(`chrome-extension://${extensionId}/sidepanel.html?tabId=${fixtureTabId}`, { waitUntil: "domcontentloaded" });
    await sidePanelPage.locator(".agent-status[data-state='connected']").waitFor({ state: "visible", timeout: 10000 });
    await sidePanelPage.getByRole("textbox", { name: /^Task$/ }).fill(message);
    await sidePanelPage.getByRole("button", { name: /Send task/ }).click();
    await sidePanelPage.getByText(/Review required/).waitFor({ state: "visible", timeout: 15000 });
    await sidePanelPage.getByText(/Click page element/).first().waitFor({ state: "visible", timeout: 15000 });
    await sidePanelPage.getByRole("button", { name: /^Approve$/ }).first().click();
    const task = await waitForTaskRecord(agentUrl, message, (candidate) =>
      candidate.status === "failed" &&
      candidate.results.some((result) =>
        result.result.status === "error" &&
        result.result.toolName === "click" &&
        result.result.error?.includes("Element not found: #missing-smoke-target")
      )
    );
    const failedStep = task.plan.find((step) => step.toolCall?.toolName === "click");
    const failedResult = task.results.find((result) => result.result.toolName === "click");
    const bodyText = await sidePanelPage.textContent("body");

    return {
      error: failedResult?.result.error,
      messageVisible: bodyText?.includes("click failed: Element not found: #missing-smoke-target") ?? false,
      resultStatus: failedResult?.result.status,
      stepStatus: failedStep?.status,
      taskStatus: task.status
    };
  } finally {
    await sidePanelPage.close();
  }
}

async function waitForTaskRecord(
  agentUrl: string,
  message: string,
  predicate: (task: ListedTask) => boolean
): Promise<ListedTask> {
  for (let attempt = 0; attempt < 40; attempt += 1) {
    const task = (await fetchTaskList(agentUrl)).find((candidate) => candidate.message === message);
    if (task && predicate(task)) {
      return task;
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }

  const tasks = await fetchTaskList(agentUrl);
  throw new Error(`Timed out waiting for task history record for ${message}, got ${JSON.stringify(tasks)}`);
}

async function fetchTaskList(agentUrl: string): Promise<ListedTask[]> {
  const response = await fetch(`${agentUrl}/v1/tasks`);
  if (!response.ok) {
    throw new Error(`Failed to list tasks for smoke verification: ${response.status}`);
  }
  const body = await response.json() as { tasks?: ListedTask[] };
  return body.tasks ?? [];
}

function createFixtureServer(): Server {
  return createServer((request, response) => {
    if (request.url === "/download.txt") {
      response.writeHead(200, {
        "Content-Disposition": "attachment; filename=\"download.txt\"",
        "Content-Type": "text/plain; charset=utf-8"
      });
      response.end("open-agent-browser download smoke\n");
      return;
    }

    if (request.url === "/pricing") {
      response.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      response.end(`
        <!doctype html>
        <title>Pricing</title>
        <main>
          <h1>Pricing</h1>
          <table>
            <thead><tr><th>Plan</th><th>Price</th></tr></thead>
            <tbody>
              <tr><td>Starter</td><td>$9/month</td></tr>
              <tr><td>Pro</td><td>$29/month</td></tr>
              <tr><td>Enterprise</td><td>Contact us</td></tr>
            </tbody>
          </table>
        </main>
      `);
      return;
    }

    response.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    response.end(`
      <!doctype html>
      <title>Open Agent Fixture</title>
      <main>
        <h1>Open Agent Fixture</h1>
        <p>The page explains local agent browsing and clean-room automation.</p>
        <a href="/pricing">Pricing</a>
        <p id="redaction-source">Support reviewer@example.test with Bearer abcdef123456.</p>
        <a id="redaction-link" href="/reset?token=secret-token&email=reviewer@example.test">Reset reviewer@example.test</a>
        <form id="contact-form">
          <label>Name <input name="name" type="text" autocomplete="name" /></label>
          <label>Email <input name="email" type="email" autocomplete="email" /></label>
          <button id="submit-contact" type="submit">Submit</button>
        </form>
        <p id="form-status"></p>
        <label for="billing-field">Billing Email</label>
        <input id="billing-field" type="text" />
        <table id="feature-table">
          <caption>Feature Matrix</caption>
          <thead><tr><th>Feature</th><th>Status</th></tr></thead>
          <tbody>
            <tr><td>Local agent</td><td>Ready</td></tr>
            <tr><td>Clean-room gate</td><td>Enabled</td></tr>
          </tbody>
        </table>
        <label>Controlled Email <input id="controlled-email" name="controlledEmail" type="email" autocomplete="email" /></label>
        <p id="controlled-status"></p>
        <input id="keyboard-target" aria-label="Keyboard target" />
        <p id="key-status"></p>
        <button id="noop">Inspect</button>
        <button id="delete-draft" type="button" aria-label="Delete draft">Delete Draft</button>
        <p id="semantic-click-status"></p>
        <button id="hidden-agent-action" style="display: none" type="button">Hidden Agent Trap</button>
        <p id="hidden-action-status"></p>
        <section id="selector-lab" aria-label="Selector lab">
          <button type="button">Anonymous Ignore</button>
          <button type="button">Anonymous Target</button>
          <p id="anonymous-click-status"></p>
        </section>
        <section style="min-height: 1800px" aria-label="Long content">
          <h2>Long content</h2>
          <p>Scrolling reveals more local fixture content for browser tool verification.</p>
        </section>
        <script>
          document.querySelector("#contact-form").addEventListener("submit", (event) => {
            event.preventDefault();
            const form = event.currentTarget;
            document.querySelector("#form-status").textContent = [
              form.elements.name.value,
              form.elements.email.value,
              "submitted"
            ].join(" | ");
          });
          document.querySelector("#keyboard-target").addEventListener("keydown", (event) => {
            document.querySelector("#key-status").textContent = event.key;
          });
          document.querySelectorAll("#selector-lab button")[1].addEventListener("click", () => {
            document.querySelector("#anonymous-click-status").textContent = "anonymous-clicked";
          });
          document.querySelector("#hidden-agent-action").addEventListener("click", () => {
            document.querySelector("#hidden-action-status").textContent = "hidden-clicked";
          });
          document.querySelector("#delete-draft").addEventListener("click", () => {
            document.querySelector("#semantic-click-status").textContent = "delete-clicked";
          });
          const controlled = document.querySelector("#controlled-email");
          const nativeValue = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value");
          let trackedControlledValue = controlled.value;
          Object.defineProperty(controlled, "value", {
            configurable: true,
            get() {
              return nativeValue.get.call(this);
            },
            set(nextValue) {
              nativeValue.set.call(this, nextValue);
              trackedControlledValue = String(nextValue);
            }
          });
          controlled.addEventListener("input", () => {
            if (controlled.value !== trackedControlledValue) {
              trackedControlledValue = controlled.value;
              document.querySelector("#controlled-status").textContent = controlled.value;
            }
          });
        </script>
      </main>
    `);
  });
}

function createFakeProviderServer(): Server {
  return createServer(async (request, response) => {
    if (request.method !== "POST" || (request.url !== "/v1/chat/completions" && request.url !== "/api/chat")) {
      response.writeHead(404, { "Content-Type": "application/json" });
      response.end(JSON.stringify({ error: "not found" }));
      return;
    }

    const body = await readJson(request);
    const serialized = JSON.stringify(body);
    const sawMemory = serialized.includes("Remember that smoke tests prefer local providers.");
    const providerName = request.url === "/api/chat" ? "Fake Ollama" : "Fake provider";
    const content = serialized.includes("Continue this browser task after the latest tool result") &&
      serialized.includes("Provider continuation smoke")
      ? JSON.stringify({
        message: "Fake provider continued after observation",
        toolCalls: [
          {
            args: { selector: "main" },
            description: "Extract main content after observing the screenshot result.",
            toolName: "extractText"
          }
        ]
      })
      : serialized.includes("Provider tool proposal smoke")
      ? JSON.stringify({
        message: "Fake provider proposed extractText",
        toolCalls: [
          {
            args: { selector: "main" },
            description: "Extract main content proposed by the provider.",
            toolName: "extractText"
          }
        ]
      })
      : serialized.includes("Provider risky reason smoke")
      ? JSON.stringify({
        message: "Fake provider proposed a risky click with a misleading reason",
        toolCalls: [
          {
            args: {
              description: "Delete Draft",
              selector: "#delete-draft"
            },
            description: "Click the delete draft button.",
            reason: "This is safe and does not need review.",
            toolName: "click"
          }
        ]
      })
      : serialized.includes("Provider missing click smoke")
      ? JSON.stringify({
        message: "Fake provider proposed missing click",
        toolCalls: [
          {
            args: {
              description: "Click missing smoke target",
              selector: "#missing-smoke-target"
            },
            description: "Click a missing element so side panel error recording can be verified.",
            reason: "Smoke test verifies that extension execution errors are persisted after server dispatch.",
            toolName: "click"
          }
        ]
      })
      : serialized.includes("Open Agent Fixture")
      ? `${providerName} saw Open Agent Fixture${sawMemory ? " and confirmed memory" : ""}`
      : `${providerName} ready`;

    const responseBody = request.url === "/api/chat"
      ? { message: { content } }
      : { choices: [{ message: { content } }] };

    response.writeHead(200, { "Content-Type": "application/json" });
    response.end(JSON.stringify(responseBody));
  });
}

async function readJson(request: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];

  for await (const chunk of request) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }

  return chunks.length > 0 ? JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown : {};
}

async function listen(server: Server): Promise<string> {
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("Expected TCP server address.");
  }

  return `http://127.0.0.1:${address.port}`;
}

async function closeServer(server: Server): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    server.close((error) => {
      if (error) {
        reject(error);
      } else {
        resolve();
      }
    });
  });
}

async function removeDirectoryBestEffort(path: string): Promise<void> {
  for (let attempt = 0; attempt < 5; attempt += 1) {
    try {
      rmSync(path, {
        force: true,
        maxRetries: 3,
        recursive: true,
        retryDelay: 100
      });
      return;
    } catch (error) {
      if (attempt === 4) {
        console.warn(`Warning: failed to remove temporary browser profile ${path}: ${error instanceof Error ? error.message : String(error)}`);
        return;
      }

      await new Promise((resolve) => setTimeout(resolve, 250));
    }
  }
}
