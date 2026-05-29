import { createServer, type Server } from "node:http";
import { mkdtempSync, rmSync } from "node:fs";
import { connect } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ApprovalRegistry } from "./approval.js";
import { AuditLog } from "./audit.js";
import { SqliteMemoryStore } from "./memory.js";
import { PageSnapshotStore } from "./pageSnapshotStore.js";
import { buildLocalMessage, generateProviderMessage, loadProviderConfig, testProviderConfig } from "./provider.js";
import { ProviderConfigStore } from "./providerStore.js";
import { createAgentServer, isAllowedOrigin, type AgentServerContext } from "./server.js";
import { openSqliteDatabase, type Database } from "./sqlite.js";
import { TaskStore, TaskToolResultValidationError } from "./taskStore.js";

describe("provider config", () => {
  it("loads disabled provider by default", () => {
    expect(loadProviderConfig({})).toEqual({ type: "disabled" });
  });

  it("loads ollama defaults", () => {
    expect(loadProviderConfig({ OAB_PROVIDER: "ollama" })).toEqual({
      baseUrl: "http://127.0.0.1:11434",
      model: "llama3.2",
      type: "ollama"
    });
  });

  it("builds a local page-aware message when provider is disabled", () => {
    const message = buildLocalMessage(
      {
        contextPolicy: "interactive-elements",
        message: "Summarize this page",
        pageSnapshot: {
          capturedAt: new Date("2026-01-01T00:00:00.000Z").toISOString(),
          elements: [{ attributes: {}, selector: "button:nth-of-type(1)", tagName: "button", text: "Buy" }],
          headings: [],
          links: [{ href: "https://example.com/pricing", text: "Pricing" }],
          tables: [],
          text: "This is a product page with a pricing link.",
          title: "Example Product",
          url: "https://example.com"
        }
      },
      []
    );

    expect(message).toContain("Example Product");
    expect(message).toContain("Pricing");
  });

  it("calls an OpenAI-compatible provider", async () => {
    const calls: Array<{ body: unknown; url: string }> = [];
    const fakeFetch = async (url: string | URL | Request, init?: RequestInit) => {
      calls.push({
        body: init?.body ? JSON.parse(String(init.body)) as unknown : undefined,
        url: String(url)
      });

      return new Response(
        JSON.stringify({
          choices: [{ message: { content: "Provider summary" } }]
        }),
        { status: 200 }
      );
    };

    const message = await generateProviderMessage(
      {
        apiKey: "test-key",
        baseUrl: "https://llm.example/v1",
        model: "test-model",
        type: "openai-compatible"
      },
      {
        plan: [],
        request: {
          contextPolicy: "visible-text",
          message: "Summarize",
          pageSnapshot: {
            capturedAt: new Date("2026-01-01T00:00:00.000Z").toISOString(),
            elements: [],
            headings: [],
            links: [],
            tables: [],
            text: "Visible page text",
            title: "Example",
            url: "https://example.com"
          }
        }
      },
      { fetchImpl: fakeFetch as typeof fetch }
    );

    expect(message).toBe("Provider summary");
    expect(calls[0]?.url).toBe("https://llm.example/v1/chat/completions");
    expect(JSON.stringify(calls[0]?.body)).toContain("Visible page text");
  });

  it("sanitizes sensitive snapshot text before provider prompts", async () => {
    const calls: Array<{ body: unknown }> = [];
    const fakeFetch = async (_url: string | URL | Request, init?: RequestInit) => {
      calls.push({
        body: init?.body ? JSON.parse(String(init.body)) as unknown : undefined
      });

      return new Response(
        JSON.stringify({
          choices: [{ message: { content: "Provider summary" } }]
        }),
        { status: 200 }
      );
    };

    await generateProviderMessage(
      {
        apiKey: "test-key",
        baseUrl: "https://llm.example/v1",
        model: "test-model",
        type: "openai-compatible"
      },
      {
        plan: [],
        request: {
          contextPolicy: "interactive-elements",
          message: "Summarize",
          pageSnapshot: {
            capturedAt: new Date("2026-01-01T00:00:00.000Z").toISOString(),
            elements: [
              {
                attributes: {},
                selector: "#contact",
                tagName: "button",
                text: "Contact reviewer@example.test"
              }
            ],
            headings: [{ level: 1, selector: "#title", text: "Account reviewer@example.test" }],
            links: [
              {
                href: "https://example.com/reset?token=secret-token&email=reviewer@example.test",
                text: "Reset reviewer@example.test"
              }
            ],
            tables: [
              {
                headers: ["User", "Token"],
                rows: [["reviewer@example.test", "Bearer abcdef123456"]],
                selector: "#users"
              }
            ],
            text: "Email reviewer@example.test with Bearer abcdef123456.",
            title: "Account reviewer@example.test",
            url: "https://example.com/account?token=secret-token&email=reviewer@example.test"
          }
        }
      },
      { fetchImpl: fakeFetch as typeof fetch }
    );

    const serializedPrompt = JSON.stringify(calls[0]?.body);
    expect(serializedPrompt).not.toContain("reviewer@example.test");
    expect(serializedPrompt).not.toContain("secret-token");
    expect(serializedPrompt).not.toContain("Bearer abcdef123456");
    expect(serializedPrompt).toContain("[redacted]");
    expect(serializedPrompt).toContain("token=%5Bredacted%5D");
  });

  it("calls an Ollama provider without API credentials", async () => {
    const calls: Array<{ body: unknown; headers: Headers; url: string }> = [];
    const fakeFetch = async (url: string | URL | Request, init?: RequestInit) => {
      calls.push({
        body: init?.body ? JSON.parse(String(init.body)) as unknown : undefined,
        headers: new Headers(init?.headers),
        url: String(url)
      });

      return new Response(
        JSON.stringify({
          message: { content: "Local Ollama summary" }
        }),
        { status: 200 }
      );
    };

    const message = await generateProviderMessage(
      {
        baseUrl: "http://127.0.0.1:11434",
        model: "llama3.2",
        type: "ollama"
      },
      {
        plan: [],
        request: {
          contextPolicy: "visible-text",
          message: "Summarize",
          pageSnapshot: {
            capturedAt: new Date("2026-01-01T00:00:00.000Z").toISOString(),
            elements: [],
            headings: [],
            links: [],
            tables: [],
            text: "Visible page text",
            title: "Example",
            url: "https://example.com"
          }
        }
      },
      { fetchImpl: fakeFetch as typeof fetch }
    );

    expect(message).toBe("Local Ollama summary");
    expect(calls[0]?.url).toBe("http://127.0.0.1:11434/api/chat");
    expect(calls[0]?.headers.has("Authorization")).toBe(false);
    expect(JSON.stringify(calls[0]?.body)).toContain("Visible page text");
  });


  it("passes confirmed memories to providers as bounded context", async () => {
    const calls: Array<{ body: unknown }> = [];
    const fakeFetch = async (_url: string | URL | Request, init?: RequestInit) => {
      calls.push({
        body: init?.body ? JSON.parse(String(init.body)) as unknown : undefined
      });

      return new Response(
        JSON.stringify({
          choices: [{ message: { content: "Provider used memory" } }]
        }),
        { status: 200 }
      );
    };

    const message = await generateProviderMessage(
      {
        apiKey: "test-key",
        baseUrl: "https://llm.example/v1",
        model: "test-model",
        type: "openai-compatible"
      },
      {
        memories: [
          {
            content: "Prefer local Ollama for page summaries.",
            createdAt: new Date("2026-01-01T00:00:00.000Z").toISOString(),
            id: "memory-1",
            tags: ["preference"]
          }
        ],
        plan: [],
        request: {
          contextPolicy: "visible-text",
          message: "Summarize",
          pageSnapshot: {
            capturedAt: new Date("2026-01-01T00:00:00.000Z").toISOString(),
            elements: [],
            headings: [],
            links: [],
            tables: [],
            text: "Visible page text",
            title: "Example",
            url: "https://example.com"
          }
        }
      },
      { fetchImpl: fakeFetch as typeof fetch }
    );

    expect(message).toBe("Provider used memory");
    expect(JSON.stringify(calls[0]?.body)).toContain("Prefer local Ollama");
  });

  it("tests provider config with a generated connectivity prompt", async () => {
    const fakeFetch = async () => new Response(
      JSON.stringify({
        choices: [{ message: { content: "Ready" } }]
      }),
      { status: 200 }
    );

    const result = await testProviderConfig(
      {
        apiKey: "test-key",
        baseUrl: "https://llm.example/v1",
        model: "test-model",
        type: "openai-compatible"
      },
      { fetchImpl: fakeFetch as typeof fetch }
    );

    expect(result.ok).toBe(true);
    expect(result.message).toContain("Ready");
  });
});

