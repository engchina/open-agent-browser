import { z } from "zod";

export const browserToolNames = [
  "navigate",
  "click",
  "type",
  "press",
  "scroll",
  "extractText",
  "extractLinks",
  "screenshot",
  "getPageSnapshot",
  "listTabs",
  "activateTab",
  "openTab",
  "closeTab",
  "downloadUrl"
] as const;

export const highRiskToolNames = [
  "click",
  "type",
  "press",
  "navigate",
  "openTab",
  "closeTab",
  "downloadUrl"
] as const;

export const browserToolNameSchema = z.enum(browserToolNames);
export type BrowserToolName = z.infer<typeof browserToolNameSchema>;

export const toolArgSchemas = {
  navigate: z.object({
    sourceUrl: z.string().url().or(z.literal("about:blank")).optional(),
    url: z.string().url()
  }),
  click: z.object({
    selector: z.string().min(1),
    description: z.string().optional(),
    expectedUrl: z.string().url().or(z.literal("about:blank")).optional()
  }),
  type: z.object({
    selector: z.string().min(1),
    text: z.string(),
    clearFirst: z.boolean().default(false),
    expectedUrl: z.string().url().or(z.literal("about:blank")).optional()
  }),
  press: z.object({
    key: z.string().min(1).max(40),
    expectedUrl: z.string().url().or(z.literal("about:blank")).optional()
  }),
  scroll: z.object({
    direction: z.enum(["up", "down", "left", "right"]),
    amount: z.number().int().positive().max(5000).default(800)
  }),
  extractText: z.object({
    selector: z.string().optional()
  }),
  extractLinks: z.object({
    selector: z.string().optional()
  }),
  screenshot: z.object({
    fullPage: z.boolean().default(false)
  }),
  getPageSnapshot: z.object({
    includeLinks: z.boolean().default(true),
    includeInputs: z.boolean().default(true)
  }),
  listTabs: z.object({
    currentWindow: z.boolean().default(true)
  }),
  activateTab: z.object({
    tabId: z.number().int().nonnegative(),
    windowId: z.number().int().nonnegative().optional()
  }),
  openTab: z.object({
    active: z.boolean().default(true),
    sourceUrl: z.string().url().or(z.literal("about:blank")).optional(),
    url: z.string().url()
  }),
  closeTab: z.object({
    tabId: z.number().int().nonnegative(),
    title: z.string().optional(),
    url: z.string().optional(),
    windowId: z.number().int().nonnegative().optional()
  }),
  downloadUrl: z.object({
    conflictAction: z.enum(["uniquify", "overwrite", "prompt"]).default("uniquify"),
    filename: z.string().min(1).max(240).optional(),
    saveAs: z.boolean().default(true),
    sourceUrl: z.string().url().or(z.literal("about:blank")).optional(),
    url: z.string().url()
  })
} satisfies Record<BrowserToolName, z.ZodTypeAny>;

export const browserToolCallSchema = z.object({
  id: z.string().min(1),
  tabId: z.number().int().nonnegative().optional(),
  toolName: browserToolNameSchema,
  args: z.record(z.string(), z.unknown()),
  confirmationToken: z.string().min(1).optional()
});

export type BrowserToolCall = z.infer<typeof browserToolCallSchema>;

export const browserToolExecuteRequestSchema = browserToolCallSchema.extend({
  id: z.string().min(1).optional()
});

export type BrowserToolExecuteRequest = z.infer<typeof browserToolExecuteRequestSchema>;

export const browserToolResultSchema = z.object({
  auditLogId: z.string().min(1).optional(),
  approvalRequest: z
    .object({
      expiresAt: z.string().datetime(),
      id: z.string().min(1),
      token: z.string().min(1),
      reason: z.string().min(1),
      risk: z.enum(["low", "medium", "high"]),
      toolCall: browserToolCallSchema
    })
    .optional(),
  error: z.string().optional(),
  result: z.unknown().optional(),
  status: z.enum(["completed", "queued", "requires_approval", "rejected", "error"]),
  toolName: browserToolNameSchema
});

