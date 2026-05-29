import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { randomUUID } from "node:crypto";
import {
  approvalRejectRequestSchema,
  applyContextPolicyToSnapshot,
  browserToolExecuteRequestSchema,
  chatRequestSchema,
  isHighRiskTool,
  pageSnapshotSchema,
  providerConfigSchema,
  taskCancelAllRequestSchema,
  taskCancelRequestSchema,
  taskToolResultReportSchema,
  validateToolArgs,
  type AuditEvent,
  type BrowserToolCall,
  type BrowserToolResult,
  type ChatRequest,
  type HealthResponse,
  type HumanApprovalRequest,
  type TaskArtifact,
  type TaskRun
} from "@open-agent-browser/shared";
import { z } from "zod";
import { ApprovalRegistry } from "./approval.js";
import { AuditLog } from "./audit.js";
import { SqliteMemoryStore } from "./memory.js";
import { PageSnapshotStore } from "./pageSnapshotStore.js";
import { applyProviderToolProposalsToPlan, parseProviderToolPlan, planChat } from "./planner.js";
import { loadProviderConfig, redactProviderConfig, testProviderConfig } from "./provider.js";
import { ProviderConfigStore } from "./providerStore.js";
import { RealtimeEventHub } from "./realtime.js";
import { buildProviderTaskContinuation, buildTaskContinuation } from "./taskContinuation.js";
import { TaskStore, TaskToolResultValidationError } from "./taskStore.js";

export interface AgentServerContext {
  approvals: ApprovalRegistry;
  auditLog: AuditLog;
  memory: SqliteMemoryStore;
  pageSnapshots: PageSnapshotStore;
  providerConfigStore: ProviderConfigStore;
  taskStore: TaskStore;
}

export interface AgentServerOptions {
  context: AgentServerContext;
}

const extensionOriginPattern = /^(chrome|moz)-extension:\/\/[a-z0-9-]+$/i;
const defaultProviderContinuationStepBudget = 8;

const memoryPostSchema = z.object({
  confirmToken: z.string().min(1).optional(),
  content: z.string().min(1).optional(),
  tags: z.array(z.string()).default([])
});

export function createAgentServer(options: AgentServerOptions) {
  const realtime = new RealtimeEventHub({
    isAllowedOrigin
  });
  const server = createServer((request, response) => {
    handleRequest(request, response, options.context, realtime).catch((error) => {
      writeJson(response, 500, {
        error: error instanceof Error ? error.message : "Unknown server error"
      });
    });
  });

  realtime.attach(server);
  return server;
}

