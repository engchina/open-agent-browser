import {
  type AgentPlanStep,
  type BrowserToolCall,
  type ChatRequest,
  type HumanApprovalRequest,
  type MemoryRecord,
  type PageElement,
  type ProviderConfig,
  browserToolNameSchema,
  isHighRiskTool,
  validateToolArgs
} from "@open-agent-browser/shared";
import { ApprovalRegistry } from "./approval.js";
import { buildLocalMessage, generateProviderMessage } from "./provider.js";

export interface PlannedChat {
  approvalRequests: HumanApprovalRequest[];
  message: string;
  plan: AgentPlanStep[];
  taskId: string;
  userMessage: string;
}

export interface PlanChatOptions {
  fetchImpl?: typeof fetch;
  memories?: MemoryRecord[];
  providerConfig: ProviderConfig;
}

export async function planChat(
  request: ChatRequest,
  approvals: ApprovalRegistry,
  options: PlanChatOptions
): Promise<PlannedChat> {
  const taskId = crypto.randomUUID();
  const normalized = request.message.toLowerCase();
  const tabId = request.tabId ?? request.pageSnapshot?.tabId;
  const approvalRequests: HumanApprovalRequest[] = [];
  const targetUrl = extractFirstUrl(request.message);
  const wantsDownload = Boolean(targetUrl) && isDownloadIntent(request.message);
  const wantsOpenTab = Boolean(targetUrl) && isOpenTabIntent(request.message);
  const followUpTabId = wantsOpenTab ? undefined : tabId;
  const wantsLinks = isLinkIntent(normalized);
  const wantsPricingJson = isPricingJsonIntent(request.message);
  const browserControlActions = buildBrowserControlActions(request, tabId);
  const formActions = isFormIntent(normalized) ? buildFormActions(request, tabId) : [];
  const clickActions = formActions.some((action) => action.toolCall.toolName === "click")
    ? []
    : buildClickActions(request, tabId);
  const snapshotStep: AgentPlanStep = request.pageSnapshot
    ? {
        description: "Use the attached sanitized page snapshot.",
        id: crypto.randomUUID(),
        status: "completed"
      }
    : {
        description: "Capture the current page snapshot with sensitive fields redacted.",
        id: crypto.randomUUID(),
        status: "pending",
        toolCall: {
          args: {
            includeInputs: request.contextPolicy !== "visible-text",
            includeLinks: true
          },
          id: crypto.randomUUID(),
          tabId,
          toolName: "getPageSnapshot"
        }
      };
  const plan: AgentPlanStep[] = [snapshotStep];

  if (targetUrl && !wantsOpenTab && !wantsDownload) {
    const toolCall: BrowserToolCall = {
      args: {
        ...(request.pageSnapshot?.url ? { sourceUrl: request.pageSnapshot.url } : {}),
        url: targetUrl
      },
      id: crypto.randomUUID(),
      tabId,
      toolName: "navigate"
    };
    const approvalRequest = approvals.create(toolCall);

    approvalRequests.push(approvalRequest);
    plan.push({
      description: `Open ${targetUrl}.`,
      id: crypto.randomUUID(),
      status: "blocked",
      toolCall
    });
  }

  if (wantsLinks) {
    plan.push({
      description: targetUrl
        ? "Extract links after navigation."
        : "Extract links from the current page.",
      id: crypto.randomUUID(),
      status: targetUrl ? "blocked" : "pending",
      toolCall: {
        args: {},
        id: crypto.randomUUID(),
        tabId: followUpTabId,
        toolName: "extractLinks"
      }
    });
  }

  for (const action of browserControlActions) {
    addPlannedToolAction(plan, approvalRequests, approvals, action, Boolean(targetUrl));
  }

  for (const action of clickActions) {
    addPlannedToolAction(plan, approvalRequests, approvals, action, Boolean(targetUrl));
  }

  if (wantsPricingJson) {
    plan.push({
      description: targetUrl
        ? "Capture the page structure after navigation for pricing JSON."
        : "Capture the page structure for pricing JSON.",
      id: crypto.randomUUID(),
      status: targetUrl ? "blocked" : "pending",
      toolCall: {
        args: {
          includeInputs: false,
          includeLinks: true
        },
        id: crypto.randomUUID(),
        tabId: followUpTabId,
        toolName: "getPageSnapshot"
      }
    });
  }

  for (const action of formActions) {
    addPlannedToolAction(plan, approvalRequests, approvals, action, Boolean(targetUrl));
  }

  const hasUserRequestedTool = Boolean(targetUrl) ||
    wantsLinks ||
    wantsPricingJson ||
    browserControlActions.length > 0 ||
    clickActions.length > 0 ||
    formActions.length > 0;

  if (!hasUserRequestedTool) {
    plan.push({
      description: "Summarize visible page content locally or through the configured provider.",
      id: crypto.randomUUID(),
      status: "completed"
    });
  }

  const message = await buildMessageAndApplyProviderToolProposals(
    request,
    plan,
    approvalRequests,
    approvals,
    options
  );

  return {
    approvalRequests,
    message,
    plan,
    taskId,
    userMessage: request.message
  };
}