export type BrowserToolResult = z.infer<typeof browserToolResultSchema>;

export const pageElementSchema = z.object({
  attributes: z.record(z.string(), z.string()).default({}),
  role: z.string().optional(),
  selector: z.string(),
  tagName: z.string(),
  text: z.string().default("")
});

export const pageHeadingSchema = z.object({
  level: z.number().int().min(1).max(6),
  selector: z.string(),
  text: z.string().default("")
});

export const pageTableSchema = z.object({
  caption: z.string().optional(),
  headers: z.array(z.string()).default([]),
  rows: z.array(z.array(z.string())).default([]),
  selector: z.string()
});

export const pageSnapshotSchema = z.object({
  capturedAt: z.string().datetime(),
  elements: z.array(pageElementSchema).default([]),
  headings: z.array(pageHeadingSchema).default([]),
  links: z
    .array(
      z.object({
        href: z.string(),
        text: z.string()
      })
    )
    .default([]),
  tables: z.array(pageTableSchema).default([]),
  tabId: z.number().int().nonnegative().optional(),
  text: z.string().default(""),
  title: z.string().default(""),
  url: z.string().url().or(z.literal("about:blank"))
});

export type PageElement = z.infer<typeof pageElementSchema>;
export type PageHeading = z.infer<typeof pageHeadingSchema>;
export type PageTable = z.infer<typeof pageTableSchema>;
export type PageSnapshot = Omit<z.infer<typeof pageSnapshotSchema>, "headings" | "tables"> & {
  headings?: PageHeading[];
  tables?: PageTable[];
};

export const pageSnapshotClearResponseSchema = z.object({
  cleared: z.number().int().nonnegative()
});

export type PageSnapshotClearResponse = z.infer<typeof pageSnapshotClearResponseSchema>;

export const agentPlanStepSchema = z.object({
  id: z.string().min(1),
  description: z.string().min(1),
  origin: z.enum(["local", "provider-plan", "provider-continuation"]).optional(),
  status: z.enum(["pending", "running", "blocked", "completed", "failed", "canceled"]),
  toolCall: browserToolCallSchema.optional()
});

export type AgentPlanStep = z.infer<typeof agentPlanStepSchema>;

export const humanApprovalRequestSchema = browserToolResultSchema.shape.approvalRequest.unwrap();
export type HumanApprovalRequest = z.infer<typeof humanApprovalRequestSchema>;

export const approvalRejectRequestSchema = z.object({
  approvalId: z.string().min(1),
  reason: z.string().max(500).optional(),
  stepId: z.string().min(1).optional(),
  taskId: z.string().min(1).optional(),
  token: z.string().min(1),
  toolCallId: z.string().min(1).optional()
});

export type ApprovalRejectRequest = z.infer<typeof approvalRejectRequestSchema>;

export const providerConfigSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("disabled")
  }),
  z.object({
    apiKey: z.string().min(1),
    baseUrl: z.string().url(),
    model: z.string().min(1),
    type: z.literal("openai-compatible")
  }),
  z.object({
    baseUrl: z.string().url(),
    model: z.string().min(1),
    type: z.literal("ollama")
  })
]);

export type ProviderConfig = z.infer<typeof providerConfigSchema>;

export const redactedProviderConfigSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("disabled")
  }),
  z.object({
    apiKey: z.string().optional(),
    baseUrl: z.string().url(),
    model: z.string().min(1),
    type: z.literal("openai-compatible")
  }),
  z.object({
    baseUrl: z.string().url(),
    model: z.string().min(1),
    type: z.literal("ollama")
  })
]);

export type RedactedProviderConfig = z.infer<typeof redactedProviderConfigSchema>;

export const providerConfigResponseSchema = z.object({
  config: redactedProviderConfigSchema,
  source: z.enum(["environment", "stored", "default"])
});