async function handleRequest(
  request: IncomingMessage,
  response: ServerResponse,
  context: AgentServerContext,
  realtime: RealtimeEventHub
): Promise<void> {
  const url = new URL(request.url ?? "/", "http://127.0.0.1");
  const origin = firstHeader(request.headers.origin);

  if (!isAllowedOrigin(origin)) {
    writeJson(response, 403, {
      error: "Origin is not allowed for the local Open Agent API."
    });
    return;
  }

  applyCorsHeaders(response, origin);

  if (request.method === "OPTIONS") {
    response.writeHead(204);
    response.end();
    return;
  }

  if (request.method === "GET" && url.pathname === "/health") {
    const provider = getEffectiveProviderConfig(context);
    const body: HealthResponse = {
      provider: redactProviderConfig(provider.config),
      providerSource: provider.source,
      status: "ok"
    };
    writeJson(response, 200, body);
    return;
  }

  if (request.method === "GET" && url.pathname === "/v1/provider-config") {
    const provider = getEffectiveProviderConfig(context);
    writeJson(response, 200, {
      config: redactProviderConfig(provider.config),
      source: provider.source
    });
    return;
  }

  if (request.method === "PUT" && url.pathname === "/v1/provider-config") {
    const config = providerConfigSchema.parse(await readJson(request));
    const saved = context.providerConfigStore.save(config);
    appendAudit(context, realtime, "provider.config.updated", {
      config: redactProviderConfig(saved)
    });
    const provider = getEffectiveProviderConfig(context);
    writeJson(response, 200, {
      config: redactProviderConfig(provider.config),
      source: provider.source
    });
    return;
  }

  if (request.method === "POST" && url.pathname === "/v1/provider-config/test") {
    const config = providerConfigSchema.parse(await readJson(request));
    const result = await testProviderConfig(config, {
      signal: AbortSignal.timeout(7000)
    });
    appendAudit(context, realtime, "provider.config.tested", {
      config: redactProviderConfig(config),
      ok: result.ok
    });
    writeJson(response, 200, {
      config: redactProviderConfig(config),
      ...result
    });
    return;
  }

  if (request.method === "POST" && url.pathname === "/v1/chat") {
    const body = sanitizeChatRequest(chatRequestSchema.parse(await readJson(request)));
    const provider = getEffectiveProviderConfig(context);
    const memories = context.memory.list();
    const result = await planChat(body, context.approvals, {
      memories,
      providerConfig: provider.config
    });
    const task = context.taskStore.create(result);
    publishTask(realtime, task);
    appendAudit(context, realtime, "chat.plan", {
      approvalRequestCount: result.approvalRequests.length,
      memoryCount: memories.length,
      planStepCount: result.plan.length,
      providerSource: provider.source,
      taskId: result.taskId
    });
    writeJson(response, 200, result);
    return;
  }

  if (request.method === "GET" && url.pathname === "/v1/tasks") {
    writeJson(response, 200, {
      tasks: context.taskStore.list()
    });
    return;
  }

  if (request.method === "POST" && url.pathname === "/v1/tasks/cancel-all") {
    const body = taskCancelAllRequestSchema.parse(await readJson(request));
    const tasks = context.taskStore.cancelAllActive();
    const revokedApprovalCount = context.approvals.revokeByToolCallIds(tasks.flatMap(taskToolCallIds));

    for (const task of tasks) {
      publishTask(realtime, task);
    }

    appendAudit(context, realtime, "tasks.canceled", {
      canceledTaskCount: tasks.length,
      reason: body.reason,
      revokedApprovalCount,
      taskIds: tasks.map((task) => task.taskId)
    });
    writeJson(response, 200, {
      canceledTaskCount: tasks.length,
      revokedApprovalCount,
      tasks
    });
    return;
  }

  const taskMatch = url.pathname.match(/^\/v1\/tasks\/([^/]+)$/);
  if (taskMatch && request.method === "GET") {
    const task = context.taskStore.get(taskMatch[1]!);
    writeJson(response, task ? 200 : 404, task ? { task } : { error: "Task not found." });
    return;
  }

  if (taskMatch && request.method === "DELETE") {
    const taskId = decodeURIComponent(taskMatch[1]!);
    const task = context.taskStore.get(taskId);
    if (!task) {
      writeJson(response, 404, {
        error: "Task not found."
      });
      return;
    }

    const artifactCount = context.taskStore.listArtifacts(taskId).length;
    const revokedApprovalCount = context.approvals.revokeByToolCallIds(taskToolCallIds(task));
    const deleted = context.taskStore.delete(taskId);
    if (!deleted) {
      writeJson(response, 404, {
        error: "Task not found."
      });
      return;
    }

    appendAudit(context, realtime, "task.deleted", {
      artifactCount,
      planStepCount: deleted.plan.length,
      resultCount: deleted.results.length,
      revokedApprovalCount,
      status: deleted.status,
      taskId
    });
    writeJson(response, 200, {
      artifactCount,
      deleted: true,
      resultCount: deleted.results.length,
      revokedApprovalCount,
      taskId
    });
    return;
  }

  const taskArtifactsMatch = url.pathname.match(/^\/v1\/tasks\/([^/]+)\/artifacts$/);
  if (taskArtifactsMatch && request.method === "GET") {
    const taskId = taskArtifactsMatch[1]!;
    const task = context.taskStore.get(taskId);
    writeJson(response, task ? 200 : 404, task ? { artifacts: context.taskStore.listArtifacts(taskId) } : { error: "Task not found." });
    return;
  }

  const taskArtifactDeleteMatch = url.pathname.match(/^\/v1\/tasks\/([^/]+)\/artifacts\/([^/]+)$/);
  if (taskArtifactDeleteMatch && request.method === "DELETE") {
    const taskId = decodeURIComponent(taskArtifactDeleteMatch[1]!);
    const artifactId = decodeURIComponent(taskArtifactDeleteMatch[2]!);
    if (!context.taskStore.get(taskId)) {
      writeJson(response, 404, {
        error: "Task not found."
      });
      return;
    }

    const deleted = context.taskStore.deleteArtifact(taskId, artifactId);
    if (!deleted) {
      writeJson(response, 404, {
        error: "Artifact not found."
      });
      return;
    }

    appendAudit(context, realtime, "task.artifact.deleted", {
      artifact: summarizeArtifactForAudit(deleted),
      taskId
    });
    writeJson(response, 200, {
      artifactId: deleted.id,
      deleted: true,
      taskId
    });
    return;
  }

  const taskCancelMatch = url.pathname.match(/^\/v1\/tasks\/([^/]+)\/cancel$/);
  if (taskCancelMatch && request.method === "POST") {
    const body = taskCancelRequestSchema.parse(await readJson(request));
    const taskId = taskCancelMatch[1]!;
    const task = context.taskStore.cancel(taskId);
    if (!task) {
      writeJson(response, 404, { error: "Task not found." });
      return;
    }

    const revokedApprovalCount = context.approvals.revokeByToolCallIds(taskToolCallIds(task));
    publishTask(realtime, task);
    appendAudit(context, realtime, "task.canceled", {
      reason: body.reason,
      revokedApprovalCount,
      taskId
    });
    writeJson(response, 200, { task });
    return;
  }

  if (request.method === "GET" && url.pathname === "/v1/audit-events") {
    writeJson(response, 200, {
      events: context.auditLog.list()
    });
    return;
  }

  if (request.method === "POST" && url.pathname === "/v1/approvals/reject") {
    const body = approvalRejectRequestSchema.parse(await readJson(request));
    const approval = context.approvals.get(body.token, body.approvalId);

    if (!approval || (body.toolCallId && approval.toolCall.id !== body.toolCallId)) {
      writeJson(response, 404, {
        error: "Approval request not found."
      });
      return;
    }

    const hasPartialTaskContext = Boolean(body.taskId) !== Boolean(body.stepId);
    if (hasPartialTaskContext) {
      writeJson(response, 400, {
        error: "Approval rejection task context must include both taskId and stepId."
      });
      return;
    }

    const validationResult: BrowserToolResult = {
      error: body.reason ?? "Rejected by user.",
      status: "rejected",
      toolName: approval.toolCall.toolName
    };
    let report: {
      result: BrowserToolResult;
      stepId: string;
      toolCallId: string;
    } | undefined;

    if (body.taskId && body.stepId) {
      report = {
        result: validationResult,
        stepId: body.stepId,
        toolCallId: approval.toolCall.id
      };
      try {
        const taskExists = context.taskStore.validateToolResultReport(body.taskId, report);
        if (!taskExists) {
          writeJson(response, 404, {
            error: "Task not found."
          });
          return;
        }
      } catch (error) {
        if (error instanceof TaskToolResultValidationError) {
          writeJson(response, 400, {
            error: error.message
          });
          return;
        }
        throw error;
      }
    }

    const rejectedApproval = context.approvals.reject(body.token, body.approvalId);
    if (!rejectedApproval) {
      writeJson(response, 404, {
        error: "Approval request not found."
      });
      return;
    }

    const auditEvent = appendAudit(context, realtime, "approval.rejected", {
      approvalId: rejectedApproval.id,
      reason: body.reason,
      stepId: body.stepId,
      taskId: body.taskId,
      toolCallId: rejectedApproval.toolCall.id,
      toolName: rejectedApproval.toolCall.toolName
    });
    const result: BrowserToolResult = {
      auditLogId: auditEvent.id,
      error: body.reason ?? "Rejected by user.",
      status: "rejected",
      toolName: rejectedApproval.toolCall.toolName
    };
    let task: TaskRun | undefined;
    let artifactCountBeforeReport = 0;

    if (body.taskId && report) {
      report = {
        ...report,
        result
      };
      artifactCountBeforeReport = context.taskStore.listArtifacts(body.taskId).length;
      try {
        task = context.taskStore.recordToolResult(body.taskId, {
          result: report.result,
          stepId: report.stepId,
          toolCallId: report.toolCallId
        });
      } catch (error) {
        if (error instanceof TaskToolResultValidationError) {
          writeJson(response, 400, {
            error: error.message
          });
          return;
        }
        throw error;
      }
      if (task) {
        publishTask(realtime, task);
        appendAudit(context, realtime, "task.toolResult", {
          report,
          taskId: body.taskId
        });
        appendNewArtifactAudit(context, realtime, body.taskId, artifactCountBeforeReport);
      }
    }

    writeJson(response, 200, task ? { result, task } : { result });
    return;
  }

  const taskResultMatch = url.pathname.match(/^\/v1\/tasks\/([^/]+)\/tool-results$/);
  if (taskResultMatch && request.method === "POST") {
    const report = taskToolResultReportSchema.parse(await readJson(request));
    const taskId = taskResultMatch[1]!;
    const artifactCountBeforeReport = context.taskStore.listArtifacts(taskId).length;
    let task: TaskRun | undefined;
    try {
      task = context.taskStore.recordToolResult(taskId, report);
    } catch (error) {
      if (error instanceof TaskToolResultValidationError) {
        writeJson(response, 400, {
          error: error.message
        });
        return;
      }
      throw error;
    }
    const approvalRequests: HumanApprovalRequest[] = [];
    const provider = getEffectiveProviderConfig(context);
    const memories = context.memory.list();
    let continuation = task ? buildTaskContinuation(task) : undefined;

    if (task && continuation) {
      task = context.taskStore.setOutput(taskId, continuation.message) ?? task;
    }

    if (task && !continuation && provider.config.type !== "disabled") {
      if (!hasProviderContinuationBudget(task)) {
        continuation = {
          message: providerContinuationBudgetMessage(task)
        };
        task = context.taskStore.setOutput(taskId, continuation.message) ?? task;
      } else {
        const providerContinuation = await buildProviderTaskContinuation(
          task,
          provider.config,
          memories,
          { signal: AbortSignal.timeout(7000) }
        );

        if (providerContinuation) {
          const providerSourceUrl = inferTaskPageUrl(task);
          const providerTabId = inferTaskTabId(task);
          const providerPlan = parseProviderToolPlan(
            providerContinuation.message,
            {
              ...(providerSourceUrl ? { sourceUrl: providerSourceUrl } : {}),
              ...(providerTabId !== undefined ? { tabId: providerTabId } : {})
            }
          );
          const nextPlan = task.plan.map((step) => ({ ...step }));
          const addedCount = applyProviderToolProposalsToPlan(
            nextPlan,
            approvalRequests,
            context.approvals,
            providerPlan.toolCalls,
            "provider-continuation"
          );

          continuation = {
            message: providerPlan.message
          };

          if (addedCount > 0) {
            task = context.taskStore.updatePlan(taskId, nextPlan) ?? task;
          } else {
            task = context.taskStore.setOutput(taskId, continuation.message) ?? task;
          }
        }
      }
    }

    if (task) {
      publishTask(realtime, task);
      appendAudit(context, realtime, "task.toolResult", {
        report,
        taskId
      });
      appendNewArtifactAudit(context, realtime, taskId, artifactCountBeforeReport);
    }

    if (continuation) {
      appendAudit(context, realtime, "task.continuation", {
        approvalRequestCount: approvalRequests.length,
        providerContinuationStepBudget: providerContinuationStepBudget(),
        providerContinuationStepCount: task ? countProviderContinuationSteps(task) : undefined,
        providerSource: provider.source,
        taskId
      });
    }
    writeJson(response, task ? 200 : 404, task ? { approvalRequests, continuation, task } : { error: "Task not found." });
    return;
  }

  if (request.method === "POST" && url.pathname === "/v1/tools/execute") {
    const toolRequest = browserToolExecuteRequestSchema.parse(await readJson(request));
    const toolCall: BrowserToolCall = {
      args: toolRequest.args,
      id: toolRequest.id ?? randomUUID(),
      toolName: toolRequest.toolName,
      ...(toolRequest.tabId === undefined ? {} : { tabId: toolRequest.tabId }),
      ...(toolRequest.confirmationToken === undefined ? {} : { confirmationToken: toolRequest.confirmationToken })
    };
    const args = validateToolArgs(toolCall.toolName, toolCall.args);
    const validatedToolCall: BrowserToolCall = {
      ...toolCall,
      args
    };
    const auditEvent = appendAudit(context, realtime, "tool.request", {
      ...validatedToolCall
    });

    if (isHighRiskTool(validatedToolCall.toolName) && !validatedToolCall.confirmationToken) {
      const approvalRequest = context.approvals.create(validatedToolCall);
      const result: BrowserToolResult = {
        auditLogId: auditEvent.id,
        approvalRequest,
        status: "requires_approval",
        toolName: validatedToolCall.toolName
      };
      writeJson(response, 202, result);
      return;
    }

    if (validatedToolCall.confirmationToken &&
      !context.approvals.consume(validatedToolCall.confirmationToken, validatedToolCall)) {
      const result: BrowserToolResult = {
        auditLogId: auditEvent.id,
        error: "Invalid, expired, or mismatched confirmation token.",
        status: "rejected",
        toolName: validatedToolCall.toolName
      };
      writeJson(response, 403, result);
      return;
    }

    const result: BrowserToolResult = {
      auditLogId: auditEvent.id,
      result: {
        args,
        dispatch: "extension",
        message: "Validated by local agent server. Extension may execute this call."
      },
      status: "queued",
      toolName: validatedToolCall.toolName
    };
    writeJson(response, 200, result);
    return;
  }

  if (request.method === "GET" && url.pathname === "/v1/page/snapshot") {
    const tabId = parseOptionalTabId(url);
    if (tabId instanceof Error) {
      writeJson(response, 400, { error: tabId.message });
      return;
    }

    const snapshot = context.pageSnapshots.get(tabId);
    writeJson(response, snapshot ? 200 : 404, snapshot ?? { error: "No page snapshot has been published." });
    return;
  }

  if (request.method === "POST" && url.pathname === "/v1/page/snapshot") {
    const snapshot = context.pageSnapshots.upsert(pageSnapshotSchema.parse(await readJson(request)));
    appendAudit(context, realtime, "page.snapshot.updated", {
      capturedAt: snapshot.capturedAt,
      elementCount: snapshot.elements.length,
      linkCount: snapshot.links.length,
      tabId: snapshot.tabId
    });
    writeJson(response, 200, snapshot);
    return;
  }

  if (request.method === "DELETE" && url.pathname === "/v1/page/snapshot") {
    const tabId = parseOptionalTabId(url);
    if (tabId instanceof Error) {
      writeJson(response, 400, { error: tabId.message });
      return;
    }

    const cleared = context.pageSnapshots.clear(tabId);
    appendAudit(context, realtime, "page.snapshot.cleared", {
      cleared,
      scope: typeof tabId === "number" ? "tab" : "all",
      tabId
    });
    writeJson(response, 200, { cleared });
    return;
  }

  if (request.method === "GET" && url.pathname === "/v1/memory") {
    writeJson(response, 200, {
      memories: context.memory.list()
    });
    return;
  }

  if (request.method === "POST" && url.pathname === "/v1/memory") {
    const body = memoryPostSchema.parse(await readJson(request));

    if (body.confirmToken) {
      const memory = context.memory.confirmWrite(body.confirmToken);
      if (memory) {
        appendAudit(context, realtime, "memory.confirmed", {
          memoryId: memory.id,
          tags: memory.tags
        });
      }
      writeJson(response, memory ? 201 : 404, memory ? { memory } : { error: "Pending memory not found." });
      return;
    }

    if (!body.content) {
      writeJson(response, 400, {
        error: "content is required when confirmToken is not provided."
      });
      return;
    }

    const pending = context.memory.createPendingWrite(body.content, body.tags);
    appendAudit(context, realtime, "memory.writeRequested", {
      pendingId: pending.id,
      tags: pending.tags
    });
    writeJson(response, 202, {
      pending,
      status: "requires_approval"
    });
    return;
  }

  const memoryDeleteMatch = url.pathname.match(/^\/v1\/memory\/([^/]+)$/);
  if (memoryDeleteMatch && request.method === "DELETE") {
    const memoryId = decodeURIComponent(memoryDeleteMatch[1]!);
    const deleted = context.memory.delete(memoryId);
    if (!deleted) {
      writeJson(response, 404, {
        error: "Memory not found."
      });
      return;
    }

    appendAudit(context, realtime, "memory.deleted", {
      memoryId: deleted.id,
      tags: deleted.tags
    });
    writeJson(response, 200, {
      deleted: true,
      memoryId: deleted.id
    });
    return;
  }

  writeJson(response, 404, {
    error: "Not found"
  });
}

