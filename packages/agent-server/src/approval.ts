import {
  isHighRiskTool,
  type BrowserToolCall,
  type HumanApprovalRequest
} from "@open-agent-browser/shared";

const defaultApprovalTtlMs = 10 * 60 * 1000;

export interface ApprovalRegistryOptions {
  now?: () => number;
  ttlMs?: number;
}

export interface ApprovalCreateOptions {
  reasonSource?: "local" | "provider";
}

export class ApprovalRegistry {
  private readonly approvals = new Map<string, HumanApprovalRequest>();

  constructor(private readonly options: ApprovalRegistryOptions = {}) {}

  create(toolCall: BrowserToolCall, reason?: string, createOptions: ApprovalCreateOptions = {}): HumanApprovalRequest {
    const token = crypto.randomUUID();
    const createdAt = this.now();
    const request: HumanApprovalRequest = {
      expiresAt: new Date(createdAt + this.ttlMs()).toISOString(),
      id: crypto.randomUUID(),
      reason: formatApprovalReason(toolCall, reason, createOptions.reasonSource ?? "local"),
      risk: approvalRisk(toolCall),
      token,
      toolCall
    };

    this.approvals.set(token, request);
    return request;
  }

  consume(token: string, toolCall: BrowserToolCall): HumanApprovalRequest | undefined {
    const request = this.approvals.get(token);
    if (!request) {
      return undefined;
    }

    if (this.isExpired(request)) {
      this.approvals.delete(token);
      return undefined;
    }

    if (toolCallsMatch(request.toolCall, toolCall)) {
      this.approvals.delete(token);
      return request;
    }

    return undefined;
  }

  get(token: string, approvalId: string): HumanApprovalRequest | undefined {
    const request = this.approvals.get(token);
    if (!request || request.id !== approvalId) {
      return undefined;
    }

    if (this.isExpired(request)) {
      this.approvals.delete(token);
      return undefined;
    }

    return request;
  }

  reject(token: string, approvalId: string): HumanApprovalRequest | undefined {
    const request = this.get(token, approvalId);
    if (!request) {
      return undefined;
    }

    this.approvals.delete(token);
    return request;
  }

  revokeByToolCallIds(toolCallIds: Iterable<string>): number {
    this.pruneExpired();
    const ids = new Set(toolCallIds);
    let revokedCount = 0;

    for (const [token, request] of this.approvals.entries()) {
      if (ids.has(request.toolCall.id)) {
        this.approvals.delete(token);
        revokedCount += 1;
      }
    }

    return revokedCount;
  }

  private isExpired(request: HumanApprovalRequest): boolean {
    return Date.parse(request.expiresAt) <= this.now();
  }

  private now(): number {
    return this.options.now?.() ?? Date.now();
  }

  private pruneExpired(): void {
    for (const [token, request] of this.approvals.entries()) {
      if (this.isExpired(request)) {
        this.approvals.delete(token);
      }
    }
  }

  private ttlMs(): number {
    return Math.max(1, this.options.ttlMs ?? defaultApprovalTtlMs);
  }
}