describe("agent server", () => {
  let context: AgentServerContext;
  let database: Database;

  beforeEach(async () => {
    database = await openSqliteDatabase(":memory:");
    context = {
      approvals: new ApprovalRegistry(),
      auditLog: new AuditLog(database),
      memory: new SqliteMemoryStore(database),
      pageSnapshots: new PageSnapshotStore(database),
      providerConfigStore: new ProviderConfigStore(database),
      taskStore: new TaskStore(database)
    };
  });

  afterEach(() => {
    database.close();
  });

  it("requires approval for high-risk tools", async () => {
    const server = createAgentServer({ context });
    const response = await fetchAgainst(server, "/v1/tools/execute", {
      args: { selector: "button" },
      id: "call-1",
      toolName: "click"
    });

    expect(response.status).toBe(202);
    const body = await response.json() as { status: string };
    expect(body.status).toBe("requires_approval");
  });

  it("binds approval tokens to the reviewed tool call", async () => {
    const server = createAgentServer({ context });
    const approvalResponse = await fetchAgainst(server, "/v1/tools/execute", {
      args: { selector: "button.primary" },
      id: "call-reviewed",
      toolName: "click"
    });
    const approvalBody = await approvalResponse.json() as {
      approvalRequest: {
        token: string;
        toolCall: {
          args: Record<string, unknown>;
          id: string;
          toolName: string;
        };
      };
      status: string;
    };

    expect(approvalBody.status).toBe("requires_approval");

    const mismatchedResponse = await fetchAgainst(server, "/v1/tools/execute", {
      args: { selector: "button.delete" },
      confirmationToken: approvalBody.approvalRequest.token,
      id: "call-reviewed",
      toolName: "click"
    });
    const mismatchedBody = await mismatchedResponse.json() as { error: string; status: string };

    expect(mismatchedResponse.status).toBe(403);
    expect(mismatchedBody.status).toBe("rejected");
    expect(mismatchedBody.error).toContain("mismatched");

    const approvedResponse = await fetchAgainst(server, "/v1/tools/execute", {
      ...approvalBody.approvalRequest.toolCall,
      confirmationToken: approvalBody.approvalRequest.token
    });

    expect(approvedResponse.status).toBe(200);
    const approvedBody = await approvedResponse.json() as { status: string };
    expect(approvedBody.status).toBe("queued");
  });

  it("rejects expired approval tokens at the tool execution API boundary", async () => {
    let now = Date.parse("2026-01-01T00:00:00.000Z");
    context.approvals = new ApprovalRegistry({
      now: () => now,
      ttlMs: 1_000
    });
    const server = createAgentServer({ context });
    const approvalResponse = await fetchAgainst(server, "/v1/tools/execute", {
      args: { selector: "button.submit" },
      id: "call-expire-api",
      toolName: "click"
    });
    const approvalBody = await approvalResponse.json() as {
      approvalRequest: {
        expiresAt: string;
        token: string;
        toolCall: {
          args: Record<string, unknown>;
          id: string;
          toolName: string;
        };
      };
      status: string;
    };

    expect(approvalBody.status).toBe("requires_approval");
    expect(approvalBody.approvalRequest.expiresAt).toBe("2026-01-01T00:00:01.000Z");

    now += 1_001;
    const expiredResponse = await fetchAgainst(createAgentServer({ context }), "/v1/tools/execute", {
      ...approvalBody.approvalRequest.toolCall,
      confirmationToken: approvalBody.approvalRequest.token
    });
    const expiredBody = await expiredResponse.json() as { error: string; status: string };

    expect(expiredResponse.status).toBe(403);
    expect(expiredBody.status).toBe("rejected");
    expect(expiredBody.error).toContain("expired");
  });

  it("accepts public tool execute requests without an internal call id", async () => {
    const server = createAgentServer({ context });
    const safeResponse = await fetchAgainst(server, "/v1/tools/execute", {
      args: { selector: "main" },
      toolName: "extractText"
    });

    expect(safeResponse.status).toBe(200);
    const safeBody = await safeResponse.json() as { status: string; toolName: string };
    expect(safeBody.status).toBe("queued");
    expect(safeBody.toolName).toBe("extractText");

    const guardedResponse = await fetchAgainst(server, "/v1/tools/execute", {
      args: { selector: "button[type=\"submit\"]" },
      toolName: "click"
    });

    expect(guardedResponse.status).toBe(202);
    const guardedBody = await guardedResponse.json() as {
      approvalRequest: { toolCall: { id: string; toolName: string } };
      status: string;
    };
    expect(guardedBody.status).toBe("requires_approval");
    expect(guardedBody.approvalRequest.toolCall.id).toMatch(/[0-9a-f-]{36}/i);
    expect(guardedBody.approvalRequest.toolCall.toolName).toBe("click");
  });

  it("allows extension origins and rejects web origins for local APIs", async () => {
    expect(isAllowedOrigin(undefined)).toBe(true);
    expect(isAllowedOrigin("chrome-extension://abcdef")).toBe(true);
    expect(isAllowedOrigin("https://example.com")).toBe(false);

    const rejected = await fetchAgainst(
      createAgentServer({ context }),
      "/health",
      undefined,
      "GET",
      { Origin: "https://evil.example" }
    );
    expect(rejected.status).toBe(403);

    const allowed = await fetchAgainst(
      createAgentServer({ context }),
      "/health",
      undefined,
      "GET",
      { Origin: "chrome-extension://abcdef" }
    );
    expect(allowed.status).toBe(200);
    expect(allowed.headers.get("access-control-allow-origin")).toBe("chrome-extension://abcdef");
  });

  it("rejects cross-origin preflight requests from ordinary web pages", async () => {
    const response = await fetchAgainst(
      createAgentServer({ context }),
      "/v1/chat",
      undefined,
      "OPTIONS",
      {
        "Access-Control-Request-Method": "POST",
        Origin: "https://evil.example"
      }
    );

    expect(response.status).toBe(403);
    expect(response.headers.get("access-control-allow-origin")).toBeNull();
  });

  it("rejects an approval request and records the task outcome", async () => {
    const server = createAgentServer({ context });
    const chatResponse = await fetchAgainst(server, "/v1/chat", {
      contextPolicy: "interactive-elements",
      message: "Fill the form with test@example.com",
      pageSnapshot: {
        capturedAt: new Date("2026-01-01T00:00:00.000Z").toISOString(),
        elements: [
          {
            attributes: { name: "email", type: "email" },
            selector: "input[name=\"email\"]",
            tagName: "input",
            text: ""
          }
        ],
        links: [],
        text: "Email",
        title: "Form",
        url: "https://example.com"
      }
    });
    const chat = await chatResponse.json() as {
      approvalRequests: Array<{ id: string; token: string; toolCall: { id: string; toolName: string } }>;
      plan: Array<{ id: string; status: string; toolCall?: { id: string; toolName: string } }>;
      taskId: string;
    };
    const approval = chat.approvalRequests[0]!;
    const step = chat.plan.find((candidate) => candidate.toolCall?.id === approval.toolCall.id)!;
    const rejectResponse = await fetchAgainst(server, "/v1/approvals/reject", {
      approvalId: approval.id,
      reason: "User chose not to type into the form.",
      stepId: step.id,
      taskId: chat.taskId,
      token: approval.token,
      toolCallId: approval.toolCall.id
    });

    expect(rejectResponse.status).toBe(200);
    const rejection = await rejectResponse.json() as {
      result: { status: string; toolName: string };
      task: { plan: Array<{ id: string; status: string }>; status: string };
    };

    expect(rejection.result.status).toBe("rejected");
    expect(rejection.result.toolName).toBe("type");
    expect(rejection.task.status).toBe("failed");
    expect(rejection.task.plan.find((candidate) => candidate.id === step.id)?.status).toBe("failed");
    expect(context.auditLog.list().some((event) => event.type === "approval.rejected")).toBe(true);

    const consumedResponse = await fetchAgainst(server, "/v1/tools/execute", {
      args: {
        clearFirst: true,
        expectedUrl: "https://example.com",
        selector: "input[name=\"email\"]",
        text: "test@example.com"
      },
      confirmationToken: approval.token,
      id: approval.toolCall.id,
      toolName: "type"
    });
    expect(consumedResponse.status).toBe(403);
  });

  it("does not consume approval tokens or write rejection audit when task linkage is invalid", async () => {
    const server = createAgentServer({ context });
    const chatResponse = await fetchAgainst(server, "/v1/chat", {
      contextPolicy: "interactive-elements",
      message: "Fill the form with keep-token@example.com",
      pageSnapshot: {
        capturedAt: new Date("2026-01-01T00:00:00.000Z").toISOString(),
        elements: [
          {
            attributes: { name: "email", type: "email" },
            selector: "input[name=\"email\"]",
            tagName: "input",
            text: ""
          }
        ],
        links: [],
        text: "Email",
        title: "Form",
        url: "https://example.com"
      }
    });
    const chat = await chatResponse.json() as {
      approvalRequests: Array<{ id: string; token: string; toolCall: { id: string; toolName: string } }>;
      plan: Array<{ id: string; status: string; toolCall?: { id: string; toolName: string } }>;
      taskId: string;
    };
    const approval = chat.approvalRequests[0]!;
    const step = chat.plan.find((candidate) => candidate.toolCall?.id === approval.toolCall.id)!;

    const wrongToolCallResponse = await fetchAgainst(server, "/v1/approvals/reject", {
      approvalId: approval.id,
      reason: "Wrong call id should not consume the token.",
      stepId: step.id,
      taskId: chat.taskId,
      token: approval.token,
      toolCallId: "wrong-call"
    });
    expect(wrongToolCallResponse.status).toBe(404);
    expect(context.auditLog.list().some((event) => event.type === "approval.rejected")).toBe(false);
    expect(context.taskStore.get(chat.taskId)?.results).toHaveLength(0);

    const wrongStepResponse = await fetchAgainst(server, "/v1/approvals/reject", {
      approvalId: approval.id,
      reason: "Wrong step should not consume the token.",
      stepId: "wrong-step",
      taskId: chat.taskId,
      token: approval.token,
      toolCallId: approval.toolCall.id
    });
    const wrongStepBody = await wrongStepResponse.json() as { error: string };
    expect(wrongStepResponse.status).toBe(400);
    expect(wrongStepBody.error).toContain("step");
    expect(context.auditLog.list().some((event) => event.type === "approval.rejected")).toBe(false);
    expect(context.taskStore.get(chat.taskId)?.results).toHaveLength(0);

    const validRejectResponse = await fetchAgainst(server, "/v1/approvals/reject", {
      approvalId: approval.id,
      reason: "Now reject the original reviewed action.",
      stepId: step.id,
      taskId: chat.taskId,
      token: approval.token,
      toolCallId: approval.toolCall.id
    });
    expect(validRejectResponse.status).toBe(200);
    const validReject = await validRejectResponse.json() as { result: { status: string }; task: { status: string } };
    expect(validReject.result.status).toBe("rejected");
    expect(validReject.task.status).toBe("failed");
    expect(context.auditLog.list().filter((event) => event.type === "approval.rejected")).toHaveLength(1);
    expect(context.taskStore.get(chat.taskId)?.results).toHaveLength(1);
  });

  it("does not write task result audit for missing tasks", async () => {
    const server = createAgentServer({ context });
    const response = await fetchAgainst(server, "/v1/tasks/missing-task/tool-results", {
      result: {
        result: { links: [] },
        status: "completed",
        toolName: "extractLinks"
      },
      stepId: "step-1",
      toolCallId: "call-1"
    });

    expect(response.status).toBe(404);
    expect(context.auditLog.list().some((event) => event.type === "task.toolResult")).toBe(false);
  });

  it("cancels active tasks and rejects later tool results", async () => {
    const server = createAgentServer({ context });
    const task = context.taskStore.create({
      message: "Extract links after review",
      plan: [
        {
          description: "Review current page",
          id: "step-1",
          status: "completed"
        },
        {
          description: "Extract links",
          id: "step-2",
          status: "pending",
          toolCall: {
            args: {},
            id: "call-2",
            toolName: "extractLinks"
          }
        },
        {
          description: "Press Enter",
          id: "step-3",
          status: "blocked",
          toolCall: {
            args: { key: "Enter" },
            id: "call-3",
            toolName: "press"
          }
        }
      ],
      taskId: "task-cancel-api"
    });

    const cancelResponse = await fetchAgainst(server, `/v1/tasks/${task.taskId}/cancel`, {
      reason: "User stopped the run."
    });
    const cancelBody = await cancelResponse.json() as {
      task: { plan: Array<{ id: string; status: string }>; status: string };
    };

    expect(cancelResponse.status).toBe(200);
    expect(cancelBody.task.status).toBe("canceled");
    expect(cancelBody.task.plan.find((step) => step.id === "step-1")?.status).toBe("completed");
    expect(cancelBody.task.plan.find((step) => step.id === "step-2")?.status).toBe("canceled");
    expect(cancelBody.task.plan.find((step) => step.id === "step-3")?.status).toBe("canceled");
    expect(context.auditLog.list().some((event) => event.type === "task.canceled")).toBe(true);

    const reportResponse = await fetchAgainst(server, `/v1/tasks/${task.taskId}/tool-results`, {
      result: {
        result: { links: [] },
        status: "completed",
        toolName: "extractLinks"
      },
      stepId: "step-2",
      toolCallId: "call-2"
    });
    const reportBody = await reportResponse.json() as { error: string };

    expect(reportResponse.status).toBe(400);
    expect(reportBody.error).toContain("canceled task");
    expect(context.taskStore.get(task.taskId)?.results).toHaveLength(0);
    expect(context.auditLog.list().filter((event) => event.type === "task.toolResult")).toHaveLength(0);
  });

  it("revokes outstanding approvals when a task is canceled", async () => {
    const server = createAgentServer({ context });
    const chatResponse = await fetchAgainst(server, "/v1/chat", {
      contextPolicy: "interactive-elements",
      message: "Press Enter",
      pageSnapshot: {
        capturedAt: new Date("2026-01-01T00:00:00.000Z").toISOString(),
        elements: [],
        links: [],
        text: "Current page",
        title: "Current",
        url: "https://example.com"
      },
      tabId: 10
    });
    const chat = await chatResponse.json() as {
      approvalRequests: Array<{
        token: string;
        toolCall: {
          args: { key?: string };
          id: string;
          tabId?: number;
          toolName: "press";
        };
      }>;
      taskId: string;
    };
    const approval = chat.approvalRequests[0]!;

    const cancelResponse = await fetchAgainst(server, `/v1/tasks/${chat.taskId}/cancel`, {
      reason: "User stopped the guarded key press."
    });
    const cancelEvents = context.auditLog.list().filter((event) => event.type === "task.canceled");

    expect(cancelResponse.status).toBe(200);
    expect(cancelEvents).toHaveLength(1);
    expect((cancelEvents[0]?.payload as { revokedApprovalCount?: number }).revokedApprovalCount).toBe(1);

    const executeResponse = await fetchAgainst(server, "/v1/tools/execute", {
      ...approval.toolCall,
      confirmationToken: approval.token
    });
    const executeBody = await executeResponse.json() as { error?: string; status: string };

    expect(executeResponse.status).toBe(403);
    expect(executeBody.status).toBe("rejected");
    expect(executeBody.error).toContain("Invalid");
  });

  it("cancels all active tasks and revokes their outstanding approvals without auditing task content", async () => {
    const server = createAgentServer({ context });
    const privateMessage = "Extract private customer report";
    const pressCall = {
      args: { key: "Enter" },
      id: "call-global-stop-press",
      toolName: "press" as const
    };
    const clickCall = {
      args: { description: "Delete private report", selector: "button.delete-report" },
      id: "call-global-stop-click",
      toolName: "click" as const
    };
    const pendingTask = context.taskStore.create({
      message: privateMessage,
      plan: [
        {
          description: "Extract links",
          id: "step-global-stop-links",
          status: "pending",
          toolCall: {
            args: {},
            id: "call-global-stop-links",
            toolName: "extractLinks"
          }
        },
        {
          description: "Press Enter",
          id: "step-global-stop-press",
          status: "blocked",
          toolCall: pressCall
        }
      ],
      taskId: "task-global-stop-pending"
    });
    const blockedTask = context.taskStore.create({
      message: "Delete private report after review",
      plan: [
        {
          description: "Click delete",
          id: "step-global-stop-click",
          status: "blocked",
          toolCall: clickCall
        }
      ],
      taskId: "task-global-stop-blocked"
    });
    const completedTask = context.taskStore.create({
      message: "Already done",
      plan: [
        {
          description: "Completed observation",
          id: "step-global-stop-completed",
          status: "completed"
        }
      ],
      taskId: "task-global-stop-completed"
    });
    const pressApproval = context.approvals.create(pressCall);
    const clickApproval = context.approvals.create(clickCall);

    const cancelAllResponse = await fetchAgainst(server, "/v1/tasks/cancel-all", {
      reason: "User used global stop."
    });
    const cancelAllBody = await cancelAllResponse.json() as {
      canceledTaskCount: number;
      revokedApprovalCount: number;
      tasks: Array<{ status: string; taskId: string }>;
    };
    const cancelEvent = context.auditLog.list().find((event) => event.type === "tasks.canceled");

    expect(cancelAllResponse.status).toBe(200);
    expect(cancelAllBody.canceledTaskCount).toBe(2);
    expect(cancelAllBody.revokedApprovalCount).toBe(2);
    expect(cancelAllBody.tasks.map((task) => task.taskId)).toEqual(
      expect.arrayContaining([blockedTask.taskId, pendingTask.taskId])
    );
    expect(context.taskStore.get(pendingTask.taskId)?.status).toBe("canceled");
    expect(context.taskStore.get(blockedTask.taskId)?.status).toBe("canceled");
    expect(context.taskStore.get(completedTask.taskId)?.status).toBe("completed");
    expect(cancelEvent?.payload).toMatchObject({
      canceledTaskCount: 2,
      revokedApprovalCount: 2,
      taskIds: expect.arrayContaining([blockedTask.taskId, pendingTask.taskId])
    });
    expect(JSON.stringify(cancelEvent?.payload)).not.toContain(privateMessage);
    expect(JSON.stringify(cancelEvent?.payload)).not.toContain("Delete private report");

    const pressExecuteResponse = await fetchAgainst(createAgentServer({ context }), "/v1/tools/execute", {
      ...pressCall,
      confirmationToken: pressApproval.token
    });
    const clickExecuteResponse = await fetchAgainst(createAgentServer({ context }), "/v1/tools/execute", {
      ...clickCall,
      confirmationToken: clickApproval.token
    });
    expect(pressExecuteResponse.status).toBe(403);
    expect(clickExecuteResponse.status).toBe(403);
  });

  it("queues safe tools after validation", async () => {
    const server = createAgentServer({ context });
    const response = await fetchAgainst(server, "/v1/tools/execute", {
      args: {},
      id: "call-2",
      toolName: "extractLinks"
    });

    expect(response.status).toBe(200);
    const body = await response.json() as { status: string };
    expect(body.status).toBe("queued");
  });

  it("plans tab listing and returns tab JSON after browser observation", async () => {
    const server = createAgentServer({ context });
    const chatResponse = await fetchAgainst(server, "/v1/chat", {
      contextPolicy: "interactive-elements",
      message: "List open tabs in this window",
      pageSnapshot: {
        capturedAt: new Date("2026-01-01T00:00:00.000Z").toISOString(),
        elements: [],
        headings: [],
        links: [],
        tables: [],
        text: "Current page",
        title: "Current",
        url: "https://example.com"
      },
      tabId: 12
    });
    const chat = await chatResponse.json() as {
      plan: Array<{ id: string; status: string; toolCall?: { id: string; toolName: string } }>;
      taskId: string;
    };
    const tabStep = chat.plan.find((step) => step.toolCall?.toolName === "listTabs");

    expect(chatResponse.status).toBe(200);
    expect(tabStep?.status).toBe("pending");

    const reportResponse = await fetchAgainst(createAgentServer({ context }), `/v1/tasks/${chat.taskId}/tool-results`, {
      result: {
        result: {
          tabs: [
            {
              active: true,
              id: 12,
              index: 0,
              title: "Current",
              url: "https://example.com",
              windowId: 2
            }
          ]
        },
        status: "completed",
        toolName: "listTabs"
      },
      stepId: tabStep!.id,
      toolCallId: tabStep!.toolCall!.id
    });
    const report = await reportResponse.json() as {
      continuation?: { message: string };
      task: { output?: string; status: string };
    };
    const artifacts = context.taskStore.listArtifacts(chat.taskId);

    expect(reportResponse.status).toBe(200);
    expect(report.task.status).toBe("completed");
    expect(report.continuation?.message).toContain("\"tabs\"");
    expect(report.task.output).toContain("https://example.com");
    expect(artifacts.some((artifact) => artifact.kind === "tabs" && artifact.title === "Open tabs")).toBe(true);
  });

  it("plans explicit tab activation by tab ID", async () => {
    const server = createAgentServer({ context });
    const chatResponse = await fetchAgainst(server, "/v1/chat", {
      contextPolicy: "visible-text",
      message: "Switch to tabId 456",
      pageSnapshot: {
        capturedAt: new Date("2026-01-01T00:00:00.000Z").toISOString(),
        elements: [],
        headings: [],
        links: [],
        tables: [],
        text: "Current page",
        title: "Current",
        url: "https://example.com"
      },
      tabId: 12
    });
    const chat = await chatResponse.json() as {
      approvalRequests: unknown[];
      plan: Array<{ status: string; toolCall?: { args: Record<string, unknown>; toolName: string } }>;
    };
    const activateStep = chat.plan.find((step) => step.toolCall?.toolName === "activateTab");

    expect(chatResponse.status).toBe(200);
    expect(chat.approvalRequests).toHaveLength(0);
    expect(activateStep?.status).toBe("pending");
    expect(activateStep?.toolCall?.args).toEqual({ tabId: 456 });
  });

  it("approval-gates opening a URL in a new tab", async () => {
    const server = createAgentServer({ context });
    const chatResponse = await fetchAgainst(server, "/v1/chat", {
      contextPolicy: "interactive-elements",
      message: "Open https://docs.example.net in a new tab",
      pageSnapshot: {
        capturedAt: new Date("2026-01-01T00:00:00.000Z").toISOString(),
        elements: [],
        headings: [],
        links: [],
        tables: [],
        text: "Current page",
        title: "Current",
        url: "https://example.com"
      },
      tabId: 12
    });
    const chat = await chatResponse.json() as {
      approvalRequests: Array<{ risk: string; toolCall: { args: Record<string, unknown>; toolName: string } }>;
      plan: Array<{ status: string; toolCall?: { args: Record<string, unknown>; toolName: string } }>;
    };
    const openStep = chat.plan.find((step) => step.toolCall?.toolName === "openTab");
    const approval = chat.approvalRequests.find((request) => request.toolCall.toolName === "openTab");

    expect(chatResponse.status).toBe(200);
    expect(openStep?.status).toBe("blocked");
    expect(openStep?.toolCall?.args).toMatchObject({
      active: true,
      sourceUrl: "https://example.com",
      url: "https://docs.example.net"
    });
    expect(approval?.risk).toBe("high");
  });

  it("approval-gates explicit URL downloads without adding navigation", async () => {
    const server = createAgentServer({ context });
    const chatResponse = await fetchAgainst(server, "/v1/chat", {
      contextPolicy: "interactive-elements",
      message: "Download https://files.example.net/report.csv",
      pageSnapshot: {
        capturedAt: new Date("2026-01-01T00:00:00.000Z").toISOString(),
        elements: [],
        headings: [],
        links: [],
        tables: [],
        text: "Current page",
        title: "Current",
        url: "https://example.com/reports"
      },
      tabId: 12
    });
    const chat = await chatResponse.json() as {
      approvalRequests: Array<{ reason: string; risk: string; toolCall: { args: Record<string, unknown>; toolName: string } }>;
      plan: Array<{ status: string; toolCall?: { args: Record<string, unknown>; toolName: string } }>;
    };
    const downloadStep = chat.plan.find((step) => step.toolCall?.toolName === "downloadUrl");
    const approval = chat.approvalRequests.find((request) => request.toolCall.toolName === "downloadUrl");

    expect(chatResponse.status).toBe(200);
    expect(chat.plan.some((step) => step.toolCall?.toolName === "navigate")).toBe(false);
    expect(downloadStep?.status).toBe("blocked");
    expect(downloadStep?.toolCall?.args).toMatchObject({
      sourceUrl: "https://example.com/reports",
      url: "https://files.example.net/report.csv"
    });
    expect(approval?.risk).toBe("high");
    expect(approval?.reason).toContain("Downloading");
  });

  it("approval-gates explicit tab closure by tab ID", async () => {
    const server = createAgentServer({ context });
    const chatResponse = await fetchAgainst(server, "/v1/chat", {
      contextPolicy: "visible-text",
      message: "Close tabId 456",
      pageSnapshot: {
        capturedAt: new Date("2026-01-01T00:00:00.000Z").toISOString(),
        elements: [],
        headings: [],
        links: [],
        tables: [],
        text: "Current page",
        title: "Current",
        url: "https://example.com"
      },
      tabId: 12
    });
    const chat = await chatResponse.json() as {
      approvalRequests: Array<{ risk: string; toolCall: { args: Record<string, unknown>; toolName: string } }>;
      plan: Array<{ status: string; toolCall?: { args: Record<string, unknown>; toolName: string } }>;
    };
    const closeStep = chat.plan.find((step) => step.toolCall?.toolName === "closeTab");
    const approval = chat.approvalRequests.find((request) => request.toolCall.toolName === "closeTab");

    expect(chatResponse.status).toBe(200);
    expect(closeStep?.status).toBe("blocked");
    expect(closeStep?.toolCall?.args).toEqual({ tabId: 456 });
    expect(approval?.risk).toBe("high");
  });

  it("stores memory only after confirmation", async () => {
    const server = createAgentServer({ context });
    const pendingResponse = await fetchAgainst(server, "/v1/memory", {
      content: "Remember that local models are preferred.",
      tags: ["preference"]
    });
    const pendingBody = await pendingResponse.json() as {
      pending: { token: string };
      status: string;
    };

    expect(pendingBody.status).toBe("requires_approval");
    expect(context.memory.list()).toHaveLength(0);

    const confirmResponse = await fetchAgainst(server, "/v1/memory", {
      confirmToken: pendingBody.pending.token
    });

    expect(confirmResponse.status).toBe(201);
    expect(context.memory.list()).toHaveLength(1);
    expect(context.auditLog.list().some((event) => event.type === "memory.writeRequested")).toBe(true);
    expect(context.auditLog.list().some((event) => event.type === "memory.confirmed")).toBe(true);
  });

  it("deletes confirmed memories without copying content into audit payloads", async () => {
    const server = createAgentServer({ context });
    const pending = context.memory.createPendingWrite("Remove this local preference.", ["temporary"]);
    const memory = context.memory.confirmWrite(pending.token)!;

    const deleteResponse = await fetchAgainst(server, `/v1/memory/${encodeURIComponent(memory.id)}`, undefined, "DELETE");
    const deleteBody = await deleteResponse.json() as { deleted: boolean; memoryId: string };
    const missingResponse = await fetchAgainst(createAgentServer({ context }), `/v1/memory/${encodeURIComponent(memory.id)}`, undefined, "DELETE");
    const deleteEvent = context.auditLog.list().find((event) => event.type === "memory.deleted");

    expect(deleteResponse.status).toBe(200);
    expect(deleteBody).toEqual({
      deleted: true,
      memoryId: memory.id
    });
    expect(context.memory.list().some((candidate) => candidate.id === memory.id)).toBe(false);
    expect(missingResponse.status).toBe(404);
    expect(deleteEvent?.payload).toMatchObject({
      memoryId: memory.id,
      tags: ["temporary"]
    });
    expect(JSON.stringify(deleteEvent?.payload)).not.toContain("Remove this local preference");
  });

  it("removes deleted memories from later chat context", async () => {
    const server = createAgentServer({ context });
    const pending = context.memory.createPendingWrite("Prefer deleted memory.", ["temporary"]);
    const memory = context.memory.confirmWrite(pending.token)!;

    await fetchAgainst(server, `/v1/memory/${encodeURIComponent(memory.id)}`, undefined, "DELETE");
    const response = await fetchAgainst(createAgentServer({ context }), "/v1/chat", {
      contextPolicy: "interactive-elements",
      message: "Summarize this page",
      pageSnapshot: {
        capturedAt: new Date("2026-01-01T00:00:00.000Z").toISOString(),
        elements: [],
        links: [],
        text: "The current page explains local agent browsing.",
        title: "Local Agent Browser",
        url: "https://example.com"
      }
    });
    const body = await response.json() as { message: string };

    expect(response.status).toBe(200);
    expect(body.message).toContain("Confirmed local memories available: 0");
  });

  it("uses confirmed memories in chat without duplicating memory content in audit payloads", async () => {
    const server = createAgentServer({ context });
    const pending = context.memory.createPendingWrite("Prefer local Ollama for page summaries.", ["preference"]);
    context.memory.confirmWrite(pending.token);
    const response = await fetchAgainst(server, "/v1/chat", {
      contextPolicy: "interactive-elements",
      message: "Summarize this page",
      pageSnapshot: {
        capturedAt: new Date("2026-01-01T00:00:00.000Z").toISOString(),
        elements: [],
        links: [],
        text: "The current page explains local agent browsing.",
        title: "Local Agent Browser",
        url: "https://example.com"
      }
    });

    expect(response.status).toBe(200);
    const body = await response.json() as { message: string };
    const chatPlanEvent = context.auditLog.list().find((event) => event.type === "chat.plan");

    expect(body.message).toContain("Confirmed local memories available: 1");
    expect(JSON.stringify(chatPlanEvent?.payload)).toContain("\"memoryCount\":1");
    expect(JSON.stringify(chatPlanEvent?.payload)).not.toContain("Prefer local Ollama");
  });

  it("uses attached page snapshots in chat responses", async () => {
    const server = createAgentServer({ context });
    const response = await fetchAgainst(server, "/v1/chat", {
      contextPolicy: "interactive-elements",
      message: "Summarize this page",
      pageSnapshot: {
        capturedAt: new Date("2026-01-01T00:00:00.000Z").toISOString(),
        elements: [],
        links: [{ href: "https://example.com/docs", text: "Docs" }],
        text: "The current page explains local agent browsing.",
        title: "Local Agent Browser",
        url: "https://example.com"
      }
    });

    expect(response.status).toBe(200);
    const body = await response.json() as { message: string; plan: Array<{ status: string }> };
    expect(body.message).toContain("Local Agent Browser");
    expect(body.plan[0]?.status).toBe("completed");
  });

  it("stores the user request, not the agent response, as the task history title", async () => {
    const server = createAgentServer({ context });
    const userMessage = "Extract links from this page";
    const response = await fetchAgainst(server, "/v1/chat", {
      contextPolicy: "interactive-elements",
      message: userMessage,
      pageSnapshot: {
        capturedAt: new Date("2026-01-01T00:00:00.000Z").toISOString(),
        elements: [],
        links: [{ href: "https://example.com/docs", text: "Docs" }],
        text: "The current page explains local agent browsing.",
        title: "Local Agent Browser",
        url: "https://example.com"
      }
    });

    expect(response.status).toBe(200);
    const body = await response.json() as { message: string; taskId: string };
    const task = context.taskStore.get(body.taskId);

    expect(body.message).toContain("Local Agent Browser");
    expect(task?.message).toBe(userMessage);
  });

  it("adds provider-proposed safe tool calls after local validation", async () => {
    const providerServer = createFakeProviderServer(JSON.stringify({
      message: "I can extract the main text next.",
      toolCalls: [
        {
          args: { selector: "main" },
          description: "Extract the main page text.",
          toolName: "extractText"
        }
      ]
    }));
    const providerUrl = await listen(providerServer);

    try {
      context.providerConfigStore.save({
        apiKey: "test-key",
        baseUrl: `${providerUrl}/v1`,
        model: "test-model",
        type: "openai-compatible"
      });
      const response = await fetchAgainst(createAgentServer({ context }), "/v1/chat", {
        contextPolicy: "interactive-elements",
        message: "Decide the next page-reading action",
        pageSnapshot: {
          capturedAt: new Date("2026-01-01T00:00:00.000Z").toISOString(),
          elements: [],
          links: [],
          text: "Main page content",
          title: "Provider Plan",
          url: "https://example.com"
        },
        tabId: 12
      });

      expect(response.status).toBe(200);
      const body = await response.json() as {
        approvalRequests: unknown[];
        message: string;
        plan: Array<{ description: string; origin?: string; status: string; toolCall?: { args: { selector?: string }; tabId?: number; toolName: string } }>;
      };
      const proposedStep = body.plan.find((step) => step.toolCall?.toolName === "extractText");

      expect(body.message).toBe("I can extract the main text next.");
      expect(body.approvalRequests).toHaveLength(0);
      expect(proposedStep?.description).toBe("Extract the main page text.");
      expect(proposedStep?.origin).toBe("provider-plan");
      expect(proposedStep?.status).toBe("pending");
      expect(proposedStep?.toolCall?.args.selector).toBe("main");
      expect(proposedStep?.toolCall?.tabId).toBe(12);
    } finally {
      await closeServer(providerServer);
    }
  });

  it("keeps provider-proposed high-risk tool calls behind approval", async () => {
    const providerServer = createFakeProviderServer(JSON.stringify({
      message: "This needs a reviewed click.",
      toolCalls: [
        {
          args: { description: "Continue", selector: "button.continue" },
          description: "Click the continue button.",
          reason: "The provider wants to click a page control.",
          toolName: "click"
        }
      ]
    }));
    const providerUrl = await listen(providerServer);

    try {
      context.providerConfigStore.save({
        apiKey: "test-key",
        baseUrl: `${providerUrl}/v1`,
        model: "test-model",
        type: "openai-compatible"
      });
      const response = await fetchAgainst(createAgentServer({ context }), "/v1/chat", {
        contextPolicy: "interactive-elements",
        message: "Continue if appropriate",
        pageSnapshot: {
          capturedAt: new Date("2026-01-01T00:00:00.000Z").toISOString(),
          elements: [
            {
              attributes: {},
              selector: "button.continue",
              tagName: "button",
              text: "Continue"
            }
          ],
          links: [],
          text: "Continue",
          title: "Provider Click",
          url: "https://example.com"
        },
        tabId: 13
      });

      expect(response.status).toBe(200);
      const body = await response.json() as {
        approvalRequests: Array<{ reason: string; toolCall: { args: { expectedUrl?: string; selector?: string }; toolName: string } }>;
        plan: Array<{ status: string; toolCall?: { toolName: string } }>;
      };
      const clickStep = body.plan.find((step) => step.toolCall?.toolName === "click");

      expect(body.approvalRequests).toHaveLength(1);
      expect(body.approvalRequests[0]?.toolCall.toolName).toBe("click");
      expect(body.approvalRequests[0]?.toolCall.args.selector).toBe("button.continue");
      expect(body.approvalRequests[0]?.toolCall.args.expectedUrl).toBe("https://example.com");
      expect(body.approvalRequests[0]?.reason).toContain("Click actions");
      expect(body.approvalRequests[0]?.reason).toContain("Provider note: The provider wants to click a page control.");
      expect(clickStep?.status).toBe("blocked");
    } finally {
      await closeServer(providerServer);
    }
  });

  it("uses local source context for provider-proposed navigation approvals", async () => {
    const providerServer = createFakeProviderServer(JSON.stringify({
      message: "The next page is off-site.",
      toolCalls: [
        {
          args: {
            sourceUrl: "https://cross-site.example",
            url: "https://other.example/docs"
          },
          description: "Open the off-site docs page.",
          toolName: "navigate"
        }
      ]
    }));
    const providerUrl = await listen(providerServer);

    try {
      context.providerConfigStore.save({
        apiKey: "test-key",
        baseUrl: `${providerUrl}/v1`,
        model: "test-model",
        type: "openai-compatible"
      });
      const response = await fetchAgainst(createAgentServer({ context }), "/v1/chat", {
        contextPolicy: "interactive-elements",
        message: "Decide whether to open related docs",
        pageSnapshot: {
          capturedAt: new Date("2026-01-01T00:00:00.000Z").toISOString(),
          elements: [],
          links: [],
          text: "Current page",
          title: "Provider Navigate",
          url: "https://example.com/current"
        },
        tabId: 14
      });

      expect(response.status).toBe(200);
      const body = await response.json() as {
        approvalRequests: Array<{ risk: string; toolCall: { args: { sourceUrl?: string; url?: string }; toolName: string } }>;
      };

      expect(body.approvalRequests[0]?.toolCall.toolName).toBe("navigate");
      expect(body.approvalRequests[0]?.toolCall.args).toMatchObject({
        sourceUrl: "https://example.com/current",
        url: "https://other.example/docs"
      });
      expect(body.approvalRequests[0]?.risk).toBe("high");
    } finally {
      await closeServer(providerServer);
    }
  });

  it("uses local source context for provider-proposed download approvals", async () => {
    const providerServer = createFakeProviderServer(JSON.stringify({
      message: "The report can be downloaded after review.",
      toolCalls: [
        {
          args: {
            filename: "provider-report.csv",
            saveAs: false,
            sourceUrl: "https://provider-supplied.example",
            url: "https://files.example.net/provider-report.csv"
          },
          description: "Download the report file.",
          toolName: "downloadUrl"
        }
      ]
    }));
    const providerUrl = await listen(providerServer);

    try {
      context.providerConfigStore.save({
        apiKey: "test-key",
        baseUrl: `${providerUrl}/v1`,
        model: "test-model",
        type: "openai-compatible"
      });
      const response = await fetchAgainst(createAgentServer({ context }), "/v1/chat", {
        contextPolicy: "interactive-elements",
        message: "Download the available report if appropriate",
        pageSnapshot: {
          capturedAt: new Date("2026-01-01T00:00:00.000Z").toISOString(),
          elements: [],
          links: [],
          text: "Current page",
          title: "Provider Download",
          url: "https://example.com/current"
        },
        tabId: 14
      });

      expect(response.status).toBe(200);
      const body = await response.json() as {
        approvalRequests: Array<{ risk: string; toolCall: { args: Record<string, unknown>; toolName: string } }>;
      };

      expect(body.approvalRequests[0]?.toolCall.toolName).toBe("downloadUrl");
      expect(body.approvalRequests[0]?.toolCall.args).toMatchObject({
        filename: "provider-report.csv",
        saveAs: false,
        sourceUrl: "https://example.com/current",
        url: "https://files.example.net/provider-report.csv"
      });
      expect(body.approvalRequests[0]?.risk).toBe("high");
    } finally {
      await closeServer(providerServer);
    }
  });

  it("stores sanitized page snapshots for the public snapshot API", async () => {
    const snapshot = {
      capturedAt: new Date("2026-01-01T00:00:00.000Z").toISOString(),
      elements: [
        {
          attributes: {
            name: "email",
            value: "private@example.com"
          },
          selector: "input[name=\"email\"]",
          tagName: "input",
          text: "private@example.com"
        }
      ],
      links: [{ href: "https://example.com/pricing?token=secret-token", text: "Pricing private@example.com" }],
      tabId: 7,
      text: "Snapshot text for private@example.com with Bearer abcdef123456",
      title: "Snapshot Page private@example.com",
      url: "https://example.com?token=secret-token"
    };
    const publishResponse = await fetchAgainst(createAgentServer({ context }), "/v1/page/snapshot", snapshot);
    const readResponse = await fetchAgainst(createAgentServer({ context }), "/v1/page/snapshot?tabId=7", undefined, "GET");

    expect(publishResponse.status).toBe(200);
    expect(readResponse.status).toBe(200);

    const readBody = await readResponse.json() as {
      elements: Array<{ attributes: Record<string, string>; text: string }>;
      links: Array<{ href: string; text: string }>;
      tabId: number;
      text: string;
      title: string;
      url: string;
    };

    expect(readBody.title).toBe("Snapshot Page [redacted]");
    expect(readBody.tabId).toBe(7);
    expect(readBody.text).toBe("Snapshot text for [redacted] with Bearer [redacted]");
    expect(readBody.url).toBe("https://example.com/?token=%5Bredacted%5D");
    expect(readBody.links[0]?.href).toBe("https://example.com/pricing?token=%5Bredacted%5D");
    expect(readBody.links[0]?.text).toBe("Pricing [redacted]");
    expect(readBody.elements[0]?.attributes.value).toBe("[redacted]");
    expect(readBody.elements[0]?.text).toBe("[redacted]");
    expect(context.auditLog.list().some((event) => event.type === "page.snapshot.updated")).toBe(true);
  });

  it("persists page snapshots across store instances", async () => {
    const snapshot = {
      capturedAt: new Date("2026-01-01T00:00:00.000Z").toISOString(),
      elements: [],
      headings: [{ level: 1, selector: "h1", text: "Persistent Page" }],
      links: [{ href: "https://example.com/persisted", text: "Persisted" }],
      tables: [
        {
          headers: ["Plan", "Price"],
          rows: [["Starter", "$9"]],
          selector: "#pricing"
        }
      ],
      tabId: 9,
      text: "Persistent snapshot text",
      title: "Persistent Snapshot",
      url: "https://example.com/persisted"
    };
    const publishResponse = await fetchAgainst(createAgentServer({ context }), "/v1/page/snapshot", snapshot);
    context.pageSnapshots = new PageSnapshotStore(database);

    const readByTabResponse = await fetchAgainst(createAgentServer({ context }), "/v1/page/snapshot?tabId=9", undefined, "GET");
    const readLatestResponse = await fetchAgainst(createAgentServer({ context }), "/v1/page/snapshot", undefined, "GET");

    expect(publishResponse.status).toBe(200);
    expect(readByTabResponse.status).toBe(200);
    expect(readLatestResponse.status).toBe(200);

    const readByTab = await readByTabResponse.json() as {
      headings?: Array<{ text: string }>;
      tables?: Array<{ headers: string[]; rows: string[][] }>;
      title: string;
    };
    const readLatest = await readLatestResponse.json() as { tabId: number; title: string };

    expect(readByTab.title).toBe("Persistent Snapshot");
    expect(readByTab.headings?.[0]?.text).toBe("Persistent Page");
    expect(readByTab.tables?.[0]?.headers).toEqual(["Plan", "Price"]);
    expect(readByTab.tables?.[0]?.rows[0]).toEqual(["Starter", "$9"]);
    expect(readLatest.title).toBe("Persistent Snapshot");
    expect(readLatest.tabId).toBe(9);
  });

  it("clears persisted page snapshots by tab and latest scope", async () => {
    const server = createAgentServer({ context });
    const firstSnapshot = {
      capturedAt: new Date("2026-01-01T00:00:00.000Z").toISOString(),
      elements: [],
      links: [],
      tabId: 7,
      text: "First snapshot",
      title: "First",
      url: "https://example.com/first"
    };
    const secondSnapshot = {
      capturedAt: new Date("2026-01-01T00:00:01.000Z").toISOString(),
      elements: [],
      links: [],
      tabId: 8,
      text: "Second snapshot",
      title: "Second",
      url: "https://example.com/second"
    };

    await fetchAgainst(server, "/v1/page/snapshot", firstSnapshot);
    await fetchAgainst(createAgentServer({ context }), "/v1/page/snapshot", secondSnapshot);

    const clearFirstResponse = await fetchAgainst(createAgentServer({ context }), "/v1/page/snapshot?tabId=7", undefined, "DELETE");
    const clearFirstBody = await clearFirstResponse.json() as { cleared: number };
    const readFirstResponse = await fetchAgainst(createAgentServer({ context }), "/v1/page/snapshot?tabId=7", undefined, "GET");
    const readLatestResponse = await fetchAgainst(createAgentServer({ context }), "/v1/page/snapshot", undefined, "GET");
    const latest = await readLatestResponse.json() as { tabId: number; title: string };

    expect(clearFirstResponse.status).toBe(200);
    expect(clearFirstBody.cleared).toBe(1);
    expect(readFirstResponse.status).toBe(404);
    expect(readLatestResponse.status).toBe(200);
    expect(latest.tabId).toBe(8);
    expect(latest.title).toBe("Second");

    const clearLatestResponse = await fetchAgainst(createAgentServer({ context }), "/v1/page/snapshot?tabId=8", undefined, "DELETE");
    const clearLatestBody = await clearLatestResponse.json() as { cleared: number };
    const missingLatestResponse = await fetchAgainst(createAgentServer({ context }), "/v1/page/snapshot", undefined, "GET");

    expect(clearLatestResponse.status).toBe(200);
    expect(clearLatestBody.cleared).toBe(2);
    expect(missingLatestResponse.status).toBe(404);
    expect(context.auditLog.list().filter((event) => event.type === "page.snapshot.cleared")).toHaveLength(2);
  });

  it("clears all persisted page snapshots", async () => {
    const snapshot = {
      capturedAt: new Date("2026-01-01T00:00:00.000Z").toISOString(),
      elements: [],
      links: [],
      tabId: 12,
      text: "Snapshot text",
      title: "Snapshot",
      url: "https://example.com/snapshot"
    };
    await fetchAgainst(createAgentServer({ context }), "/v1/page/snapshot", snapshot);

    const clearResponse = await fetchAgainst(createAgentServer({ context }), "/v1/page/snapshot", undefined, "DELETE");
    const clearBody = await clearResponse.json() as { cleared: number };
    const readResponse = await fetchAgainst(createAgentServer({ context }), "/v1/page/snapshot?tabId=12", undefined, "GET");
    const clearEvent = context.auditLog.list().find((event) => event.type === "page.snapshot.cleared");

    expect(clearResponse.status).toBe(200);
    expect(clearBody.cleared).toBe(2);
    expect(readResponse.status).toBe(404);
    expect(clearEvent?.payload).toMatchObject({
      cleared: 2,
      scope: "all"
    });
  });

  it("rejects invalid snapshot tab IDs", async () => {
    const readResponse = await fetchAgainst(createAgentServer({ context }), "/v1/page/snapshot?tabId=bad", undefined, "GET");
    const clearResponse = await fetchAgainst(createAgentServer({ context }), "/v1/page/snapshot?tabId=-1", undefined, "DELETE");

    expect(readResponse.status).toBe(400);
    expect(clearResponse.status).toBe(400);
  });

  it("records task tool results and advances step state", async () => {
    const server = createAgentServer({ context });
    const chatResponse = await fetchAgainst(server, "/v1/chat", {
      contextPolicy: "interactive-elements",
      message: "Extract links from this page",
      pageSnapshot: {
        capturedAt: new Date("2026-01-01T00:00:00.000Z").toISOString(),
        elements: [],
        links: [{ href: "https://example.com/docs", text: "Docs" }],
        text: "The current page explains local agent browsing.",
        title: "Local Agent Browser",
        url: "https://example.com"
      }
    });
    const chat = await chatResponse.json() as {
      plan: Array<{ id: string; status: string; toolCall?: { id: string; toolName: "extractLinks" } }>;
      taskId: string;
    };
    const step = chat.plan.find((candidate) => candidate.toolCall?.toolName === "extractLinks");

    expect(step?.status).toBe("pending");

    const reportResponse = await fetchAgainst(server, `/v1/tasks/${chat.taskId}/tool-results`, {
      result: {
        result: { links: [{ href: "https://example.com/docs", text: "Docs" }] },
        status: "completed",
        toolName: "extractLinks"
      },
      stepId: step!.id,
      toolCallId: step!.toolCall!.id
    });

    expect(reportResponse.status).toBe(200);
    const report = await reportResponse.json() as {
      task: { plan: Array<{ id: string; status: string }>; results: unknown[]; status: string };
    };

    expect(report.task.plan.find((candidate) => candidate.id === step!.id)?.status).toBe("completed");
    expect(report.task.results).toHaveLength(1);
    expect(report.task.status).toBe("completed");
  });

  it("lets providers continue from completed tool observations with safe tool proposals", async () => {
    const providerServer = createFakeProviderServer(JSON.stringify({
      message: "I should inspect the links next.",
      toolCalls: [
        {
          args: {},
          description: "Extract links after reading the page text.",
          toolName: "extractLinks"
        }
      ]
    }));
    const providerUrl = await listen(providerServer);
    const task = context.taskStore.create({
      message: "Read this page and decide the next step",
      plan: [
        {
          description: "Extract page text.",
          id: "step-read",
          status: "pending",
          toolCall: {
            args: {},
            id: "call-read",
            tabId: 21,
            toolName: "extractText"
          }
        }
      ],
      taskId: "task-provider-safe-continuation"
    });

    try {
      context.providerConfigStore.save({
        apiKey: "test-key",
        baseUrl: `${providerUrl}/v1`,
        model: "test-model",
        type: "openai-compatible"
      });
      const response = await fetchAgainst(createAgentServer({ context }), `/v1/tasks/${task.taskId}/tool-results`, {
        result: {
          result: { text: "The page mentions docs and pricing." },
          status: "completed",
          toolName: "extractText"
        },
        stepId: "step-read",
        toolCallId: "call-read"
      });

      expect(response.status).toBe(200);
      const body = await response.json() as {
        approvalRequests: unknown[];
        continuation?: { message: string };
        task: { plan: Array<{ description: string; origin?: string; status: string; toolCall?: { tabId?: number; toolName: string } }>; status: string };
      };
      const providerStep = body.task.plan.find((step) => step.toolCall?.toolName === "extractLinks");

      expect(body.continuation?.message).toBe("I should inspect the links next.");
      expect(body.approvalRequests).toHaveLength(0);
      expect(providerStep?.description).toBe("Extract links after reading the page text.");
      expect(providerStep?.origin).toBe("provider-continuation");
      expect(providerStep?.status).toBe("pending");
      expect(providerStep?.toolCall?.tabId).toBe(21);
      expect(body.task.status).toBe("pending");
      expect(context.auditLog.list().some((event) => event.type === "task.continuation")).toBe(true);
    } finally {
      await closeServer(providerServer);
    }
  });

  it("stops provider continuation at the configured generated-step budget", async () => {
    let providerCalls = 0;
    const previousBudget = process.env.OAB_MAX_PROVIDER_CONTINUATION_STEPS;
    const providerServer = createFakeProviderServer(
      JSON.stringify({
        message: "This should not be called.",
        toolCalls: [
          {
            args: { selector: "main" },
            description: "Extract more text.",
            toolName: "extractText"
          }
        ]
      }),
      () => {
        providerCalls += 1;
      }
    );
    const providerUrl = await listen(providerServer);
    const task = context.taskStore.create({
      message: "Continue one provider step only",
      plan: [
        {
          description: "Extract page text.",
          id: "step-read-before-budget",
          status: "completed",
          toolCall: {
            args: {},
            id: "call-read-before-budget",
            tabId: 23,
            toolName: "extractText"
          }
        },
        {
          description: "Provider-proposed text extraction.",
          id: "step-provider-budget",
          origin: "provider-continuation",
          status: "pending",
          toolCall: {
            args: { selector: "main" },
            id: "call-provider-budget",
            tabId: 23,
            toolName: "extractText"
          }
        }
      ],
      taskId: "task-provider-continuation-budget"
    });

    process.env.OAB_MAX_PROVIDER_CONTINUATION_STEPS = "1";

    try {
      context.providerConfigStore.save({
        apiKey: "test-key",
        baseUrl: `${providerUrl}/v1`,
        model: "test-model",
        type: "openai-compatible"
      });
      const response = await fetchAgainst(createAgentServer({ context }), `/v1/tasks/${task.taskId}/tool-results`, {
        result: {
          result: { text: "Provider-generated result." },
          status: "completed",
          toolName: "extractText"
        },
        stepId: "step-provider-budget",
        toolCallId: "call-provider-budget"
      });

      expect(response.status).toBe(200);
      const body = await response.json() as {
        continuation?: { message: string };
        task: { output?: string; plan: Array<{ origin?: string; status: string }>; status: string };
      };

      expect(providerCalls).toBe(0);
      expect(body.continuation?.message).toContain("Stopped provider continuation after 1 provider-generated step");
      expect(body.task.output).toContain("Stopped provider continuation after 1 provider-generated step");
      expect(body.task.plan.filter((step) => step.origin === "provider-continuation")).toHaveLength(1);
      expect(body.task.status).toBe("completed");
    } finally {
      if (previousBudget === undefined) {
        delete process.env.OAB_MAX_PROVIDER_CONTINUATION_STEPS;
      } else {
        process.env.OAB_MAX_PROVIDER_CONTINUATION_STEPS = previousBudget;
      }
      await closeServer(providerServer);
    }
  });

  it("keeps provider continuation high-risk proposals behind approvals", async () => {
    const providerServer = createFakeProviderServer(JSON.stringify({
      message: "The next action needs review.",
      toolCalls: [
        {
          args: { description: "Delete item", selector: "button.delete" },
          description: "Click the delete button.",
          reason: "The provider proposed a page-changing click.",
          toolName: "click"
        }
      ]
    }));
    const providerUrl = await listen(providerServer);
    const task = context.taskStore.create({
      message: "Read this page and decide whether to click",
      plan: [
        {
          description: "Extract page text.",
          id: "step-read-risky",
          status: "pending",
          toolCall: {
            args: {},
            id: "call-read-risky",
            tabId: 22,
            toolName: "extractText"
          }
        }
      ],
      taskId: "task-provider-risky-continuation"
    });

    try {
      context.providerConfigStore.save({
        apiKey: "test-key",
        baseUrl: `${providerUrl}/v1`,
        model: "test-model",
        type: "openai-compatible"
      });
      const response = await fetchAgainst(createAgentServer({ context }), `/v1/tasks/${task.taskId}/tool-results`, {
        result: {
          result: { text: "A delete button is visible." },
          status: "completed",
          toolName: "extractText"
        },
        stepId: "step-read-risky",
        toolCallId: "call-read-risky"
      });

      expect(response.status).toBe(200);
      const body = await response.json() as {
        approvalRequests: Array<{ reason: string; toolCall: { args: { selector?: string }; toolName: string } }>;
        task: { plan: Array<{ origin?: string; status: string; toolCall?: { toolName: string } }>; status: string };
      };
      const clickStep = body.task.plan.find((step) => step.toolCall?.toolName === "click");

      expect(body.approvalRequests).toHaveLength(1);
      expect(body.approvalRequests[0]?.toolCall.toolName).toBe("click");
      expect(body.approvalRequests[0]?.toolCall.args.selector).toBe("button.delete");
      expect(body.approvalRequests[0]?.reason).toContain("sensitive page action");
      expect(body.approvalRequests[0]?.reason).toContain("Provider note: The provider proposed a page-changing click.");
      expect(clickStep?.origin).toBe("provider-continuation");
      expect(clickStep?.status).toBe("blocked");
      expect(body.task.status).toBe("blocked");
    } finally {
      await closeServer(providerServer);
    }
  });

  it("stores screenshot task results as metadata without raw image data", async () => {
    const task = context.taskStore.create({
      message: "Take screenshot",
      plan: [
        {
          description: "Capture screenshot",
          id: "step-1",
          status: "pending",
          toolCall: {
            args: { fullPage: false },
            id: "call-1",
            toolName: "screenshot"
          }
        }
      ],
      taskId: "task-screenshot"
    });
    const updated = context.taskStore.recordToolResult(task.taskId, {
      result: {
        result: { dataUrl: "data:image/png;base64,QUJDRA==" },
        status: "completed",
        toolName: "screenshot"
      },
      stepId: "step-1",
      toolCallId: "call-1"
    });

    expect(updated?.status).toBe("completed");
    expect(JSON.stringify(updated?.results)).not.toContain("QUJDRA");
    expect(updated?.results[0]?.result.result).toMatchObject({
      byteLength: 4,
      dataUrl: "[redacted]",
      mimeType: "image/png",
      redacted: true
    });
  });

  it("rejects direct task results that do not match the planned tool call", () => {
    const task = context.taskStore.create({
      message: "Extract links",
      plan: [
        {
          description: "Extract links",
          id: "step-1",
          status: "pending",
          toolCall: {
            args: {},
            id: "call-1",
            toolName: "extractLinks"
          }
        }
      ],
      taskId: "task-result-binding"
    });

    expect(() => context.taskStore.recordToolResult(task.taskId, {
      result: {
        result: { text: "wrong result" },
        status: "completed",
        toolName: "extractText"
      },
      stepId: "step-1",
      toolCallId: "call-1"
    })).toThrow(TaskToolResultValidationError);
    expect(context.taskStore.get(task.taskId)?.results).toHaveLength(0);
    expect(context.taskStore.get(task.taskId)?.status).toBe("pending");
  });

  it("rejects direct task results that are not terminal browser execution results", () => {
    const task = context.taskStore.create({
      message: "Extract links",
      plan: [
        {
          description: "Extract links",
          id: "step-1",
          status: "pending",
          toolCall: {
            args: {},
            id: "call-1",
            toolName: "extractLinks"
          }
        }
      ],
      taskId: "task-result-terminal-status"
    });

    expect(() => context.taskStore.recordToolResult(task.taskId, {
      result: {
        status: "queued",
        toolName: "extractLinks"
      },
      stepId: "step-1",
      toolCallId: "call-1"
    })).toThrow(TaskToolResultValidationError);
    expect(context.taskStore.get(task.taskId)?.results).toHaveLength(0);
    expect(context.taskStore.get(task.taskId)?.status).toBe("pending");
  });

  it("rejects API tool result reports with mismatched tool call identity", async () => {
    const server = createAgentServer({ context });
    const task = context.taskStore.create({
      message: "Extract links",
      plan: [
        {
          description: "Extract links",
          id: "step-1",
          status: "pending",
          toolCall: {
            args: {},
            id: "call-1",
            toolName: "extractLinks"
          }
        }
      ],
      taskId: "task-api-result-binding"
    });
    const response = await fetchAgainst(server, `/v1/tasks/${task.taskId}/tool-results`, {
      result: {
        result: { links: [] },
        status: "completed",
        toolName: "extractLinks"
      },
      stepId: "step-1",
      toolCallId: "call-2"
    });
    const body = await response.json() as { error: string };

    expect(response.status).toBe(400);
    expect(body.error).toContain("call ID");
    expect(context.taskStore.get(task.taskId)?.results).toHaveLength(0);
    expect(context.auditLog.list().some((event) => event.type === "task.toolResult")).toBe(false);
  });

  it("plans guarded URL navigation and continues with pricing JSON from structured snapshots", async () => {
    const chatResponse = await fetchAgainst(createAgentServer({ context }), "/v1/chat", {
      contextPolicy: "interactive-elements",
      message: "Open https://example.com/pricing and extract pricing as JSON",
      pageSnapshot: {
        capturedAt: new Date("2026-01-01T00:00:00.000Z").toISOString(),
        elements: [],
        links: [],
        text: "Current page",
        title: "Current",
        url: "https://example.com"
      },
      tabId: 3
    });
    const chat = await chatResponse.json() as {
      approvalRequests: Array<{ risk: string; toolCall: { args: { sourceUrl?: string; url: string }; id: string; toolName: string } }>;
      plan: Array<{ id: string; status: string; toolCall?: { id: string; toolName: string } }>;
      taskId: string;
    };
    const navigateStep = chat.plan.find((step) => step.toolCall?.toolName === "navigate");
    const snapshotStepBeforeNavigation = chat.plan.find((step) => step.toolCall?.toolName === "getPageSnapshot");

    expect(chat.approvalRequests[0]?.toolCall.toolName).toBe("navigate");
    expect(chat.approvalRequests[0]?.toolCall.args.url).toBe("https://example.com/pricing");
    expect(chat.approvalRequests[0]?.toolCall.args.sourceUrl).toBe("https://example.com");
    expect(chat.approvalRequests[0]?.risk).toBe("medium");
    expect(navigateStep?.status).toBe("blocked");
    expect(snapshotStepBeforeNavigation?.status).toBe("blocked");

    const navigateReportResponse = await fetchAgainst(createAgentServer({ context }), `/v1/tasks/${chat.taskId}/tool-results`, {
      result: {
        result: { tabId: 3 },
        status: "completed",
        toolName: "navigate"
      },
      stepId: navigateStep!.id,
      toolCallId: navigateStep!.toolCall!.id
    });
    const navigateReport = await navigateReportResponse.json() as {
      task: { plan: Array<{ id: string; status: string; toolCall?: { toolName: string } }> };
    };
    const snapshotStep = navigateReport.task.plan.find((step) => step.toolCall?.toolName === "getPageSnapshot");

    expect(snapshotStep?.status).toBe("pending");

    const snapshotReportResponse = await fetchAgainst(createAgentServer({ context }), `/v1/tasks/${chat.taskId}/tool-results`, {
      result: {
        result: {
          capturedAt: new Date("2026-01-01T00:00:01.000Z").toISOString(),
          elements: [],
          headings: [{ level: 1, selector: "h1", text: "Pricing" }],
          links: [],
          tables: [
            {
              headers: ["Plan", "Price"],
              rows: [
                ["Starter", "$9/month"],
                ["Pro", "$29/month"],
                ["Enterprise", "Contact us"]
              ],
              selector: "table:nth-of-type(1)"
            }
          ],
          text: "Plan Price\nStarter $9/month\nPro $29/month\nEnterprise Contact us",
          title: "Pricing",
          url: "https://example.com/pricing"
        },
        status: "completed",
        toolName: "getPageSnapshot"
      },
      stepId: snapshotStep!.id,
      toolCallId: chat.plan.find((step) => step.toolCall?.toolName === "getPageSnapshot")!.toolCall!.id
    });
    const snapshotReport = await snapshotReportResponse.json() as {
      continuation?: { message: string };
      task: { output?: string; status: string };
    };

    expect(snapshotReport.task.status).toBe("completed");
    expect(snapshotReport.continuation?.message).toContain("\"Starter\"");
    expect(snapshotReport.continuation?.message).toContain("\"Pro\"");
    expect(snapshotReport.task.output).toContain("\"Enterprise\"");
    expect(context.auditLog.list().some((event) => event.type === "task.continuation")).toBe(true);
  });

  it("adds source page context to cross-site navigation approvals", async () => {
    const chatResponse = await fetchAgainst(createAgentServer({ context }), "/v1/chat", {
      contextPolicy: "interactive-elements",
      message: "Open https://other.example/docs and extract links",
      pageSnapshot: {
        capturedAt: new Date("2026-01-01T00:00:00.000Z").toISOString(),
        elements: [],
        links: [],
        text: "Current page",
        title: "Current",
        url: "https://example.com/start"
      },
      tabId: 4
    });
    const chat = await chatResponse.json() as {
      approvalRequests: Array<{ reason: string; risk: string; toolCall: { args: { sourceUrl?: string; url: string }; toolName: string } }>;
    };

    expect(chat.approvalRequests[0]?.toolCall.toolName).toBe("navigate");
    expect(chat.approvalRequests[0]?.toolCall.args).toMatchObject({
      sourceUrl: "https://example.com/start",
      url: "https://other.example/docs"
    });
    expect(chat.approvalRequests[0]?.risk).toBe("high");
    expect(chat.approvalRequests[0]?.reason).toContain("leaves the current site");
  });

  it("blocks safe link extraction until requested navigation completes", async () => {
    const chatResponse = await fetchAgainst(createAgentServer({ context }), "/v1/chat", {
      contextPolicy: "interactive-elements",
      message: "Open https://example.com/pricing and extract links",
      pageSnapshot: {
        capturedAt: new Date("2026-01-01T00:00:00.000Z").toISOString(),
        elements: [],
        links: [],
        text: "Current page",
        title: "Current",
        url: "https://example.com"
      },
      tabId: 5
    });
    const chat = await chatResponse.json() as {
      plan: Array<{ id: string; status: string; toolCall?: { id: string; toolName: string } }>;
      taskId: string;
    };
    const navigateStep = chat.plan.find((step) => step.toolCall?.toolName === "navigate");
    const linkStepBeforeNavigation = chat.plan.find((step) => step.toolCall?.toolName === "extractLinks");

    expect(navigateStep?.status).toBe("blocked");
    expect(linkStepBeforeNavigation?.status).toBe("blocked");
    expect(chat.plan.some((step) => step.toolCall?.toolName === "extractText")).toBe(false);

    const navigateReportResponse = await fetchAgainst(createAgentServer({ context }), `/v1/tasks/${chat.taskId}/tool-results`, {
      result: {
        result: { tabId: 5 },
        status: "completed",
        toolName: "navigate"
      },
      stepId: navigateStep!.id,
      toolCallId: navigateStep!.toolCall!.id
    });
    const navigateReport = await navigateReportResponse.json() as {
      task: { plan: Array<{ id: string; status: string; toolCall?: { id: string; toolName: string } }> };
    };
    const linkStepAfterNavigation = navigateReport.task.plan.find((step) => step.toolCall?.toolName === "extractLinks");

    expect(linkStepAfterNavigation?.status).toBe("pending");

    const linkReportResponse = await fetchAgainst(createAgentServer({ context }), `/v1/tasks/${chat.taskId}/tool-results`, {
      result: {
        result: {
          links: [
            { href: "https://example.com/pricing", text: "Pricing" },
            { href: "https://example.com/pricing", text: "Pricing" }
          ]
        },
        status: "completed",
        toolName: "extractLinks"
      },
      stepId: linkStepAfterNavigation!.id,
      toolCallId: linkStepAfterNavigation!.toolCall!.id
    });
    const linkReport = await linkReportResponse.json() as {
      continuation?: { message: string };
      task: { output?: string; status: string };
    };

    expect(linkReport.task.status).toBe("completed");
    expect(linkReport.continuation?.message).toContain("\"href\": \"https://example.com/pricing\"");
    expect(linkReport.task.output).toContain("\"text\": \"Pricing\"");
    expect(JSON.parse(linkReport.task.output!).links).toHaveLength(1);
  });

  it("plans safe scroll and screenshot browser controls", async () => {
    const response = await fetchAgainst(createAgentServer({ context }), "/v1/chat", {
      contextPolicy: "interactive-elements",
      message: "Scroll down and take a screenshot",
      pageSnapshot: {
        capturedAt: new Date("2026-01-01T00:00:00.000Z").toISOString(),
        elements: [],
        links: [],
        text: "Current page",
        title: "Current",
        url: "https://example.com"
      },
      tabId: 9
    });

    expect(response.status).toBe(200);
    const body = await response.json() as {
      approvalRequests: unknown[];
      plan: Array<{ status: string; toolCall?: { args: { direction?: string; fullPage?: boolean }; toolName: string } }>;
    };
    const scrollStep = body.plan.find((step) => step.toolCall?.toolName === "scroll");
    const screenshotStep = body.plan.find((step) => step.toolCall?.toolName === "screenshot");

    expect(body.approvalRequests).toHaveLength(0);
    expect(scrollStep?.status).toBe("pending");
    expect(scrollStep?.toolCall?.args.direction).toBe("down");
    expect(screenshotStep?.status).toBe("pending");
    expect(screenshotStep?.toolCall?.args.fullPage).toBe(false);
  });

  it("plans full-page screenshots when requested", async () => {
    const response = await fetchAgainst(createAgentServer({ context }), "/v1/chat", {
      contextPolicy: "interactive-elements",
      message: "Take a full page screenshot",
      pageSnapshot: {
        capturedAt: new Date("2026-01-01T00:00:00.000Z").toISOString(),
        elements: [],
        links: [],
        text: "Current page",
        title: "Current",
        url: "https://example.com"
      },
      tabId: 9
    });

    expect(response.status).toBe(200);
    const body = await response.json() as {
      approvalRequests: unknown[];
      plan: Array<{ status: string; toolCall?: { args: { fullPage?: boolean }; toolName: string } }>;
    };
    const screenshotStep = body.plan.find((step) => step.toolCall?.toolName === "screenshot");

    expect(body.approvalRequests).toHaveLength(0);
    expect(screenshotStep?.status).toBe("pending");
    expect(screenshotStep?.toolCall?.args.fullPage).toBe(true);
  });

  it("plans key presses as guarded browser controls", async () => {
    const response = await fetchAgainst(createAgentServer({ context }), "/v1/chat", {
      contextPolicy: "interactive-elements",
      message: "Press Enter",
      pageSnapshot: {
        capturedAt: new Date("2026-01-01T00:00:00.000Z").toISOString(),
        elements: [],
        links: [],
        text: "Current page",
        title: "Current",
        url: "https://example.com"
      },
      tabId: 10
    });

    expect(response.status).toBe(200);
    const body = await response.json() as {
      approvalRequests: Array<{ toolCall: { args: { expectedUrl?: string; key?: string }; toolName: string } }>;
      plan: Array<{ status: string; toolCall?: { args: { expectedUrl?: string; key?: string }; toolName: string } }>;
    };
    const pressStep = body.plan.find((step) => step.toolCall?.toolName === "press");

    expect(body.approvalRequests).toHaveLength(1);
    expect(body.approvalRequests[0]?.toolCall.toolName).toBe("press");
    expect(body.approvalRequests[0]?.toolCall.args.key).toBe("Enter");
    expect(body.approvalRequests[0]?.toolCall.args.expectedUrl).toBe("https://example.com");
    expect(pressStep?.status).toBe("blocked");
  });

  it("plans form typing with a concrete approval payload", async () => {
    const server = createAgentServer({ context });
    const response = await fetchAgainst(server, "/v1/chat", {
      contextPolicy: "interactive-elements",
      message: "Fill the form with test@example.com",
      pageSnapshot: {
        capturedAt: new Date("2026-01-01T00:00:00.000Z").toISOString(),
        elements: [
          {
            attributes: { name: "email", type: "email" },
            selector: "input[name=\"email\"]",
            tagName: "input",
            text: ""
          }
        ],
        links: [],
        text: "Email",
        title: "Form",
        url: "https://example.com"
      }
    });

    expect(response.status).toBe(200);
    const body = await response.json() as {
      approvalRequests: Array<{ toolCall: { args: { expectedUrl?: string; selector: string; text: string } } }>;
      plan: Array<{ status: string; toolCall?: { args: { text?: string }; toolName: string } }>;
    };

    expect(body.approvalRequests[0]?.toolCall.args.text).toBe("test@example.com");
    expect(body.approvalRequests[0]?.toolCall.args.selector).toContain("input[name=\"email\"]");
    expect(body.approvalRequests[0]?.toolCall.args.expectedUrl).toBe("https://example.com");
    expect(body.plan.find((step) => step.toolCall?.toolName === "type")?.status).toBe("blocked");
  });

  it("uses preserved field hints from sanitized interactive snapshots", async () => {
    const response = await fetchAgainst(createAgentServer({ context }), "/v1/chat", {
      contextPolicy: "interactive-elements",
      message: "Fill the form with test@example.com",
      pageSnapshot: {
        capturedAt: new Date("2026-01-01T00:00:00.000Z").toISOString(),
        elements: [
          {
            attributes: {
              placeholder: "Email address",
              type: "text",
              value: "private@example.test"
            },
            selector: "#contact-field",
            tagName: "input",
            text: ""
          }
        ],
        links: [],
        text: "Email address",
        title: "Form",
        url: "https://example.com"
      }
    });

    expect(response.status).toBe(200);
    const body = await response.json() as {
      approvalRequests: Array<{ toolCall: { args: { selector: string; text: string } } }>;
    };

    expect(body.approvalRequests[0]?.toolCall.args.selector).toBe("#contact-field");
    expect(body.approvalRequests[0]?.toolCall.args.text).toBe("test@example.com");
  });

  it("uses captured accessible labels as field hints", async () => {
    const response = await fetchAgainst(createAgentServer({ context }), "/v1/chat", {
      contextPolicy: "interactive-elements",
      message: "Fill the form with label@example.test",
      pageSnapshot: {
        capturedAt: new Date("2026-01-01T00:00:00.000Z").toISOString(),
        elements: [
          {
            attributes: {
              label: "Billing email",
              type: "text"
            },
            selector: "#billing-field",
            tagName: "input",
            text: ""
          }
        ],
        links: [],
        text: "Billing email",
        title: "Form",
        url: "https://example.com"
      }
    });

    expect(response.status).toBe(200);
    const body = await response.json() as {
      approvalRequests: Array<{ toolCall: { args: { selector: string; text: string } } }>;
    };

    expect(body.approvalRequests[0]?.toolCall.args.selector).toBe("#billing-field");
    expect(body.approvalRequests[0]?.toolCall.args.text).toBe("label@example.test");
  });

  it("enforces visible-text policy on chat snapshots before planning", async () => {
    const response = await fetchAgainst(createAgentServer({ context }), "/v1/chat", {
      contextPolicy: "visible-text",
      message: "Fill the form with test@example.com",
      pageSnapshot: {
        capturedAt: new Date("2026-01-01T00:00:00.000Z").toISOString(),
        elements: [
          {
            attributes: {
              placeholder: "Email address",
              type: "text"
            },
            selector: "#contact-field",
            tagName: "input",
            text: ""
          }
        ],
        links: [],
        text: "Email address",
        title: "Form",
        url: "https://example.com"
      }
    });

    expect(response.status).toBe(200);
    const body = await response.json() as {
      approvalRequests: Array<{ toolCall: { args: { selector: string } } }>;
    };

    expect(body.approvalRequests[0]?.toolCall.args.selector).not.toBe("#contact-field");
    expect(body.approvalRequests[0]?.toolCall.args.selector).toBe("input[name=\"email\"], input[type=\"email\"], input");
  });

  it("plans guarded name, email, and submit actions for form tasks", async () => {
    const response = await fetchAgainst(createAgentServer({ context }), "/v1/chat", {
      contextPolicy: "interactive-elements",
      message: "Fill the form with name Smoke User and email smoke@example.test, then submit",
      pageSnapshot: {
        capturedAt: new Date("2026-01-01T00:00:00.000Z").toISOString(),
        elements: [
          {
            attributes: { name: "name", placeholder: "Name", type: "text" },
            selector: "input[name=\"name\"]",
            tagName: "input",
            text: ""
          },
          {
            attributes: { name: "email", placeholder: "Email", type: "email" },
            selector: "input[name=\"email\"]",
            tagName: "input",
            text: ""
          },
          {
            attributes: { type: "submit" },
            selector: "button:nth-of-type(1)",
            tagName: "button",
            text: "Submit"
          }
        ],
        links: [],
        text: "Name Email Submit",
        title: "Form",
        url: "https://example.com"
      }
    });

    expect(response.status).toBe(200);
    const body = await response.json() as {
      approvalRequests: Array<{
        risk: string;
        toolCall: { args: { description?: string; expectedUrl?: string; selector?: string; text?: string }; toolName: string };
      }>;
      plan: Array<{ status: string; toolCall?: { args: { selector?: string; text?: string }; toolName: string } }>;
    };
    const typeCalls = body.approvalRequests.filter((request) => request.toolCall.toolName === "type");
    const clickCall = body.approvalRequests.find((request) => request.toolCall.toolName === "click");

    expect(typeCalls).toHaveLength(2);
    expect(typeCalls.some((request) => request.toolCall.args.selector === "input[name=\"name\"]" && request.toolCall.args.text === "Smoke User")).toBe(true);
    expect(typeCalls.some((request) => request.toolCall.args.selector === "input[name=\"email\"]" && request.toolCall.args.text === "smoke@example.test")).toBe(true);
    expect(clickCall?.toolCall.args.selector).toBe("button:nth-of-type(1)");
    expect(clickCall?.toolCall.args.description).toBe("Submit form: Submit (button:nth-of-type(1))");
    expect(clickCall?.toolCall.args.expectedUrl).toBe("https://example.com");
    expect(clickCall?.risk).toBe("high");
    expect(body.plan.filter((step) => step.status === "blocked")).toHaveLength(3);
  });

  it("plans semantic page clicks from visible snapshot controls", async () => {
    const response = await fetchAgainst(createAgentServer({ context }), "/v1/chat", {
      contextPolicy: "interactive-elements",
      message: "Click the Delete Draft button",
      pageSnapshot: {
        capturedAt: new Date("2026-01-01T00:00:00.000Z").toISOString(),
        elements: [
          {
            attributes: { "aria-label": "Delete draft" },
            selector: "#delete-draft",
            tagName: "button",
            text: "Delete Draft"
          },
          {
            attributes: {},
            selector: "#inspect",
            tagName: "button",
            text: "Inspect"
          }
        ],
        links: [],
        text: "Delete Draft Inspect",
        title: "Actions",
        url: "https://example.com/actions"
      },
      tabId: 20
    });

    expect(response.status).toBe(200);
    const body = await response.json() as {
      approvalRequests: Array<{
        reason: string;
        risk: string;
        toolCall: { args: { description?: string; expectedUrl?: string; selector?: string }; tabId?: number; toolName: string };
      }>;
      plan: Array<{ status: string; toolCall?: { args: { selector?: string }; toolName: string } }>;
    };
    const approval = body.approvalRequests.find((request) => request.toolCall.toolName === "click");
    const clickStep = body.plan.find((step) => step.toolCall?.toolName === "click");

    expect(approval?.toolCall.args.selector).toBe("#delete-draft");
    expect(approval?.toolCall.args.description).toBe("Click page control: Delete Draft (#delete-draft)");
    expect(approval?.toolCall.args.expectedUrl).toBe("https://example.com/actions");
    expect(approval?.toolCall.tabId).toBe(20);
    expect(approval?.risk).toBe("high");
    expect(approval?.reason).toContain("sensitive page control");
    expect(clickStep?.status).toBe("blocked");
  });

  it("plans a pure submit request without inventing default typing", async () => {
    const response = await fetchAgainst(createAgentServer({ context }), "/v1/chat", {
      contextPolicy: "interactive-elements",
      message: "Click the Submit button",
      pageSnapshot: {
        capturedAt: new Date("2026-01-01T00:00:00.000Z").toISOString(),
        elements: [
          {
            attributes: { type: "submit" },
            selector: "#submit-contact",
            tagName: "button",
            text: "Submit"
          }
        ],
        links: [],
        text: "Submit",
        title: "Form",
        url: "https://example.com/form"
      },
      tabId: 21
    });

    expect(response.status).toBe(200);
    const body = await response.json() as {
      approvalRequests: Array<{ toolCall: { args: { selector?: string }; toolName: string } }>;
      plan: Array<{ toolCall?: { toolName: string } }>;
    };

    expect(body.approvalRequests).toHaveLength(1);
    expect(body.approvalRequests[0]?.toolCall.toolName).toBe("click");
    expect(body.approvalRequests[0]?.toolCall.args.selector).toBe("#submit-contact");
    expect(body.plan.some((step) => step.toolCall?.toolName === "type")).toBe(false);
  });

  it("stores provider config and uses it in health responses", async () => {
    const server = createAgentServer({ context });
    const updateResponse = await fetchAgainst(server, "/v1/provider-config", {
      baseUrl: "http://127.0.0.1:11434",
      model: "llama3.2",
      type: "ollama"
    }, "PUT");
    const healthResponse = await fetchAgainst(server, "/health", undefined, "GET");

    expect(updateResponse.status).toBe(200);
    expect(healthResponse.status).toBe(200);

    const updateBody = await updateResponse.json() as { config: { type: string }; source: string };
    const healthBody = await healthResponse.json() as { provider: { type: string }; providerSource: string };

    expect(updateBody.config.type).toBe("ollama");
    expect(updateBody.source).toBe("stored");
    expect(healthBody.provider.type).toBe("ollama");
    expect(healthBody.providerSource).toBe("stored");
    expect(context.auditLog.list().some((event) => event.type === "provider.config.updated")).toBe(true);
  });

  it("tests OpenAI-compatible provider configs without saving secrets", async () => {
    const providerServer = createFakeProviderServer("Provider test response");
    const providerUrl = await listen(providerServer);

    try {
      const server = createAgentServer({ context });
      const response = await fetchAgainst(server, "/v1/provider-config/test", {
        apiKey: "test-key",
        baseUrl: `${providerUrl}/v1`,
        model: "test-model",
        type: "openai-compatible"
      });

      expect(response.status).toBe(200);
      const body = await response.json() as {
        config: { apiKey?: string; type: string };
        message: string;
        ok: boolean;
      };

      expect(body.ok).toBe(true);
      expect(body.message).toContain("Provider test response");
      expect(body.config.type).toBe("openai-compatible");
      expect(body.config.apiKey).toBe("[redacted]");
      expect(context.providerConfigStore.get()).toBeUndefined();
      expect(context.auditLog.list().some((event) => event.type === "provider.config.tested")).toBe(true);
    } finally {
      await closeServer(providerServer);
    }
  });

  it("returns a failed provider test response for unreachable providers", async () => {
    const server = createAgentServer({ context });
    const response = await fetchAgainst(server, "/v1/provider-config/test", {
      apiKey: "test-key",
      baseUrl: "http://127.0.0.1:1/v1",
      model: "test-model",
      type: "openai-compatible"
    });

    expect(response.status).toBe(200);
    const body = await response.json() as { ok: boolean };

    expect(body.ok).toBe(false);
  });

  it("lists persisted tasks and audit events", async () => {
    const server = createAgentServer({ context });
    const chatResponse = await fetchAgainst(server, "/v1/chat", {
      contextPolicy: "interactive-elements",
      message: "Extract links from this page",
      pageSnapshot: {
        capturedAt: new Date("2026-01-01T00:00:00.000Z").toISOString(),
        elements: [],
        links: [{ href: "https://example.com/docs", text: "Docs" }],
        text: "The current page explains local agent browsing.",
        title: "Local Agent Browser",
        url: "https://example.com"
      }
    });
    const chat = await chatResponse.json() as { taskId: string };
    const tasksResponse = await fetchAgainst(server, "/v1/tasks", undefined, "GET");
    const auditResponse = await fetchAgainst(server, "/v1/audit-events", undefined, "GET");

    expect(tasksResponse.status).toBe(200);
    expect(auditResponse.status).toBe(200);

    const tasksBody = await tasksResponse.json() as { tasks: Array<{ taskId: string }> };
    const auditBody = await auditResponse.json() as { events: Array<{ type: string }> };

    expect(tasksBody.tasks.some((task) => task.taskId === chat.taskId)).toBe(true);
    expect(auditBody.events.some((event) => event.type === "chat.plan")).toBe(true);
  });

  it("lists task artifacts from completed browser tool results", async () => {
    const task = context.taskStore.create({
      message: "Extract links",
      plan: [
        {
          description: "Extract links",
          id: "step-links",
          status: "pending",
          toolCall: {
            args: {},
            id: "call-links",
            toolName: "extractLinks"
          }
        }
      ],
      taskId: "task-artifacts"
    });
    const privateHref = "https://example.com/private-report";
    const reportResponse = await fetchAgainst(createAgentServer({ context }), `/v1/tasks/${task.taskId}/tool-results`, {
      result: {
        result: {
          links: [
            {
              href: privateHref,
              text: "Private report"
            }
          ]
        },
        status: "completed",
        toolName: "extractLinks"
      },
      stepId: "step-links",
      toolCallId: "call-links"
    });
    const artifactsResponse = await fetchAgainst(createAgentServer({ context }), `/v1/tasks/${task.taskId}/artifacts`, undefined, "GET");
    const missingArtifactsResponse = await fetchAgainst(createAgentServer({ context }), "/v1/tasks/missing/artifacts", undefined, "GET");
    const artifactsBody = await artifactsResponse.json() as {
      artifacts: Array<{
        content: string;
        id: string;
        kind: string;
        mimeType: string;
        source: string;
        title: string;
      }>;
    };
    const artifactEvent = context.auditLog.list().find((event) => event.type === "task.artifacts.created");
    const linkArtifact = artifactsBody.artifacts.find((artifact) => artifact.kind === "links")!;
    const deleteResponse = await fetchAgainst(
      createAgentServer({ context }),
      `/v1/tasks/${task.taskId}/artifacts/${encodeURIComponent(linkArtifact.id)}`,
      undefined,
      "DELETE"
    );
    const deleteBody = await deleteResponse.json() as { artifactId: string; deleted: boolean; taskId: string };
    const afterDeleteResponse = await fetchAgainst(createAgentServer({ context }), `/v1/tasks/${task.taskId}/artifacts`, undefined, "GET");
    const afterDeleteBody = await afterDeleteResponse.json() as { artifacts: Array<{ id: string }> };
    const missingDeleteResponse = await fetchAgainst(
      createAgentServer({ context }),
      `/v1/tasks/${task.taskId}/artifacts/missing-artifact`,
      undefined,
      "DELETE"
    );
    const deleteEvent = context.auditLog.list().find((event) => event.type === "task.artifact.deleted");

    expect(reportResponse.status).toBe(200);
    expect(artifactsResponse.status).toBe(200);
    expect(missingArtifactsResponse.status).toBe(404);
    expect(linkArtifact).toMatchObject({
      kind: "links",
      mimeType: "application/json",
      title: "Extracted links"
    });
    expect(linkArtifact.content).toContain(privateHref);
    expect(artifactEvent?.payload).toMatchObject({
      count: 2,
      taskId: task.taskId
    });
    expect(artifactsBody.artifacts.map((artifact) => artifact.source)).toEqual(expect.arrayContaining(["tool-result", "agent-output"]));
    expect(JSON.stringify(artifactEvent?.payload)).not.toContain(privateHref);
    expect(deleteResponse.status).toBe(200);
    expect(deleteBody).toEqual({
      artifactId: linkArtifact.id,
      deleted: true,
      taskId: task.taskId
    });
    expect(afterDeleteBody.artifacts.some((artifact) => artifact.id === linkArtifact.id)).toBe(false);
    expect(missingDeleteResponse.status).toBe(404);
    expect(deleteEvent?.payload).toMatchObject({
      artifact: {
        id: linkArtifact.id,
        kind: "links",
        taskId: task.taskId
      },
      taskId: task.taskId
    });
    expect(JSON.stringify(deleteEvent?.payload)).not.toContain(privateHref);
  });

  it("deletes task history, derived artifacts, and task approval tokens without auditing content", async () => {
    const privateHref = "https://example.com/private-task-report";
    const clickCall = {
      args: { description: "Delete sensitive report", selector: "button.delete-report" },
      id: "call-delete-sensitive",
      toolName: "click" as const
    };
    const task = context.taskStore.create({
      message: "Extract a private report, then click delete",
      plan: [
        {
          description: "Extract private report links",
          id: "step-links",
          status: "pending",
          toolCall: {
            args: {},
            id: "call-links",
            toolName: "extractLinks"
          }
        },
        {
          description: "Click delete",
          id: "step-delete",
          status: "blocked",
          toolCall: clickCall
        }
      ],
      taskId: "task-delete-history"
    });
    const approval = context.approvals.create(clickCall);
    await fetchAgainst(createAgentServer({ context }), `/v1/tasks/${task.taskId}/tool-results`, {
      result: {
        result: {
          links: [
            {
              href: privateHref,
              text: "Private report"
            }
          ]
        },
        status: "completed",
        toolName: "extractLinks"
      },
      stepId: "step-links",
      toolCallId: "call-links"
    });
    context.taskStore.setOutput(task.taskId, JSON.stringify({
      privateHref,
      summary: "Private report output"
    }));

    expect(context.taskStore.listArtifacts(task.taskId).some((artifact) => artifact.content.includes(privateHref))).toBe(true);

    const deleteResponse = await fetchAgainst(createAgentServer({ context }), `/v1/tasks/${task.taskId}`, undefined, "DELETE");
    const deleteBody = await deleteResponse.json() as {
      artifactCount: number;
      deleted: boolean;
      resultCount: number;
      revokedApprovalCount: number;
      taskId: string;
    };
    const deletedTaskResponse = await fetchAgainst(createAgentServer({ context }), `/v1/tasks/${task.taskId}`, undefined, "GET");
    const deletedArtifactsResponse = await fetchAgainst(createAgentServer({ context }), `/v1/tasks/${task.taskId}/artifacts`, undefined, "GET");
    const lateResultResponse = await fetchAgainst(createAgentServer({ context }), `/v1/tasks/${task.taskId}/tool-results`, {
      result: {
        result: { links: [] },
        status: "completed",
        toolName: "extractLinks"
      },
      stepId: "step-links",
      toolCallId: "call-links"
    });
    const revokedApprovalResponse = await fetchAgainst(createAgentServer({ context }), "/v1/tools/execute", {
      ...clickCall,
      confirmationToken: approval.token
    });
    const deleteEvent = context.auditLog.list().find((event) => event.type === "task.deleted");

    expect(deleteResponse.status).toBe(200);
    expect(deleteBody).toMatchObject({
      artifactCount: 2,
      deleted: true,
      resultCount: 1,
      revokedApprovalCount: 1,
      taskId: task.taskId
    });
    expect(deletedTaskResponse.status).toBe(404);
    expect(deletedArtifactsResponse.status).toBe(404);
    expect(lateResultResponse.status).toBe(404);
    expect(revokedApprovalResponse.status).toBe(403);
    expect(context.taskStore.list().some((candidate) => candidate.taskId === task.taskId)).toBe(false);
    expect(context.taskStore.listArtifacts(task.taskId)).toHaveLength(0);
    expect(deleteEvent?.payload).toMatchObject({
      artifactCount: 2,
      planStepCount: 2,
      resultCount: 1,
      revokedApprovalCount: 1,
      status: "blocked",
      taskId: task.taskId
    });
    expect(JSON.stringify(deleteEvent?.payload)).not.toContain(privateHref);
    expect(JSON.stringify(deleteEvent?.payload)).not.toContain("Private report");
  });

  it("streams task and audit events over the local websocket API", async () => {
    const server = createAgentServer({ context });
    const baseUrl = await listen(server);
    const realtime = await openRealtimeSocket(`${baseUrl.replace("http://", "ws://")}/v1/events`);

    try {
      const hello = await waitForRealtimeMessage(realtime.messages, (message) =>
        isRecord(message) && message.kind === "hello"
      );

      expect(hello).toMatchObject({ kind: "hello" });

      const chatResponse = await fetch(`${baseUrl}/v1/chat`, {
        body: JSON.stringify({
          contextPolicy: "interactive-elements",
          message: "Extract links from this page",
          pageSnapshot: {
            capturedAt: new Date("2026-01-01T00:00:00.000Z").toISOString(),
            elements: [],
            links: [{ href: "https://example.com/docs", text: "Docs" }],
            text: "The current page explains local agent browsing.",
            title: "Local Agent Browser",
            url: "https://example.com"
          }
        }),
        headers: {
          "Content-Type": "application/json"
        },
        method: "POST"
      });
      const chat = await chatResponse.json() as { taskId: string };
      const taskEvent = await waitForRealtimeMessage(realtime.messages, (message) =>
        isRecord(message) &&
        message.kind === "task" &&
        isRecord(message.task) &&
        message.task.taskId === chat.taskId
      );
      const auditEvent = await waitForRealtimeMessage(realtime.messages, (message) =>
        isRecord(message) &&
        message.kind === "audit" &&
        isRecord(message.event) &&
        message.event.type === "chat.plan"
      );

      expect(taskEvent).toMatchObject({ kind: "task" });
      expect(auditEvent).toMatchObject({ kind: "audit" });
    } finally {
      realtime.socket.close();
      await closeServer(server);
    }
  });

  it("rejects websocket upgrades from ordinary web origins", async () => {
    const server = createAgentServer({ context });
    const baseUrl = await listen(server);

    try {
      const response = await openRawWebSocketUpgrade(`${baseUrl.replace("http://", "ws://")}/v1/events`, "https://evil.example");
      expect(response).toContain("403 Forbidden");
    } finally {
      await closeServer(server);
    }
  });
});