function sanitizeChatRequest(request: ChatRequest): ChatRequest {
  if (!request.pageSnapshot) {
    return request;
  }

  return {
    ...request,
    pageSnapshot: applyContextPolicyToSnapshot(request.pageSnapshot, request.contextPolicy)
  };
}

function appendAudit(
  context: AgentServerContext,
  realtime: RealtimeEventHub,
  type: string,
  payload: unknown
): AuditEvent {
  const event = context.auditLog.append(type, payload);
  realtime.publishAudit(event);
  return event;
}

function publishTask(realtime: RealtimeEventHub, task: TaskRun): void {
  realtime.publishTask(task);
}

function appendNewArtifactAudit(
  context: AgentServerContext,
  realtime: RealtimeEventHub,
  taskId: string,
  previousArtifactCount: number
): void {
  const newArtifacts = context.taskStore.listArtifacts(taskId).slice(previousArtifactCount);
  if (newArtifacts.length === 0) {
    return;
  }

  appendAudit(context, realtime, "task.artifacts.created", {
    artifacts: newArtifacts.map(summarizeArtifactForAudit),
    count: newArtifacts.length,
    taskId
  });
}

function summarizeArtifactForAudit(artifact: TaskArtifact): Omit<TaskArtifact, "content"> {
  const {
    content: _content,
    ...metadata
  } = artifact;
  return metadata;
}

