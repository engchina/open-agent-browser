import {
  approvalRejectResponseSchema,
  browserToolResultSchema,
  auditEventListResponseSchema,
  chatResponseSchema,
  confirmedMemoryWriteResponseSchema,
  healthResponseSchema,
  memoryDeleteResponseSchema,
  memoryListResponseSchema,
  pageSnapshotClearResponseSchema,
  pageSnapshotSchema,
  pendingMemoryWriteResponseSchema,
  providerConfigTestResponseSchema,
  providerConfigResponseSchema,
  taskCancelAllResponseSchema,
  taskArtifactDeleteResponseSchema,
  taskCancelResponseSchema,
  taskArtifactListResponseSchema,
  taskDeleteResponseSchema,
  taskResponseSchema,
  taskToolResultResponseSchema,
  taskListResponseSchema,
  type AuditEvent,
  type ApprovalRejectRequest,
  type ApprovalRejectResponse,
  type BrowserToolCall,
  type BrowserToolResult,
  type ChatRequest,
  type ChatResponse,
  type ConfirmedMemoryWriteResponse,
  type HealthResponse,
  type MemoryRecord,
  type MemoryDeleteResponse,
  type PageSnapshot,
  type PageSnapshotClearResponse,
  type PendingMemoryWriteResponse,
  type ProviderConfig,
  type ProviderConfigResponse,
  type ProviderConfigTestResponse,
  type TaskArtifact,
  type TaskArtifactDeleteResponse,
  type TaskCancelAllResponse,
  type TaskDeleteResponse,
  type TaskRun,
  type TaskCancelResponse,
  type TaskToolResultResponse,
  type TaskToolResultReport
} from "@open-agent-browser/shared";

const defaultBaseUrl = "http://127.0.0.1:17376";

export async function getAgentBaseUrl(): Promise<string> {
  const stored = await chrome.storage.local.get("agentBaseUrl");
  if (typeof stored.agentBaseUrl === "string" && stored.agentBaseUrl.length > 0) {
    return stored.agentBaseUrl;
  }

  return await readPackagedAgentBaseUrl() ?? defaultBaseUrl;
}

export async function sendChat(request: ChatRequest): Promise<ChatResponse> {
  const response = await postJson("/v1/chat", request);
  return chatResponseSchema.parse(response);
}

export async function getHealth(): Promise<HealthResponse> {
  const response = await getJson("/health");
  return healthResponseSchema.parse(response);
}

export async function openAgentEventSocket(): Promise<WebSocket> {
  const baseUrl = await getAgentBaseUrl();
  const url = new URL(baseUrl);
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  url.pathname = "/v1/events";
  url.search = "";
  url.hash = "";
  return new WebSocket(url);
}

export async function publishPageSnapshot(snapshot: PageSnapshot): Promise<PageSnapshot> {
  const response = await postJson("/v1/page/snapshot", snapshot);
  return pageSnapshotSchema.parse(response);
}

export async function fetchPublishedPageSnapshot(tabId?: number): Promise<PageSnapshot> {
  const query = typeof tabId === "number" ? `?tabId=${encodeURIComponent(String(tabId))}` : "";
  const response = await getJson(`/v1/page/snapshot${query}`);
  return pageSnapshotSchema.parse(response);
}

export async function clearPublishedPageSnapshot(tabId?: number): Promise<PageSnapshotClearResponse> {
  const query = typeof tabId === "number" ? `?tabId=${encodeURIComponent(String(tabId))}` : "";
  const response = await deleteJson(`/v1/page/snapshot${query}`);
  return pageSnapshotClearResponseSchema.parse(response);
}

export async function requestToolExecution(call: BrowserToolCall): Promise<BrowserToolResult> {
  const response = await postJson("/v1/tools/execute", call);
  return browserToolResultSchema.parse(response);
}

export async function rejectApproval(request: ApprovalRejectRequest): Promise<ApprovalRejectResponse> {
  const response = await postJson("/v1/approvals/reject", request);
  return approvalRejectResponseSchema.parse(response);
}

export async function reportToolResult(
  taskId: string,
  report: TaskToolResultReport
): Promise<TaskToolResultResponse> {
  const response = await postJson(`/v1/tasks/${encodeURIComponent(taskId)}/tool-results`, report);
  return taskToolResultResponseSchema.parse(response);
}

export async function listTasks(): Promise<TaskRun[]> {
  const response = await getJson("/v1/tasks");
  return taskListResponseSchema.parse(response).tasks;
}

export async function fetchTask(taskId: string): Promise<TaskRun> {
  const response = await getJson(`/v1/tasks/${encodeURIComponent(taskId)}`);
  return taskResponseSchema.parse(response).task;
}

export async function deleteTask(taskId: string): Promise<TaskDeleteResponse> {
  const response = await deleteJson(`/v1/tasks/${encodeURIComponent(taskId)}`);
  return taskDeleteResponseSchema.parse(response);
}