describe("sqlite persistence", () => {
  it("persists task runs, tool results, and audit events across store instances", async () => {
    const tempDirectory = mkdtempSync(join(tmpdir(), "open-agent-browser-db-"));
    const databasePath = join(tempDirectory, "state.sqlite");
    const firstDatabase = await openSqliteDatabase(databasePath);
    const taskStore = new TaskStore(firstDatabase);
    const auditLog = new AuditLog(firstDatabase);
    const providerConfigStore = new ProviderConfigStore(firstDatabase);
    const created = taskStore.create({
      message: "Extract links",
      plan: [
        {
          description: "Extract links",
          id: "step-1",
          status: "pending",
          toolCall: {
            args: {},
            id: "call-1",
            toolName: "extractLinks"
          }
        }
      ],
      taskId: "task-1"
    });

    taskStore.recordToolResult(created.taskId, {
      result: {
        result: { links: [{ href: "https://example.com", text: "Example" }] },
        status: "completed",
        toolName: "extractLinks"
      },
      stepId: "step-1",
      toolCallId: "call-1"
    });
    taskStore.setOutput(created.taskId, "{\"links\":[{\"href\":\"https://example.com\"}]}");
    auditLog.append("task.persisted", { taskId: created.taskId });
    providerConfigStore.save({
      baseUrl: "http://127.0.0.1:11434",
      model: "llama3.2",
      type: "ollama"
    });
    firstDatabase.close();

    const secondDatabase = await openSqliteDatabase(databasePath);
    try {
      const reloadedTaskStore = new TaskStore(secondDatabase);
      const reloadedAuditLog = new AuditLog(secondDatabase);
      const reloadedProviderConfigStore = new ProviderConfigStore(secondDatabase);
      const reloadedTask = reloadedTaskStore.get("task-1");
      const reloadedArtifacts = reloadedTaskStore.listArtifacts("task-1");

      expect(reloadedTask?.status).toBe("completed");
      expect(reloadedTask?.results).toHaveLength(1);
      expect(reloadedArtifacts.map((artifact) => artifact.kind)).toEqual(expect.arrayContaining(["links", "json"]));
      expect(reloadedArtifacts.some((artifact) => artifact.content.includes("https://example.com"))).toBe(true);
      expect(reloadedAuditLog.list().some((event) => event.type === "task.persisted")).toBe(true);
      expect(reloadedProviderConfigStore.get()?.type).toBe("ollama");
    } finally {
      secondDatabase.close();
      rmSync(tempDirectory, { force: true, recursive: true });
    }
  });
});