async function readJson(request: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];

  for await (const chunk of request) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }

  if (chunks.length === 0) {
    return {};
  }

  return JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown;
}

function writeJson(response: ServerResponse, status: number, body: unknown): void {
  response.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8"
  });
  response.end(JSON.stringify(body));
}

function applyCorsHeaders(response: ServerResponse, origin: string | undefined): void {
  response.setHeader("Access-Control-Allow-Headers", "Content-Type");
  response.setHeader("Access-Control-Allow-Methods", "GET,POST,PUT,DELETE,OPTIONS");
  response.setHeader("Vary", "Origin");

  if (origin) {
    response.setHeader("Access-Control-Allow-Origin", origin);
  }
}

export function isAllowedOrigin(origin: string | undefined): boolean {
  if (!origin) {
    return true;
  }

  if (extensionOriginPattern.test(origin)) {
    return true;
  }

  return configuredAllowedOrigins().includes(origin);
}

function configuredAllowedOrigins(): string[] {
  return (process.env.OAB_ALLOWED_ORIGINS ?? "")
    .split(",")
    .map((origin) => origin.trim())
    .filter(Boolean);
}

function providerContinuationStepBudget(): number {
  const rawBudget = process.env.OAB_MAX_PROVIDER_CONTINUATION_STEPS;
  const parsedBudget = rawBudget === undefined ? defaultProviderContinuationStepBudget : Number(rawBudget);

  return Number.isInteger(parsedBudget) && parsedBudget >= 0
    ? parsedBudget
    : defaultProviderContinuationStepBudget;
}