async function buildMessageAndApplyProviderToolProposals(
  request: ChatRequest,
  plan: AgentPlanStep[],
  approvalRequests: HumanApprovalRequest[],
  approvals: ApprovalRegistry,
  options: PlanChatOptions
): Promise<string> {
  const providerMessage = await generateProviderMessage(
    options.providerConfig,
    { memories: options.memories ?? [], plan, request },
    options.fetchImpl ? { fetchImpl: options.fetchImpl } : {}
  );

  if (!providerMessage) {
    return buildLocalMessage(request, plan, options.memories ?? []);
  }

  const providerTabId = request.tabId ?? request.pageSnapshot?.tabId;
  const providerPlan = parseProviderToolPlan(providerMessage, {
    ...(request.pageSnapshot?.url ? { sourceUrl: request.pageSnapshot.url } : {}),
    ...(providerTabId !== undefined ? { tabId: providerTabId } : {})
  });
  applyProviderToolProposalsToPlan(plan, approvalRequests, approvals, providerPlan.toolCalls);

  return providerPlan.message || providerMessage;
}

export interface ProviderToolPlan {
  message: string;
  toolCalls: ProviderToolProposal[];
}

export interface ProviderToolProposal {
  description?: string;
  reason?: string;
  toolCall: BrowserToolCall;
}

export interface ProviderToolPlanContext {
  sourceUrl?: string;
  tabId?: number;
}

export function parseProviderToolPlan(providerMessage: string, context: ProviderToolPlanContext = {}): ProviderToolPlan {
  const parsed = parseProviderJsonObject(providerMessage);

  if (!isRecord(parsed)) {
    return {
      message: providerMessage,
      toolCalls: []
    };
  }

  const toolCallsValue = parsed.toolCalls;
  const toolCalls = Array.isArray(toolCallsValue)
    ? toolCallsValue.slice(0, 8).flatMap((value) => parseProviderToolProposal(value, context))
    : [];

  return {
    message: readProviderUserMessage(parsed) ?? providerMessage,
    toolCalls
  };
}

function parseProviderToolProposal(
  value: unknown,
  context: ProviderToolPlanContext
): ProviderToolProposal[] {
  if (!isRecord(value) || typeof value.toolName !== "string") {
    return [];
  }

  const toolNameResult = browserToolNameSchema.safeParse(value.toolName);
  if (!toolNameResult.success) {
    return [];
  }

  const rawArgs = isRecord(value.args) ? value.args : {};
  let args: Record<string, unknown>;

  try {
    const validated = validateToolArgs(toolNameResult.data, rawArgs);
    if (toolNameResult.data === "navigate") {
      args = {
        ...(context.sourceUrl ? { sourceUrl: context.sourceUrl } : {}),
        url: validated.url
      };
    } else if (toolNameResult.data === "openTab") {
      args = {
        active: validated.active,
        ...(context.sourceUrl ? { sourceUrl: context.sourceUrl } : {}),
        url: validated.url
      };
    } else if (toolNameResult.data === "downloadUrl") {
      args = {
        conflictAction: validated.conflictAction,
        ...(validated.filename ? { filename: validated.filename } : {}),
        saveAs: validated.saveAs,
        ...(context.sourceUrl ? { sourceUrl: context.sourceUrl } : {}),
        url: validated.url
      };
    } else if (["click", "press", "type"].includes(toolNameResult.data)) {
      args = {
        ...validated,
        ...(context.sourceUrl ? { expectedUrl: context.sourceUrl } : {})
      };
    } else {
      args = validated;
    }
  } catch {
    return [];
  }

  const description = typeof value.description === "string" && value.description.trim()
    ? value.description.trim().slice(0, 240)
    : undefined;
  const reason = typeof value.reason === "string" && value.reason.trim()
    ? value.reason.trim().slice(0, 500)
    : undefined;
  const proposal: ProviderToolProposal = {
    toolCall: {
      args,
      id: crypto.randomUUID(),
      tabId: context.tabId,
      toolName: toolNameResult.data
    }
  };

  if (description) {
    proposal.description = description;
  }
  if (reason) {
    proposal.reason = reason;
  }

  return [
    proposal
  ];
}