export async function listTaskArtifacts(taskId: string): Promise<TaskArtifact[]> {
  const response = await getJson(`/v1/tasks/${encodeURIComponent(taskId)}/artifacts`);
  return taskArtifactListResponseSchema.parse(response).artifacts;
}

export async function deleteTaskArtifact(
  taskId: string,
  artifactId: string
): Promise<TaskArtifactDeleteResponse> {
  const response = await deleteJson(`/v1/tasks/${encodeURIComponent(taskId)}/artifacts/${encodeURIComponent(artifactId)}`);
  return taskArtifactDeleteResponseSchema.parse(response);
}

export async function cancelTask(taskId: string, reason?: string): Promise<TaskCancelResponse> {
  const response = await postJson(`/v1/tasks/${encodeURIComponent(taskId)}/cancel`, {
    reason
  });
  return taskCancelResponseSchema.parse(response);
}

export async function cancelAllTasks(reason?: string): Promise<TaskCancelAllResponse> {
  const response = await postJson("/v1/tasks/cancel-all", {
    reason
  });
  return taskCancelAllResponseSchema.parse(response);
}

export async function listAuditEvents(): Promise<AuditEvent[]> {
  const response = await getJson("/v1/audit-events");
  return auditEventListResponseSchema.parse(response).events;
}

export async function listMemories(): Promise<MemoryRecord[]> {
  const response = await getJson("/v1/memory");
  return memoryListResponseSchema.parse(response).memories;
}

export async function deleteMemory(memoryId: string): Promise<MemoryDeleteResponse> {
  const response = await deleteJson(`/v1/memory/${encodeURIComponent(memoryId)}`);
  return memoryDeleteResponseSchema.parse(response);
}

export async function requestMemoryWrite(
  content: string,
  tags: string[] = []
): Promise<PendingMemoryWriteResponse> {
  const response = await postJson("/v1/memory", {
    content,
    tags
  });
  return pendingMemoryWriteResponseSchema.parse(response);
}

export async function confirmMemoryWrite(confirmToken: string): Promise<ConfirmedMemoryWriteResponse> {
  const response = await postJson("/v1/memory", {
    confirmToken
  });
  return confirmedMemoryWriteResponseSchema.parse(response);
}

export async function getProviderConfig(): Promise<ProviderConfigResponse> {
  const response = await getJson("/v1/provider-config");
  return providerConfigResponseSchema.parse(response);
}

export async function updateProviderConfig(config: ProviderConfig): Promise<ProviderConfigResponse> {
  const response = await putJson("/v1/provider-config", config);
  return providerConfigResponseSchema.parse(response);
}

export async function testProviderConfig(config: ProviderConfig): Promise<ProviderConfigTestResponse> {
  const response = await postJson("/v1/provider-config/test", config);
  return providerConfigTestResponseSchema.parse(response);
}

async function getJson(path: string): Promise<unknown> {
  const baseUrl = await getAgentBaseUrl();
  const response = await fetch(`${baseUrl}${path}`, {
    method: "GET"
  });
  const payload = await response.json() as unknown;

  if (!response.ok) {
    throw new Error(JSON.stringify(payload));
  }

  return payload;
}

async function postJson(path: string, body: unknown): Promise<unknown> {
  const baseUrl = await getAgentBaseUrl();
  const response = await fetch(`${baseUrl}${path}`, {
    body: JSON.stringify(body),
    headers: {
      "Content-Type": "application/json"
    },
    method: "POST"
  });

  const payload = await response.json() as unknown;
  if (!response.ok && response.status !== 202) {
    throw new Error(JSON.stringify(payload));
  }

  return payload;
}

async function putJson(path: string, body: unknown): Promise<unknown> {
  const baseUrl = await getAgentBaseUrl();
  const response = await fetch(`${baseUrl}${path}`, {
    body: JSON.stringify(body),
    headers: {
      "Content-Type": "application/json"
    },
    method: "PUT"
  });

  const payload = await response.json() as unknown;
  if (!response.ok) {
    throw new Error(JSON.stringify(payload));
  }

  return payload;
}

async function deleteJson(path: string): Promise<unknown> {
  const baseUrl = await getAgentBaseUrl();
  const response = await fetch(`${baseUrl}${path}`, {
    method: "DELETE"
  });

  const payload = await response.json() as unknown;
  if (!response.ok) {
    throw new Error(JSON.stringify(payload));
  }

  return payload;
}

async function readPackagedAgentBaseUrl(): Promise<string | undefined> {
  try {
    const response = await fetch(chrome.runtime.getURL("open-agent-config.json"), {
      cache: "no-store"
    });
    if (!response.ok) {
      return undefined;
    }

    const config = await response.json() as unknown;
    if (!isRecord(config) || typeof config.agentBaseUrl !== "string") {
      return undefined;
    }

    return config.agentBaseUrl.length > 0 ? config.agentBaseUrl : undefined;
  } catch {
    return undefined;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