export type ProviderConfigResponse = z.infer<typeof providerConfigResponseSchema>;

export const healthResponseSchema = z.object({
  provider: redactedProviderConfigSchema,
  providerSource: z.enum(["environment", "stored", "default"]),
  status: z.literal("ok")
});

export type HealthResponse = z.infer<typeof healthResponseSchema>;

export const providerConfigTestResponseSchema = z.object({
  config: redactedProviderConfigSchema,
  message: z.string(),
  ok: z.boolean()
});

export type ProviderConfigTestResponse = z.infer<typeof providerConfigTestResponseSchema>;

export type ContextPolicy = "visible-text" | "interactive-elements" | "full-snapshot";

export const chatRequestSchema = z.object({
  contextPolicy: z
    .enum(["visible-text", "interactive-elements", "full-snapshot"])
    .default("interactive-elements"),
  message: z.string().min(1),
  pageSnapshot: pageSnapshotSchema.optional(),
  tabId: z.number().int().nonnegative().optional()
});

export type ChatRequest = Omit<z.infer<typeof chatRequestSchema>, "pageSnapshot"> & {
  pageSnapshot?: PageSnapshot | undefined;
};

export const chatResponseSchema = z.object({
  approvalRequests: z.array(humanApprovalRequestSchema),
  message: z.string(),
  plan: z.array(agentPlanStepSchema),
  taskId: z.string().min(1)
});

export type ChatResponse = z.infer<typeof chatResponseSchema>;

export const taskToolResultReportSchema = z.object({
  result: browserToolResultSchema,
  stepId: z.string().min(1),
  toolCallId: z.string().min(1)
});

export type TaskToolResultReport = z.infer<typeof taskToolResultReportSchema>;

export const taskToolResultRecordSchema = taskToolResultReportSchema.extend({
  createdAt: z.string().datetime(),
  id: z.string().min(1)
});

export type TaskToolResultRecord = z.infer<typeof taskToolResultRecordSchema>;

export const taskArtifactSchema = z.object({
  byteLength: z.number().int().nonnegative(),
  content: z.string(),
  createdAt: z.string().datetime(),
  id: z.string().min(1),
  kind: z.enum(["json", "text", "links", "snapshot", "screenshot-metadata", "tabs"]),
  mimeType: z.string().min(1),
  source: z.enum(["agent-output", "tool-result"]),
  sourceResultId: z.string().min(1).optional(),
  taskId: z.string().min(1),
  title: z.string().min(1)
});

export type TaskArtifact = z.infer<typeof taskArtifactSchema>;

export const taskRunSchema = z.object({
  createdAt: z.string().datetime(),
  message: z.string(),
  output: z.string().optional(),
  plan: z.array(agentPlanStepSchema),
  results: z.array(taskToolResultRecordSchema),
  status: z.enum(["pending", "running", "blocked", "completed", "failed", "canceled"]),
  taskId: z.string().min(1),
  updatedAt: z.string().datetime()
});

export type TaskRun = z.infer<typeof taskRunSchema>;

export const taskCancelRequestSchema = z.object({
  reason: z.string().max(500).optional()
});

export type TaskCancelRequest = z.infer<typeof taskCancelRequestSchema>;

export const taskCancelResponseSchema = z.object({
  task: taskRunSchema
});

export type TaskCancelResponse = z.infer<typeof taskCancelResponseSchema>;

export const taskCancelAllRequestSchema = z.object({
  reason: z.string().max(500).optional()
});

export type TaskCancelAllRequest = z.infer<typeof taskCancelAllRequestSchema>;

export const taskCancelAllResponseSchema = z.object({
  canceledTaskCount: z.number().int().nonnegative(),
  revokedApprovalCount: z.number().int().nonnegative(),
  tasks: z.array(taskRunSchema)
});

export type TaskCancelAllResponse = z.infer<typeof taskCancelAllResponseSchema>;