export function applyProviderToolProposalsToPlan(
  plan: AgentPlanStep[],
  approvalRequests: HumanApprovalRequest[],
  approvals: ApprovalRegistry,
  proposals: ProviderToolProposal[],
  origin: AgentPlanStep["origin"] = "provider-plan"
): number {
  let addedCount = 0;
  let hasNavigationDependency = plan.some((step) => step.toolCall?.toolName === "navigate");

  for (const proposal of proposals) {
    if (hasEquivalentToolCall(plan, proposal.toolCall)) {
      continue;
    }

    addPlannedToolAction(
      plan,
      approvalRequests,
      approvals,
      {
        description: proposal.description ?? `Run provider-proposed ${proposal.toolCall.toolName}.`,
        origin,
        reason: proposal.reason ?? `The provider proposed ${proposal.toolCall.toolName}; review before execution if it changes page state.`,
        reasonSource: "provider",
        toolCall: proposal.toolCall
      },
      hasNavigationDependency && proposal.toolCall.toolName !== "navigate"
    );
    addedCount += 1;

    if (proposal.toolCall.toolName === "navigate") {
      hasNavigationDependency = true;
    }
  }

  return addedCount;
}

function parseProviderJsonObject(providerMessage: string): unknown | undefined {
  const candidates = [
    providerMessage.trim(),
    providerMessage.match(/```(?:json)?\s*([\s\S]*?)```/i)?.[1]?.trim(),
    extractFirstJsonObject(providerMessage)
  ].filter((candidate): candidate is string => Boolean(candidate));

  for (const candidate of candidates) {
    try {
      return JSON.parse(candidate) as unknown;
    } catch {
      continue;
    }
  }

  return undefined;
}

function extractFirstJsonObject(value: string): string | undefined {
  let depth = 0;
  let startIndex = -1;
  let isInString = false;
  let escaped = false;

  for (let index = 0; index < value.length; index += 1) {
    const character = value[index];

    if (isInString) {
      if (escaped) {
        escaped = false;
      } else if (character === "\\") {
        escaped = true;
      } else if (character === "\"") {
        isInString = false;
      }
      continue;
    }

    if (character === "\"") {
      isInString = true;
      continue;
    }

    if (character === "{") {
      if (depth === 0) {
        startIndex = index;
      }
      depth += 1;
      continue;
    }

    if (character === "}" && depth > 0) {
      depth -= 1;
      if (depth === 0 && startIndex >= 0) {
        return value.slice(startIndex, index + 1);
      }
    }
  }

  return undefined;
}

function readProviderUserMessage(value: Record<string, unknown>): string | undefined {
  for (const key of ["message", "answer", "response"]) {
    const candidate = value[key];
    if (typeof candidate === "string" && candidate.trim()) {
      return candidate.trim();
    }
  }

  return undefined;
}