function countProviderContinuationSteps(task: TaskRun): number {
  return task.plan.filter((step) => step.origin === "provider-continuation").length;
}

function hasProviderContinuationBudget(task: TaskRun): boolean {
  return countProviderContinuationSteps(task) < providerContinuationStepBudget();
}

function providerContinuationBudgetMessage(_task: TaskRun): string {
  const budget = providerContinuationStepBudget();
  return `Stopped provider continuation after ${budget} provider-generated step${budget === 1 ? "" : "s"}. Review the task before continuing.`;
}

function firstHeader(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

function parseOptionalTabId(url: URL): number | undefined | Error {
  const rawTabId = url.searchParams.get("tabId");
  if (rawTabId === null) {
    return undefined;
  }

  const tabId = Number(rawTabId);
  if (!Number.isInteger(tabId) || tabId < 0) {
    return new Error("tabId must be a non-negative integer.");
  }

  return tabId;
}

function inferTaskTabId(task: TaskRun): number | undefined {
  for (const step of task.plan) {
    if (typeof step.toolCall?.tabId === "number") {
      return step.toolCall.tabId;
    }
  }

  return undefined;
}

function inferTaskPageUrl(task: TaskRun): string | undefined {
  for (const resultRecord of [...task.results].reverse()) {
    const result = resultRecord.result as BrowserToolResult;
    if (result.status === "completed" && result.toolName === "getPageSnapshot" && isRecord(result.result)) {
      const url = result.result.url;
      if (typeof url === "string") {
        return url;
      }
    }
  }

  for (const step of [...task.plan].reverse()) {
    if (step.toolCall?.toolName === "navigate" && typeof step.toolCall.args.url === "string") {
      return step.toolCall.args.url;
    }
  }

  return undefined;
}

function taskToolCallIds(task: TaskRun): string[] {
  return task.plan.flatMap((step) => step.toolCall ? [step.toolCall.id] : []);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function getEffectiveProviderConfig(context: AgentServerContext): {
  config: ReturnType<typeof loadProviderConfig>;
  source: "environment" | "stored" | "default";
} {
  const storedConfig = context.providerConfigStore.get();
  const config = loadProviderConfig(process.env, storedConfig);

  if (process.env.OAB_PROVIDER) {
    return { config, source: "environment" };
  }

  if (storedConfig) {
    return { config, source: "stored" };
  }

  return { config, source: "default" };
}