export const taskDeleteResponseSchema = z.object({
  artifactCount: z.number().int().nonnegative(),
  deleted: z.literal(true),
  resultCount: z.number().int().nonnegative(),
  revokedApprovalCount: z.number().int().nonnegative(),
  taskId: z.string().min(1)
});

export type TaskDeleteResponse = z.infer<typeof taskDeleteResponseSchema>;

export const taskContinuationSchema = z.object({
  message: z.string().min(1)
});

export type TaskContinuation = z.infer<typeof taskContinuationSchema>;

export const taskToolResultResponseSchema = z.object({
  approvalRequests: z.array(humanApprovalRequestSchema).default([]),
  continuation: taskContinuationSchema.optional(),
  task: taskRunSchema
});

export type TaskToolResultResponse = z.infer<typeof taskToolResultResponseSchema>;

export const approvalRejectResponseSchema = z.object({
  result: browserToolResultSchema,
  task: taskRunSchema.optional()
});

export type ApprovalRejectResponse = z.infer<typeof approvalRejectResponseSchema>;

export const taskListResponseSchema = z.object({
  tasks: z.array(taskRunSchema)
});

export type TaskListResponse = z.infer<typeof taskListResponseSchema>;

export const taskResponseSchema = z.object({
  task: taskRunSchema
});

export type TaskResponse = z.infer<typeof taskResponseSchema>;

export const taskArtifactListResponseSchema = z.object({
  artifacts: z.array(taskArtifactSchema)
});

export type TaskArtifactListResponse = z.infer<typeof taskArtifactListResponseSchema>;

export const taskArtifactDeleteResponseSchema = z.object({
  artifactId: z.string().min(1),
  deleted: z.literal(true),
  taskId: z.string().min(1)
});

export type TaskArtifactDeleteResponse = z.infer<typeof taskArtifactDeleteResponseSchema>;

export const auditEventSchema = z.object({
  createdAt: z.string().datetime(),
  id: z.string().min(1),
  payload: z.unknown(),
  type: z.string().min(1)
});

export type AuditEvent = z.infer<typeof auditEventSchema>;

export const auditEventListResponseSchema = z.object({
  events: z.array(auditEventSchema)
});

export type AuditEventListResponse = z.infer<typeof auditEventListResponseSchema>;

export const agentRealtimeEventSchema = z.discriminatedUnion("kind", [
  z.object({
    connectionId: z.string().min(1),
    createdAt: z.string().datetime(),
    kind: z.literal("hello")
  }),
  z.object({
    event: auditEventSchema,
    kind: z.literal("audit")
  }),
  z.object({
    kind: z.literal("task"),
    task: taskRunSchema
  })
]);

export type AgentRealtimeEvent = z.infer<typeof agentRealtimeEventSchema>;

export const memoryRecordSchema = z.object({
  content: z.string().min(1),
  createdAt: z.string().datetime(),
  id: z.string().min(1),
  tags: z.array(z.string())
});

export type MemoryRecord = z.infer<typeof memoryRecordSchema>;

export const pendingMemoryWriteSchema = z.object({
  content: z.string().min(1),
  id: z.string().min(1),
  tags: z.array(z.string()),
  token: z.string().min(1)
});

export type PendingMemoryWrite = z.infer<typeof pendingMemoryWriteSchema>;

export const memoryListResponseSchema = z.object({
  memories: z.array(memoryRecordSchema)
});

export type MemoryListResponse = z.infer<typeof memoryListResponseSchema>;

export const pendingMemoryWriteResponseSchema = z.object({
  pending: pendingMemoryWriteSchema,
  status: z.literal("requires_approval")
});

export type PendingMemoryWriteResponse = z.infer<typeof pendingMemoryWriteResponseSchema>;

export const confirmedMemoryWriteResponseSchema = z.object({
  memory: memoryRecordSchema
});

export type ConfirmedMemoryWriteResponse = z.infer<typeof confirmedMemoryWriteResponseSchema>;