async function fetchAgainst(
  server: ReturnType<typeof createAgentServer>,
  path: string,
  body: unknown,
  method = "POST",
  headers: Record<string, string> = {}
): Promise<Response> {
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("Expected TCP server address.");
  }

  try {
    const init: RequestInit = {
      headers: {
        "Content-Type": "application/json",
        ...headers
      },
      method
    };

    if (method !== "GET" && method !== "OPTIONS") {
      init.body = JSON.stringify(body);
    }

    return await fetch(`http://127.0.0.1:${address.port}${path}`, init);
  } finally {
    server.close();
  }
}

function createFakeProviderServer(message: string, onRequest?: () => void): Server {
  return createServer((request, response) => {
    if (request.method !== "POST" || request.url !== "/v1/chat/completions") {
      response.writeHead(404, { "Content-Type": "application/json" });
      response.end(JSON.stringify({ error: "not found" }));
      return;
    }

    onRequest?.();
    response.writeHead(200, { "Content-Type": "application/json" });
    response.end(JSON.stringify({
      choices: [{ message: { content: message } }]
    }));
  });
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

async function openRealtimeSocket(url: string): Promise<{ messages: unknown[]; socket: WebSocket }> {
  const messages: unknown[] = [];
  const socket = new WebSocket(url);
  socket.addEventListener("message", (event) => {
    messages.push(JSON.parse(String(event.data)) as unknown);
  });

  await new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error(`Timed out opening websocket: ${url}`)), 3000);
    socket.addEventListener("open", () => {
      clearTimeout(timeout);
      resolve();
    }, { once: true });
    socket.addEventListener("error", () => {
      clearTimeout(timeout);
      reject(new Error(`Failed to open websocket: ${url}`));
    }, { once: true });
  });

  return { messages, socket };
}