function toolCallsMatch(approved: BrowserToolCall, candidate: BrowserToolCall): boolean {
  return approved.toolName === candidate.toolName &&
    approved.tabId === candidate.tabId &&
    stableJson(approved.args) === stableJson(candidate.args);
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map((item) => stableJson(item)).join(",")}]`;
  }

  if (typeof value === "object" && value !== null) {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${stableJson(record[key])}`).join(",")}}`;
  }

  return JSON.stringify(value);
}

function approvalRisk(toolCall: BrowserToolCall): HumanApprovalRequest["risk"] {
  if (!isHighRiskTool(toolCall.toolName)) {
    return "medium";
  }

  switch (toolCall.toolName) {
    case "click":
      return isSensitiveClick(toolCall) ? "high" : "medium";
    case "navigate":
      return isSensitiveNavigation(toolCall) ? "high" : "medium";
    case "openTab":
      return isSensitiveNavigation(toolCall) ? "high" : "medium";
    case "closeTab":
      return "high";
    case "downloadUrl":
      return "high";
    case "type":
    case "press":
      return "high";
    default:
      return "medium";
  }
}

function approvalReason(toolCall: BrowserToolCall): string {
  switch (toolCall.toolName) {
    case "navigate":
      return approvalRisk(toolCall) === "high"
        ? "Navigation leaves the current site or appears related to authentication, payment, account, or download flows."
        : "Navigation can leave the current site or trigger authentication flows.";
    case "openTab":
      return approvalRisk(toolCall) === "high"
        ? "Opening this tab leaves the current site or appears related to authentication, payment, account, or download flows."
        : "Opening a new tab can leave the current site or trigger authentication flows.";
    case "closeTab":
      return "Closing a tab can discard local page state, unsaved form data, or in-progress work.";
    case "downloadUrl":
      return "Downloading can save files locally or expose sensitive URLs. Review the source and destination before execution.";
    case "click":
      return approvalRisk(toolCall) === "high"
        ? "This click appears related to submit, send, download, login, payment, purchase, delete, or another sensitive page action."
        : "Click actions can submit forms, start downloads, or trigger irreversible page actions.";
    case "type":
      return "Typing can expose personal data or alter remote forms.";
    case "press":
      return "Keyboard actions can submit forms or trigger page shortcuts.";
    default:
      return "This action needs review before execution.";
  }
}

function formatApprovalReason(
  toolCall: BrowserToolCall,
  reason: string | undefined,
  source: ApprovalCreateOptions["reasonSource"]
): string {
  const localReason = approvalReason(toolCall);
  const trimmedReason = reason?.trim();
  if (!trimmedReason) {
    return localReason;
  }

  if (source === "provider") {
    return `${localReason} Provider note: ${trimmedReason.slice(0, 500)}`;
  }

  return trimmedReason.slice(0, 500);
}

const sensitiveClickPattern =
  /(submit|send|save|delete|remove|destroy|purchase|buy|pay|payment|checkout|order|download|login|log in|sign in|sign up|authenticate|auth|oauth|logout|transfer|subscribe|unsubscribe|confirm|commit|提交|送信|发送|刪除|删除|購入|支払|ログイン|サインイン|登録|ダウンロード)/i;

const sensitiveNavigationPattern =
  /(login|signin|sign-in|signup|sign-up|auth|oauth|account|checkout|payment|pay|billing|download|delete|purchase|order|subscribe|unsubscribe|登录|登入|注册|支付|付款|账单|下載|下载|ログイン|サインイン|登録|支払|購入|ダウンロード)/i;

function isSensitiveClick(toolCall: BrowserToolCall): boolean {
  const haystack = [
    toolCall.args.selector,
    toolCall.args.description
  ].filter((value): value is string => typeof value === "string").join(" ");

  return sensitiveClickPattern.test(haystack);
}

function isSensitiveNavigation(toolCall: BrowserToolCall): boolean {
  const rawUrl = typeof toolCall.args.url === "string" ? toolCall.args.url : "";
  if (isCrossOriginNavigation(toolCall.args.sourceUrl, rawUrl)) {
    return true;
  }

  try {
    const url = new URL(rawUrl);
    return sensitiveNavigationPattern.test(`${url.hostname} ${url.pathname} ${url.search}`);
  } catch {
    return sensitiveNavigationPattern.test(rawUrl);
  }
}

function isCrossOriginNavigation(sourceUrl: unknown, destinationUrl: string): boolean {
  if (typeof sourceUrl !== "string" || !sourceUrl) {
    return false;
  }

  try {
    const source = new URL(sourceUrl);
    const destination = new URL(destinationUrl);
    return source.origin !== destination.origin;
  } catch {
    return false;
  }
}