export const memoryDeleteResponseSchema = z.object({
  deleted: z.literal(true),
  memoryId: z.string().min(1)
});

export type MemoryDeleteResponse = z.infer<typeof memoryDeleteResponseSchema>;

export interface ApprovalDisplayDetail {
  label: string;
  value: string;
}

export interface ApprovalDisplaySummary {
  details: ApprovalDisplayDetail[];
  title: string;
}

export function isHighRiskTool(toolName: BrowserToolName): boolean {
  return (highRiskToolNames as readonly string[]).includes(toolName);
}

export function validateToolArgs(
  toolName: BrowserToolName,
  args: Record<string, unknown>
): Record<string, unknown> {
  return toolArgSchemas[toolName].parse(args) as Record<string, unknown>;
}

export function summarizeBrowserToolResultForHistory(result: BrowserToolResult): BrowserToolResult {
  const summarized: BrowserToolResult = {
    ...result
  };

  delete summarized.approvalRequest;

  if (result.toolName === "screenshot" && isRecord(result.result)) {
    const dataUrl = typeof result.result.dataUrl === "string" ? result.result.dataUrl : undefined;

    summarized.result = {
      ...result.result,
      ...(dataUrl ? summarizeDataUrl(dataUrl) : {}),
      dataUrl: dataUrl ? "[redacted]" : result.result.dataUrl,
      redacted: Boolean(dataUrl)
    };
  }

  if (result.toolName === "extractLinks" && isRecord(result.result) && Array.isArray(result.result.links)) {
    summarized.result = {
      ...result.result,
      links: result.result.links.flatMap((link) => {
        if (!isRecord(link) || typeof link.href !== "string") {
          return [];
        }

        return [sanitizeLinkReference({
          href: link.href,
          text: typeof link.text === "string" ? link.text : ""
        })];
      })
    };
  }

  if (result.toolName === "extractText" && isRecord(result.result) && typeof result.result.text === "string") {
    summarized.result = {
      ...result.result,
      text: redactSensitiveText(result.result.text)
    };
  }

  return summarized;
}

export function summarizeToolCallForApproval(toolCall: BrowserToolCall): ApprovalDisplaySummary {
  const details: ApprovalDisplayDetail[] = [];
  const addDetail = (label: string, value: unknown, sensitiveHint?: string) => {
    details.push({
      label,
      value: formatApprovalValue(value, sensitiveHint)
    });
  };

  switch (toolCall.toolName) {
    case "navigate":
      addDetail("Current URL", toolCall.args.sourceUrl);
      addDetail("Destination URL", toolCall.args.url);
      addDetail("Site change", summarizeNavigationSiteChange(toolCall.args.sourceUrl, toolCall.args.url));
      break;
    case "openTab":
      addDetail("Current URL", toolCall.args.sourceUrl);
      addDetail("New tab URL", toolCall.args.url);
      addDetail("Site change", summarizeNavigationSiteChange(toolCall.args.sourceUrl, toolCall.args.url));
      addDetail("Activate", toolCall.args.active);
      break;
    case "closeTab":
      addDetail("Tab ID", toolCall.args.tabId);
      addDetail("Window ID", toolCall.args.windowId);
      addDetail("Title", toolCall.args.title);
      addDetail("URL", toolCall.args.url);
      break;
    case "downloadUrl":
      addDetail("Current URL", toolCall.args.sourceUrl);
      addDetail("Download URL", toolCall.args.url);
      addDetail("Site change", summarizeNavigationSiteChange(toolCall.args.sourceUrl, toolCall.args.url));
      addDetail("Filename", toolCall.args.filename);
      addDetail("Save as", toolCall.args.saveAs);
      addDetail("Conflict action", toolCall.args.conflictAction);
      break;
    case "click":
      addDetail("Expected URL", toolCall.args.expectedUrl);
      addDetail("Selector", toolCall.args.selector);
      addDetail("Description", toolCall.args.description);
      break;
    case "type":
      addDetail("Expected URL", toolCall.args.expectedUrl);
      addDetail("Selector", toolCall.args.selector);
      addDetail("Text", toolCall.args.text, String(toolCall.args.selector ?? ""));
      addDetail("Clear first", toolCall.args.clearFirst);
      break;
    case "press":
      addDetail("Expected URL", toolCall.args.expectedUrl);
      addDetail("Key", toolCall.args.key);
      break;
    default:
      addDetail("Arguments", stableJson(toolCall.args));
      break;
  }

  return {
    details: details.filter((detail) => detail.value.length > 0),
    title: approvalTitle(toolCall.toolName)
  };
}