async function openRawWebSocketUpgrade(url: string, origin: string): Promise<string> {
  const parsed = new URL(url);

  return new Promise<string>((resolve, reject) => {
    const socket = connect(Number(parsed.port), parsed.hostname);
    let response = "";
    const timeout = setTimeout(() => {
      socket.destroy();
      reject(new Error(`Timed out waiting for websocket upgrade response: ${url}`));
    }, 3000);

    socket.on("connect", () => {
      socket.write([
        `GET ${parsed.pathname} HTTP/1.1`,
        `Host: ${parsed.host}`,
        "Upgrade: websocket",
        "Connection: Upgrade",
        `Origin: ${origin}`,
        "Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==",
        "Sec-WebSocket-Version: 13",
        "\r\n"
      ].join("\r\n"));
    });
    socket.on("data", (chunk) => {
      response += chunk.toString("utf8");
      if (response.includes("\r\n\r\n")) {
        clearTimeout(timeout);
        socket.destroy();
        resolve(response);
      }
    });
    socket.on("error", (error) => {
      clearTimeout(timeout);
      reject(error);
    });
  });
}

async function waitForRealtimeMessage(
  messages: unknown[],
  predicate: (message: unknown) => boolean
): Promise<unknown> {
  const startedAt = Date.now();

  while (Date.now() - startedAt < 3000) {
    const found = messages.find(predicate);
    if (found) {
      return found;
    }

    await new Promise((resolve) => setTimeout(resolve, 25));
  }

  throw new Error(`Timed out waiting for websocket message. Received: ${JSON.stringify(messages)}`);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