function hasEquivalentToolCall(plan: AgentPlanStep[], toolCall: BrowserToolCall): boolean {
  return plan.some((step) =>
    step.toolCall?.toolName === toolCall.toolName &&
    stableJson(step.toolCall.args) === stableJson(toolCall.args)
  );
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map((item) => stableJson(item)).join(",")}]`;
  }

  if (isRecord(value)) {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(",")}}`;
  }

  return JSON.stringify(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function extractFirstUrl(message: string): string | undefined {
  return message.match(/https?:\/\/[^\s"'<>]+/i)?.[0];
}

function isPricingJsonIntent(message: string): boolean {
  const wantsStructuredOutput = /(json|structured|结构化|構造化)/i.test(message);
  const wantsPricing = /(price|pricing|plan|価格|料金|价格|定价)/i.test(message);
  return wantsStructuredOutput && wantsPricing;
}

function isLinkIntent(normalizedMessage: string): boolean {
  return normalizedMessage.includes("link") || normalizedMessage.includes("リンク") || normalizedMessage.includes("链接");
}

function isFormIntent(normalizedMessage: string): boolean {
  return normalizedMessage.includes("form") ||
    normalizedMessage.includes("submit") ||
    normalizedMessage.includes("填写") ||
    normalizedMessage.includes("填寫") ||
    normalizedMessage.includes("提交") ||
    normalizedMessage.includes("入力") ||
    normalizedMessage.includes("送信");
}

function isFieldEntryIntent(message: string): boolean {
  return /(fill|type|enter|input|write|填写|填寫|输入|輸入|記入|入力)/i.test(message);
}

function isClickIntent(message: string): boolean {
  return /(click|tap|press|select|choose|hit|点击|點擊|点一下|按下|选择|選択|クリック|タップ|押)/i.test(message);
}

interface PlannedFormAction {
  description: string;
  origin?: AgentPlanStep["origin"];
  reason?: string;
  reasonSource?: "local" | "provider";
  toolCall: BrowserToolCall;
}

function addPlannedToolAction(
  plan: AgentPlanStep[],
  approvalRequests: HumanApprovalRequest[],
  approvals: ApprovalRegistry,
  action: PlannedFormAction,
  dependsOnNavigation: boolean
): void {
  const needsApproval = isHighRiskTool(action.toolCall.toolName);

  if (needsApproval) {
    approvalRequests.push(approvals.create(action.toolCall, action.reason, {
      reasonSource: action.reasonSource ?? "local"
    }));
  }

  plan.push({
    description: action.description,
    id: crypto.randomUUID(),
    ...(action.origin ? { origin: action.origin } : {}),
    status: needsApproval || dependsOnNavigation ? "blocked" : "pending",
    toolCall: action.toolCall
  });
}

function buildBrowserControlActions(
  request: ChatRequest,
  tabId: number | undefined
): PlannedFormAction[] {
  const actions: PlannedFormAction[] = [];
  const targetUrl = extractFirstUrl(request.message);
  const scrollDirection = extractScrollDirection(request.message);
  const key = extractPressedKey(request.message);

  if (targetUrl && isDownloadIntent(request.message)) {
    actions.push({
      description: `Download ${targetUrl}.`,
      reason: "Downloading saves a file locally and may expose private URLs. Review the source before execution.",
      toolCall: {
        args: {
          ...(request.pageSnapshot?.url ? { sourceUrl: request.pageSnapshot.url } : {}),
          url: targetUrl
        },
        id: crypto.randomUUID(),
        tabId,
        toolName: "downloadUrl"
      }
    });
  } else if (targetUrl && isOpenTabIntent(request.message)) {
    actions.push({
      description: `Open ${targetUrl} in a new tab.`,
      reason: "Opening a new tab can leave the current site or trigger authentication flows. Review the destination before execution.",
      toolCall: {
        args: {
          active: true,
          ...(request.pageSnapshot?.url ? { sourceUrl: request.pageSnapshot.url } : {}),
          url: targetUrl
        },
        id: crypto.randomUUID(),
        tabId,
        toolName: "openTab"
      }
    });
  }

  if (scrollDirection) {
    actions.push({
      description: `Scroll ${scrollDirection}.`,
      toolCall: {
        args: {
          amount: extractScrollAmount(request.message),
          direction: scrollDirection
        },
        id: crypto.randomUUID(),
        tabId,
        toolName: "scroll"
      }
    });
  }

  if (key) {
    actions.push({
      description: `Press ${key}.`,
      reason: `The task may send the ${key} key to the active page element. Review before execution.`,
      toolCall: {
        args: {
          ...(request.pageSnapshot?.url ? { expectedUrl: request.pageSnapshot.url } : {}),
          key
        },
        id: crypto.randomUUID(),
        tabId,
        toolName: "press"
      }
    });
  }

  if (isScreenshotIntent(request.message)) {
    actions.push({
      description: isFullPageScreenshotIntent(request.message)
        ? "Capture a full-page screenshot for local use."
        : "Capture a visible-tab screenshot for local use.",
      toolCall: {
        args: {
          fullPage: isFullPageScreenshotIntent(request.message)
        },
        id: crypto.randomUUID(),
        tabId,
        toolName: "screenshot"
      }
    });
  }

  if (isTabListIntent(request.message)) {
    actions.push({
      description: "List open tabs in the current browser window.",
      toolCall: {
        args: {
          currentWindow: true
        },
        id: crypto.randomUUID(),
        tabId,
        toolName: "listTabs"
      }
    });
  }

  const activateTabId = extractActivateTabId(request.message);
  if (activateTabId !== undefined) {
    actions.push({
      description: `Activate tab ${activateTabId}.`,
      toolCall: {
        args: {
          tabId: activateTabId
        },
        id: crypto.randomUUID(),
        tabId,
        toolName: "activateTab"
      }
    });
  }

  const closeTabId = extractCloseTabId(request.message);
  if (closeTabId !== undefined) {
    actions.push({
      description: `Close tab ${closeTabId}.`,
      reason: "Closing a tab can discard local page state, unsaved form data, or in-progress work.",
      toolCall: {
        args: {
          tabId: closeTabId
        },
        id: crypto.randomUUID(),
        tabId,
        toolName: "closeTab"
      }
    });
  }

  return actions;
}

function extractScrollDirection(message: string): "down" | "left" | "right" | "up" | undefined {
  if (!/(scroll|滚动|滾動|下滑|上滑|スクロール)/i.test(message)) {
    return undefined;
  }

  if (/(left|左)/i.test(message)) {
    return "left";
  }
  if (/(right|右)/i.test(message)) {
    return "right";
  }
  if (/(up|上|戻)/i.test(message)) {
    return "up";
  }

  return "down";
}

function extractScrollAmount(message: string): number {
  const explicit = message.match(/\b(\d{2,4})\s*(?:px|pixels?)?\b/i)?.[1];
  if (explicit) {
    return Math.min(5000, Math.max(1, Number(explicit)));
  }

  return /(bottom|底部|最后|最後|下まで)/i.test(message) ? 2000 : 800;
}

function extractPressedKey(message: string): string | undefined {
  if (/\benter\b|回车|回車/i.test(message)) {
    return "Enter";
  }
  if (/\bescape\b|\besc\b|退出键|キャンセル/i.test(message)) {
    return "Escape";
  }
  if (/\btab\b|tab键|タブ/i.test(message)) {
    return "Tab";
  }
  if (/\bbackspace\b|退格|削除キー/i.test(message)) {
    return "Backspace";
  }
  if (/\bspace\b|空格/i.test(message)) {
    return " ";
  }

  const quoted = message.match(/(?:press|hit|按)\s+["'`]([^"'`]{1,40})["'`]/i)?.[1]?.trim();
  if (quoted) {
    return quoted;
  }

  return undefined;
}

function isScreenshotIntent(message: string): boolean {
  return /(screenshot|screen shot|capture (?:the )?(?:visible )?(?:tab|page|screen)|截图|截屏|スクリーンショット|スクショ)/i.test(message);
}

function isFullPageScreenshotIntent(message: string): boolean {
  return /(full[- ]?page|whole page|entire page|整页|完整页面|全页|ページ全体|全体ページ)/i.test(message);
}

function isOpenTabIntent(message: string): boolean {
  return /(new\s+tab|open\s+tab|another\s+tab|新标签页|新標籤頁|新しいタブ|別タブ)/i.test(message);
}

function isDownloadIntent(message: string): boolean {
  return /(download|save\s+(?:this\s+)?(?:file|url|link)|下载|下載|ダウンロード)/i.test(message);
}

function isTabListIntent(message: string): boolean {
  return /(\b(list|show|what|which)\b.*\b(open\s+)?tabs?\b|\b(open\s+)?tabs?\b.*\b(list|open|available)\b|标签页|標籤頁|タブ一覧|開いているタブ)/i
    .test(message);
}

function extractActivateTabId(message: string): number | undefined {
  const match = message.match(/(?:activate|switch\s+to|focus|切换到|切換到|切り替え).{0,24}\btab(?:id)?\s*[:#= ]\s*(\d{1,10})|tabid\s*[:= ]\s*(\d{1,10})/i);
  const raw = match?.[1] ?? match?.[2];
  if (!raw) {
    return undefined;
  }

  const tabId = Number(raw);
  return Number.isInteger(tabId) && tabId >= 0 ? tabId : undefined;
}

function extractCloseTabId(message: string): number | undefined {
  const match = message.match(/(?:close|关闭|關閉|閉じ).{0,24}\btab(?:id)?\s*[:#= ]\s*(\d{1,10})|close\s+tabid\s*[:= ]\s*(\d{1,10})/i);
  const raw = match?.[1] ?? match?.[2];
  if (!raw) {
    return undefined;
  }

  const tabId = Number(raw);
  return Number.isInteger(tabId) && tabId >= 0 ? tabId : undefined;
}

function buildFormActions(request: ChatRequest, tabId: number | undefined): PlannedFormAction[] {
  const actions: PlannedFormAction[] = [];
  const email = extractEmail(request.message);
  const name = extractName(request.message);
  const wantsFieldEntry = Boolean(name || email) || isFieldEntryIntent(request.message);

  if (name) {
    const selector = findFieldSelector(request.pageSnapshot?.elements ?? [], "name") ?? "input[name=\"name\"], input[autocomplete=\"name\"], input";
    actions.push(buildTypeAction(tabId, selector, name, "name", request.pageSnapshot?.url));
  }

  if (email) {
    const selector = findFieldSelector(request.pageSnapshot?.elements ?? [], "email") ?? "input[name=\"email\"], input[type=\"email\"], input";
    actions.push(buildTypeAction(tabId, selector, email, "email", request.pageSnapshot?.url));
  }

  if (actions.length === 0 && wantsFieldEntry) {
    actions.push(buildTypeAction(
      tabId,
      "input[name=\"email\"], input, textarea",
      extractFormText(request.message),
      "form field",
      request.pageSnapshot?.url
    ));
  }

  if (isSubmitIntent(request.message)) {
    const submitElement = findSubmitElement(request.pageSnapshot?.elements ?? []);
    const selector = submitElement?.selector ?? "button[type=\"submit\"], input[type=\"submit\"], button";
    actions.push({
      description: "Submit the form after the reviewed fields are filled.",
      reason: "The task may submit a form. Review the target button before execution.",
      toolCall: {
        args: {
          description: describeElementForApproval(submitElement, "Submit form"),
          ...(request.pageSnapshot?.url ? { expectedUrl: request.pageSnapshot.url } : {}),
          selector
        },
        id: crypto.randomUUID(),
        tabId,
        toolName: "click"
      }
    });
  }

  return actions;
}

function buildClickActions(request: ChatRequest, tabId: number | undefined): PlannedFormAction[] {
  if (!isClickIntent(request.message)) {
    return [];
  }

  const element = findClickableElement(request.pageSnapshot?.elements ?? [], request.message);
  if (!element) {
    return [];
  }

  const description = describeElementForApproval(element, "Click page control");
  const reason = isSensitiveElement(element)
    ? "The requested click matches a sensitive page control such as submit, send, payment, purchase, delete, or download."
    : "The task requests a page click. Review the target control before execution.";

  return [
    {
      description: `Click ${elementLabel(element) ?? element.selector}.`,
      reason,
      toolCall: {
        args: {
          description,
          ...(request.pageSnapshot?.url ? { expectedUrl: request.pageSnapshot.url } : {}),
          selector: element.selector
        },
        id: crypto.randomUUID(),
        tabId,
        toolName: "click"
      }
    }
  ];
}

function buildTypeAction(
  tabId: number | undefined,
  selector: string,
  text: string,
  label: string,
  expectedUrl?: string
): PlannedFormAction {
  return {
    description: `Fill the ${label} field.`,
    reason: `The task may type ${label} into a form. Review the target field and text before execution.`,
    toolCall: {
      args: {
        clearFirst: true,
        ...(expectedUrl ? { expectedUrl } : {}),
        selector,
        text
      },
      id: crypto.randomUUID(),
      tabId,
      toolName: "type"
    }
  };
}

function extractEmail(message: string): string | undefined {
  return message.match(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i)?.[0];
}

function extractName(message: string): string | undefined {
  const explicit = message.match(/\bname\s*(?:is|=|:)?\s*([A-Z][A-Z0-9 ._-]{1,80}?)(?=\s+(?:and\s+)?(?:email|e-mail|mail)\b|[,.;]|$)/i)?.[1]?.trim();
  if (explicit) {
    return explicit;
  }

  const chinese = message.match(/(?:姓名|名字|名称)\s*(?:是|为|為|=|:)?\s*([^\s,，。;；]+(?:\s+[^\s,，。;；]+)?)/)?.[1]?.trim();
  if (chinese) {
    return chinese;
  }

  const quoted = message.match(/(?:name|姓名|名字)[^"'“”]*["“]([^"”]+)["”]/i)?.[1]?.trim();
  return quoted || undefined;
}

function extractFormText(message: string): string {
  const email = extractEmail(message);
  if (email) {
    return email;
  }

  const quoted = message.match(/"([^"]+)"|'([^']+)'/)?.[1];
  if (quoted) {
    return quoted;
  }

  const withValue = message.match(/\bwith\s+(.+)$/i)?.[1]?.trim();
  if (withValue) {
    return withValue;
  }

  return "open-agent@example.test";
}

function isSubmitIntent(message: string): boolean {
  return /(submit|send|提交|送信)/i.test(message);
}

function findFieldSelector(elements: PageElement[], field: "email" | "name"): string | undefined {
  const fieldPattern = field === "email" ? /(email|e-mail|mail|邮箱|郵箱|メール)/i : /(name|full-name|fullname|姓名|名字|氏名)/i;
  const typePattern = field === "email" ? /^email$/i : /^text$/i;

  return elements.find((element) => {
    if (!["input", "textarea"].includes(element.tagName)) {
      return false;
    }

    const haystack = [
      element.selector,
      element.text,
      element.attributes.label,
      element.attributes.name,
      element.attributes.placeholder,
      element.attributes["aria-label"],
      element.attributes.autocomplete
    ].filter(Boolean).join(" ");

    return fieldPattern.test(haystack) || typePattern.test(element.attributes.type ?? "");
  })?.selector;
}

function findSubmitElement(elements: PageElement[]): PageElement | undefined {
  return elements.find((element) => {
    const haystack = [
      element.selector,
      element.text,
      element.attributes.label,
      element.attributes.type,
      element.attributes.role,
      element.attributes["aria-label"],
      element.attributes.value
    ].filter(Boolean).join(" ");

    return (element.tagName === "button" || element.tagName === "input" || element.role === "button") &&
      /(submit|send|save|提交|送信)/i.test(haystack);
  });
}

function findClickableElement(elements: PageElement[], message: string): PageElement | undefined {
  const query = normalizeMatchText(message);
  const scored = elements
    .filter(isClickableElement)
    .map((element) => ({
      element,
      score: scoreClickableElement(element, query)
    }))
    .filter((candidate) => candidate.score > 0)
    .sort((left, right) => right.score - left.score);

  return scored[0]?.element;
}

function isClickableElement(element: PageElement): boolean {
  const role = element.role ?? element.attributes.role;
  const type = element.attributes.type ?? "";

  return element.tagName === "button" ||
    element.tagName === "a" ||
    role === "button" ||
    role === "link" ||
    (element.tagName === "input" && /^(button|submit|reset)$/i.test(type));
}

function scoreClickableElement(element: PageElement, query: string): number {
  let score = 0;

  for (const label of elementLabels(element)) {
    const normalizedLabel = normalizeMatchText(label);
    if (!normalizedLabel) {
      continue;
    }

    if (query.includes(normalizedLabel)) {
      score = Math.max(score, 100 + normalizedLabel.length);
      continue;
    }

    const tokens = normalizedLabel.split(" ").filter((token) => token.length >= 3);
    const tokenMatches = tokens.filter((token) => query.includes(token)).length;
    if (tokenMatches > 0) {
      score = Math.max(score, tokenMatches);
    }
  }

  if (isSensitiveElement(element) && sensitiveElementPattern.test(query)) {
    score += 20;
  }

  return score;
}

const sensitiveElementPattern =
  /(submit|send|save|delete|remove|destroy|purchase|buy|pay|payment|checkout|order|download|login|sign in|sign up|transfer|subscribe|unsubscribe|confirm|commit|提交|送信|发送|刪除|删除|購入|支払|ログイン|サインイン|登録|ダウンロード)/i;

function isSensitiveElement(element: PageElement): boolean {
  return sensitiveElementPattern.test(elementLabels(element).join(" "));
}

function elementLabel(element: PageElement): string | undefined {
  return elementLabels(element).find((value) => value.trim().length > 0);
}

function elementLabels(element: PageElement): string[] {
  return [
    element.text,
    element.attributes.label,
    element.attributes["aria-label"],
    element.attributes.value,
    element.attributes.name,
    element.attributes.type
  ].filter((value): value is string => typeof value === "string" && value.trim().length > 0);
}

function normalizeMatchText(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9\u3040-\u30ff\u3400-\u9fff]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function describeElementForApproval(element: PageElement | undefined, fallback: string): string {
  if (!element) {
    return fallback;
  }

  const label = elementLabel(element);

  return label
    ? `${fallback}: ${label} (${element.selector})`
    : `${fallback}: ${element.selector}`;
}