function summarizeNavigationSiteChange(sourceUrl: unknown, destinationUrl: unknown): string {
  if (typeof sourceUrl !== "string" || typeof destinationUrl !== "string") {
    return "";
  }

  try {
    const source = new URL(sourceUrl);
    const destination = new URL(destinationUrl);
    if (source.origin === destination.origin) {
      return "same-origin";
    }

    return `${source.origin} -> ${destination.origin}`;
  } catch {
    return "";
  }
}

const sensitiveAttributeHintPattern =
  /(password|passcode|token|secret|credential|api[_ -]?key|card|cc-|cvv|ssn)/i;
const sensitiveApprovalPattern =
  /(password|passcode|token|secret|credential|api[_ -]?key|bearer\s+[a-z0-9._-]+|sk-[a-z0-9]|card|cvv|ssn)/i;
const likelyCardNumberPattern = /\b(?:\d[ -]*?){13,19}\b/;
const emailAddressPattern = /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/i;
const bearerTokenTextPattern = /\bbearer\s+[a-z0-9._~+/=-]+\b/gi;
const emailAddressTextPattern = /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi;
const likelyCardNumberTextPattern = /\b(?:\d[ -]*?){13,19}\b/g;
const openAiKeyTextPattern = /\bsk-[A-Za-z0-9_-]{8,}\b/g;

function truncate(value: string, maxLength: number): string {
  return value.length <= maxLength ? value : `${value.slice(0, maxLength)}...`;
}

function approvalTitle(toolName: BrowserToolName): string {
  switch (toolName) {
    case "navigate":
      return "Navigate";
    case "openTab":
      return "Open new tab";
    case "closeTab":
      return "Close tab";
    case "downloadUrl":
      return "Download file";
    case "click":
      return "Click page element";
    case "type":
      return "Type into page";
    case "press":
      return "Press key";
    default:
      return toolName;
  }
}

function formatApprovalValue(value: unknown, sensitiveHint = ""): string {
  if (value === undefined || value === null) {
    return "";
  }

  const text = typeof value === "string" ? value : stableJson(value);
  if (sensitiveApprovalPattern.test(sensitiveHint) ||
    sensitiveApprovalPattern.test(text) ||
    likelyCardNumberPattern.test(text)) {
    return "[redacted]";
  }

  return truncate(text, 300);
}

function redactAttributes(attributes: Record<string, string>): Record<string, string> {
  const redacted: Record<string, string> = {};

  for (const [key, value] of Object.entries(attributes)) {
    if (shouldRedactAttribute(key, value)) {
      redacted[key] = "[redacted]";
    } else {
      redacted[key] = truncate(value, 240);
    }
  }

  return redacted;
}

function shouldRedactAttribute(key: string, value: string): boolean {
  if (key === "value") {
    return true;
  }

  return sensitiveAttributeHintPattern.test(key) ||
    sensitiveAttributeHintPattern.test(value) ||
    sensitiveApprovalPattern.test(value) ||
    likelyCardNumberPattern.test(value) ||
    emailAddressPattern.test(value);
}

function redactSensitiveText(value: string): string {
  return value
    .replace(bearerTokenTextPattern, "Bearer [redacted]")
    .replace(openAiKeyTextPattern, "[redacted]")
    .replace(likelyCardNumberTextPattern, "[redacted]")
    .replace(emailAddressTextPattern, "[redacted]");
}

function sanitizeUrl(value: string, maxLength: number): string {
  const truncated = truncate(value, maxLength);
  if (truncated === "about:blank") {
    return truncated;
  }

  try {
    const url = new URL(truncated);
    let changed = false;
    if (url.username || url.password) {
      url.username = "";
      url.password = "";
      changed = true;
    }

    for (const [key, queryValue] of [...url.searchParams.entries()]) {
      if (shouldRedactAttribute(key, queryValue)) {
        url.searchParams.set(key, "[redacted]");
        changed = true;
      }
    }

    return changed ? url.toString() : truncated;
  } catch {
    return redactSensitiveText(truncated);
  }
}

export function sanitizeLinkReference(link: { href: string; text: string }): { href: string; text: string } {
  return {
    href: sanitizeUrl(link.href, 2000),
    text: truncate(redactSensitiveText(link.text), 500)
  };
}

function summarizeDataUrl(dataUrl: string): { byteLength: number; mimeType: string } {
  const match = dataUrl.match(/^data:([^;,]+)?(;base64)?,(.*)$/);
  if (!match) {
    return {
      byteLength: dataUrl.length,
      mimeType: "unknown"
    };
  }

  const mimeType = match[1] ?? "text/plain";
  const encoding = match[2];
  const payload = match[3] ?? "";
  const byteLength = encoding === ";base64"
    ? Math.max(0, Math.floor((payload.length * 3) / 4) - (payload.match(/=+$/)?.[0].length ?? 0))
    : payload.length;

  return {
    byteLength,
    mimeType
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
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

export function sanitizePageSnapshot(
  snapshot: PageSnapshot,
  options: { maxElements?: number; maxTextLength?: number } = {}
): PageSnapshot {
  const maxElements = options.maxElements ?? 200;
  const maxTextLength = options.maxTextLength ?? 12000;

  return {
    ...snapshot,
    elements: snapshot.elements.slice(0, maxElements).map((element) => ({
      ...element,
      attributes: redactAttributes(element.attributes),
      text: truncate(redactSensitiveText(element.text), 1000)
    })),
    headings: (snapshot.headings ?? []).slice(0, 100).map((heading) => ({
      level: heading.level,
      selector: truncate(heading.selector, 1000),
      text: truncate(redactSensitiveText(heading.text), 500)
    })),
    links: snapshot.links.slice(0, 500).map(sanitizeLinkReference),
    tables: (snapshot.tables ?? []).slice(0, 20).map((table) => ({
      ...(table.caption ? { caption: truncate(redactSensitiveText(table.caption), 500) } : {}),
      headers: table.headers.slice(0, 20).map((header) => truncate(redactSensitiveText(header), 240)),
      rows: table.rows.slice(0, 50).map((row) =>
        row.slice(0, 20).map((cell) => truncate(redactSensitiveText(cell), 240))
      ),
      selector: truncate(table.selector, 1000)
    })),
    text: truncate(redactSensitiveText(snapshot.text), maxTextLength),
    title: truncate(redactSensitiveText(snapshot.title), 500),
    url: sanitizeUrl(snapshot.url, 2000) as PageSnapshot["url"]
  };
}

export function applyContextPolicyToSnapshot(
  snapshot: PageSnapshot,
  policy: ContextPolicy
): PageSnapshot {
  if (policy === "visible-text") {
    const sanitized = sanitizePageSnapshot(snapshot, {
      maxElements: 0,
      maxTextLength: 6000
    });

    return {
      ...sanitized,
      elements: [],
      headings: [],
      links: [],
      tables: []
    };
  }

  if (policy === "full-snapshot") {
    return sanitizePageSnapshot(snapshot, {
      maxElements: 500,
      maxTextLength: 30000
    });
  }

  return sanitizePageSnapshot(snapshot, {
    maxElements: 200,
    maxTextLength: 12000
  });
}
