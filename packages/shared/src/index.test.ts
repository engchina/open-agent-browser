import { describe, expect, it } from "vitest";
import {
  applyContextPolicyToSnapshot,
  agentRealtimeEventSchema,
  approvalRejectRequestSchema,
  approvalRejectResponseSchema,
  browserToolExecuteRequestSchema,
  chatRequestSchema,
  auditEventListResponseSchema,
  confirmedMemoryWriteResponseSchema,
  healthResponseSchema,
  memoryListResponseSchema,
  pendingMemoryWriteResponseSchema,
  providerConfigTestResponseSchema,
  providerConfigResponseSchema,
  taskCancelAllResponseSchema,
  taskArtifactDeleteResponseSchema,
  taskArtifactListResponseSchema,
  taskDeleteResponseSchema,
  taskToolResultResponseSchema,
  taskResponseSchema,
  taskRunSchema,
  taskListResponseSchema,
  sanitizePageSnapshot,
  summarizeBrowserToolResultForHistory,
  summarizeToolCallForApproval,
  validateToolArgs,
  type PageSnapshot
} from "./index.js";

describe("browser tool validation", () => {
  it("accepts public execute requests without an internal call id", () => {
    const parsed = browserToolExecuteRequestSchema.parse({
      args: { selector: "main" },
      toolName: "extractText"
    });

    expect(parsed.id).toBeUndefined();
    expect(parsed.toolName).toBe("extractText");
  });

  it("accepts valid tool args", () => {
    expect(validateToolArgs("navigate", { url: "https://example.com" })).toEqual({
      url: "https://example.com"
    });
    expect(validateToolArgs("type", {
      expectedUrl: "https://example.com/form",
      selector: "#email",
      text: "user@example.test"
    })).toEqual({
      clearFirst: false,
      expectedUrl: "https://example.com/form",
      selector: "#email",
      text: "user@example.test"
    });
    expect(validateToolArgs("listTabs", {})).toEqual({
      currentWindow: true
    });
    expect(validateToolArgs("activateTab", { tabId: 12 })).toEqual({
      tabId: 12
    });
    expect(validateToolArgs("openTab", { url: "https://example.com/docs" })).toEqual({
      active: true,
      url: "https://example.com/docs"
    });
    expect(validateToolArgs("closeTab", { tabId: 12 })).toEqual({
      tabId: 12
    });
    expect(validateToolArgs("closeTab", {
      tabId: 12,
      url: "chrome://newtab/"
    })).toEqual({
      tabId: 12,
      url: "chrome://newtab/"
    });
    expect(validateToolArgs("downloadUrl", { url: "https://example.com/report.csv" })).toEqual({
      conflictAction: "uniquify",
      saveAs: true,
      url: "https://example.com/report.csv"
    });
  });

  it("rejects invalid tool args", () => {
    expect(() => validateToolArgs("navigate", { url: "not-a-url" })).toThrow();
  });

  it("summarizes screenshot results before task history storage", () => {
    const summarized = summarizeBrowserToolResultForHistory({
      approvalRequest: {
        expiresAt: new Date("2026-01-01T00:10:00.000Z").toISOString(),
        id: "approval-1",
        reason: "Review",
        risk: "medium",
        token: "secret-token",
        toolCall: {
          args: {},
          id: "call-1",
          toolName: "screenshot"
        }
      },
      result: {
        dataUrl: "data:image/png;base64,QUJDRA=="
      },
      status: "completed",
      toolName: "screenshot"
    });

    expect(summarized.approvalRequest).toBeUndefined();
    expect(summarized.result).toMatchObject({
      byteLength: 4,
      dataUrl: "[redacted]",
      mimeType: "image/png",
      redacted: true
    });
  });

  it("summarizes extracted text and links with sensitive values redacted", () => {
    const textSummary = summarizeBrowserToolResultForHistory({
      result: {
        text: "Email reviewer@example.test with Bearer abcdef123456"
      },
      status: "completed",
      toolName: "extractText"
    });
    const linkSummary = summarizeBrowserToolResultForHistory({
      result: {
        links: [
          {
            href: "https://example.com/reset?token=secret-token&email=reviewer@example.test",
            text: "Reset reviewer@example.test"
          }
        ]
      },
      status: "completed",
      toolName: "extractLinks"
    });

    expect(textSummary.result).toEqual({
      text: "Email [redacted] with Bearer [redacted]"
    });
    expect(linkSummary.result).toEqual({
      links: [
        {
          href: "https://example.com/reset?token=%5Bredacted%5D&email=%5Bredacted%5D",
          text: "Reset [redacted]"
        }
      ]
    });
  });

  it("summarizes approval tool calls with reviewable details", () => {
    const summary = summarizeToolCallForApproval({
      args: {
        clearFirst: true,
        expectedUrl: "https://example.com/form",
        selector: "input[name=\"email\"]",
        text: "reviewer@example.test"
      },
      id: "call-1",
      toolName: "type"
    });

    expect(summary.title).toBe("Type into page");
    expect(summary.details).toContainEqual({
      label: "Expected URL",
      value: "https://example.com/form"
    });
    expect(summary.details).toContainEqual({
      label: "Selector",
      value: "input[name=\"email\"]"
    });
    expect(summary.details).toContainEqual({
      label: "Text",
      value: "reviewer@example.test"
    });
  });

  it("redacts sensitive approval details", () => {
    const summary = summarizeToolCallForApproval({
      args: {
        clearFirst: true,
        selector: "input[name=\"password\"]",
        text: "correct-horse-battery-staple"
      },
      id: "call-1",
      toolName: "type"
    });

    expect(summary.details).toContainEqual({
      label: "Text",
      value: "[redacted]"
    });
  });

  it("summarizes navigation source and site change for approval", () => {
    const summary = summarizeToolCallForApproval({
      args: {
        sourceUrl: "https://example.com/docs",
        url: "https://accounts.example.net/login"
      },
      id: "call-navigate",
      toolName: "navigate"
    });

    expect(summary.details).toContainEqual({
      label: "Current URL",
      value: "https://example.com/docs"
    });
    expect(summary.details).toContainEqual({
      label: "Destination URL",
      value: "https://accounts.example.net/login"
    });
    expect(summary.details).toContainEqual({
      label: "Site change",
      value: "https://example.com -> https://accounts.example.net"
    });
  });

  it("summarizes tab open and close approvals", () => {
    const openSummary = summarizeToolCallForApproval({
      args: {
        active: true,
        sourceUrl: "https://example.com",
        url: "https://docs.example.net"
      },
      id: "call-open-tab",
      toolName: "openTab"
    });
    const closeSummary = summarizeToolCallForApproval({
      args: {
        tabId: 42,
        title: "Draft form",
        url: "https://example.com/form",
        windowId: 7
      },
      id: "call-close-tab",
      toolName: "closeTab"
    });

    expect(openSummary.title).toBe("Open new tab");
    expect(openSummary.details).toContainEqual({
      label: "Site change",
      value: "https://example.com -> https://docs.example.net"
    });
    expect(closeSummary.title).toBe("Close tab");
    expect(closeSummary.details).toContainEqual({
      label: "Tab ID",
      value: "42"
    });
    expect(closeSummary.details).toContainEqual({
      label: "Title",
      value: "Draft form"
    });
  });

  it("summarizes download approvals", () => {
    const summary = summarizeToolCallForApproval({
      args: {
        conflictAction: "uniquify",
        filename: "reports/report.csv",
        saveAs: false,
        sourceUrl: "https://example.com/reports",
        url: "https://files.example.net/report.csv"
      },
      id: "call-download",
      toolName: "downloadUrl"
    });

    expect(summary.title).toBe("Download file");
    expect(summary.details).toContainEqual({
      label: "Download URL",
      value: "https://files.example.net/report.csv"
    });
    expect(summary.details).toContainEqual({
      label: "Site change",
      value: "https://example.com -> https://files.example.net"
    });
    expect(summary.details).toContainEqual({
      label: "Save as",
      value: "false"
    });
  });
});

describe("page snapshot sanitization", () => {
  it("redacts sensitive attributes and truncates text", () => {
    const snapshot: PageSnapshot = {
      capturedAt: new Date("2026-01-01T00:00:00.000Z").toISOString(),
      elements: [
        {
          attributes: {
            name: "password",
            type: "password",
            value: "secret-value"
          },
          selector: "input[type=password]",
          tagName: "input",
          text: "x".repeat(1200)
        }
      ],
      headings: [],
      links: [],
      tables: [],
      text: "y".repeat(13000),
      title: "Test",
      url: "https://example.com"
    };

    const sanitized = sanitizePageSnapshot(snapshot);

    expect(sanitized.elements[0]?.attributes.value).toBe("[redacted]");
    expect(sanitized.elements[0]?.attributes.name).toBe("[redacted]");
    expect(sanitized.elements[0]?.text.length).toBeLessThanOrEqual(1003);
    expect(sanitized.text.length).toBeLessThanOrEqual(12003);
  });

  it("keeps field hints while redacting captured input values", () => {
    const snapshot: PageSnapshot = {
      capturedAt: new Date("2026-01-01T00:00:00.000Z").toISOString(),
      elements: [
        {
          attributes: {
            "aria-label": "Email address",
            autocomplete: "email",
            label: "Work email label",
            name: "email",
            placeholder: "Work email",
            type: "email",
            value: "reviewer@example.test"
          },
          selector: "#work-email",
          tagName: "input",
          text: ""
        }
      ],
      headings: [],
      links: [],
      tables: [],
      text: "Contact form",
      title: "Test",
      url: "https://example.com"
    };

    const sanitized = sanitizePageSnapshot(snapshot);
    const attributes = sanitized.elements[0]?.attributes;

    expect(attributes?.["aria-label"]).toBe("Email address");
    expect(attributes?.autocomplete).toBe("email");
    expect(attributes?.label).toBe("Work email label");
    expect(attributes?.name).toBe("email");
    expect(attributes?.placeholder).toBe("Work email");
    expect(attributes?.type).toBe("email");
    expect(attributes?.value).toBe("[redacted]");
  });

  it("sanitizes structured page headings and tables", () => {
    const snapshot: PageSnapshot = {
      capturedAt: new Date("2026-01-01T00:00:00.000Z").toISOString(),
      elements: [],
      headings: [
        {
          level: 1,
          selector: "#title",
          text: "A".repeat(600)
        }
      ],
      links: [],
      tables: [
        {
          caption: "Feature table",
          headers: ["Feature", "Status"],
          rows: [["Local agent", "Ready"]],
          selector: "#features"
        }
      ],
      text: "Feature table",
      title: "Test",
      url: "https://example.com"
    };

    const sanitized = sanitizePageSnapshot(snapshot);

    expect(sanitized.headings?.[0]?.text.length).toBeLessThanOrEqual(503);
    expect(sanitized.tables?.[0]?.caption).toBe("Feature table");
    expect(sanitized.tables?.[0]?.headers).toEqual(["Feature", "Status"]);
    expect(sanitized.tables?.[0]?.rows[0]).toEqual(["Local agent", "Ready"]);
  });

  it("redacts sensitive text and URL query values before sharing snapshots", () => {
    const snapshot: PageSnapshot = {
      capturedAt: new Date("2026-01-01T00:00:00.000Z").toISOString(),
      elements: [
        {
          attributes: {},
          selector: "#support",
          tagName: "button",
          text: "Email reviewer@example.test"
        }
      ],
      headings: [
        {
          level: 1,
          selector: "#heading",
          text: "Account reviewer@example.test"
        }
      ],
      links: [
        {
          href: "https://example.com/reset?token=secret-token&email=reviewer@example.test&ok=1",
          text: "Reset reviewer@example.test"
        }
      ],
      tables: [
        {
          caption: "Customer reviewer@example.test",
          headers: ["User", "Bearer abcdef123456"],
          rows: [["reviewer@example.test", "sk-test123456789"]],
          selector: "#customers"
        }
      ],
      text: "Contact reviewer@example.test with Bearer abcdef123456 and card 4111 1111 1111 1111.",
      title: "Account reviewer@example.test",
      url: "https://example.com/account?token=secret-token&email=reviewer@example.test&mode=view"
    };

    const sanitized = sanitizePageSnapshot(snapshot);

    expect(sanitized.text).toBe("Contact [redacted] with Bearer [redacted] and card [redacted].");
    expect(sanitized.title).toBe("Account [redacted]");
    expect(sanitized.elements[0]?.text).toBe("Email [redacted]");
    expect(sanitized.headings?.[0]?.text).toBe("Account [redacted]");
    expect(sanitized.links[0]?.href).toBe("https://example.com/reset?token=%5Bredacted%5D&email=%5Bredacted%5D&ok=1");
    expect(sanitized.links[0]?.text).toBe("Reset [redacted]");
    expect(sanitized.tables?.[0]?.caption).toBe("Customer [redacted]");
    expect(sanitized.tables?.[0]?.headers[1]).toBe("Bearer [redacted]");
    expect(sanitized.tables?.[0]?.rows[0]).toEqual(["[redacted]", "[redacted]"]);
    expect(sanitized.url).toBe("https://example.com/account?token=%5Bredacted%5D&email=%5Bredacted%5D&mode=view");
  });

  it("applies visible-text context policy before sharing snapshots", () => {
    const snapshot: PageSnapshot = {
      capturedAt: new Date("2026-01-01T00:00:00.000Z").toISOString(),
      elements: [
        {
          attributes: {
            "aria-label": "Buy",
            value: "private"
          },
          selector: "button:nth-of-type(1)",
          tagName: "button",
          text: "Buy"
        }
      ],
      headings: [
        {
          level: 1,
          selector: "#private-heading",
          text: "Private checkout"
        }
      ],
      links: [{ href: "https://example.com/pricing", text: "Pricing" }],
      tables: [
        {
          headers: ["Plan", "Price"],
          rows: [["Private", "$99"]],
          selector: "#private-table"
        }
      ],
      text: "Visible body text",
      title: "Test",
      url: "https://example.com"
    };

    const visibleOnly = applyContextPolicyToSnapshot(snapshot, "visible-text");

    expect(visibleOnly.text).toBe("Visible body text");
    expect(visibleOnly.elements).toHaveLength(0);
    expect(visibleOnly.headings).toHaveLength(0);
    expect(visibleOnly.links).toHaveLength(0);
    expect(visibleOnly.tables).toHaveLength(0);
  });

  it("keeps interaction metadata for interactive context policy", () => {
    const snapshot: PageSnapshot = {
      capturedAt: new Date("2026-01-01T00:00:00.000Z").toISOString(),
      elements: [
        {
          attributes: {
            value: "private@example.com"
          },
          selector: "input[name=\"email\"]",
          tagName: "input",
          text: ""
        }
      ],
      headings: [],
      links: [{ href: "https://example.com/pricing", text: "Pricing" }],
      tables: [],
      text: "Visible body text",
      title: "Test",
      url: "https://example.com"
    };

    const interactive = applyContextPolicyToSnapshot(snapshot, "interactive-elements");

    expect(interactive.links).toHaveLength(1);
    expect(interactive.elements).toHaveLength(1);
    expect(interactive.elements[0]?.attributes.value).toBe("[redacted]");
  });
});

describe("chat request validation", () => {
  it("accepts sanitized page context in chat requests", () => {
    const snapshot: PageSnapshot = {
      capturedAt: new Date("2026-01-01T00:00:00.000Z").toISOString(),
      elements: [],
      headings: [],
      links: [{ href: "https://example.com/pricing", text: "Pricing" }],
      tables: [],
      text: "Example page body",
      title: "Example",
      url: "https://example.com"
    };

    expect(
      chatRequestSchema.parse({
        message: "Summarize this page",
        pageSnapshot: snapshot
      }).pageSnapshot?.title
    ).toBe("Example");
  });
});

describe("task run validation", () => {
  it("accepts a task with recorded tool results", () => {
    const now = new Date("2026-01-01T00:00:00.000Z").toISOString();
    const parsed = taskRunSchema.parse({
      createdAt: now,
      message: "Extract links",
      plan: [
        {
          description: "Extract links",
          id: "step-1",
          status: "completed",
          toolCall: {
            args: {},
            id: "call-1",
            toolName: "extractLinks"
          }
        }
      ],
      results: [
        {
          createdAt: now,
          id: "result-1",
          result: {
            result: { links: [] },
            status: "completed",
            toolName: "extractLinks"
          },
          stepId: "step-1",
          toolCallId: "call-1"
        }
      ],
      status: "completed",
      taskId: "task-1",
      updatedAt: now
    });

    expect(parsed.results[0]?.result.status).toBe("completed");
  });

  it("accepts canceled task and step state", () => {
    const now = new Date("2026-01-01T00:00:00.000Z").toISOString();
    const parsed = taskRunSchema.parse({
      createdAt: now,
      message: "Stop this task",
      plan: [
        {
          description: "Pending browser action",
          id: "step-1",
          status: "canceled",
          toolCall: {
            args: {},
            id: "call-1",
            toolName: "extractLinks"
          }
        }
      ],
      results: [],
      status: "canceled",
      taskId: "task-canceled",
      updatedAt: now
    });

    expect(parsed.status).toBe("canceled");
    expect(parsed.plan[0]?.status).toBe("canceled");
  });

  it("accepts cancel-all task responses", () => {
    const now = new Date("2026-01-01T00:00:00.000Z").toISOString();
    const parsed = taskCancelAllResponseSchema.parse({
      canceledTaskCount: 1,
      revokedApprovalCount: 2,
      tasks: [
        {
          createdAt: now,
          message: "Stop pending tasks",
          plan: [
            {
              description: "Pending browser action",
              id: "step-1",
              status: "canceled",
              toolCall: {
                args: {},
                id: "call-1",
                toolName: "extractLinks"
              }
            }
          ],
          results: [],
          status: "canceled",
          taskId: "task-canceled",
          updatedAt: now
        }
      ]
    });

    expect(parsed.canceledTaskCount).toBe(1);
    expect(parsed.revokedApprovalCount).toBe(2);
    expect(parsed.tasks[0]?.status).toBe("canceled");
  });

  it("accepts task list and audit event list responses", () => {
    const now = new Date("2026-01-01T00:00:00.000Z").toISOString();
    const task = {
      createdAt: now,
      message: "Summarize",
      plan: [],
      results: [],
      status: "completed",
      taskId: "task-1",
      updatedAt: now
    };

    expect(taskListResponseSchema.parse({ tasks: [task] }).tasks[0]?.taskId).toBe("task-1");
    expect(taskResponseSchema.parse({ task }).task.taskId).toBe("task-1");
    expect(
      auditEventListResponseSchema.parse({
        events: [{ createdAt: now, id: "event-1", payload: { taskId: "task-1" }, type: "chat.plan" }]
      }).events[0]?.type
    ).toBe("chat.plan");
  });

  it("accepts realtime audit and task events", () => {
    const now = new Date("2026-01-01T00:00:00.000Z").toISOString();
    const task = {
      createdAt: now,
      message: "Extract links",
      plan: [],
      results: [],
      status: "pending",
      taskId: "task-1",
      updatedAt: now
    };

    expect(
      agentRealtimeEventSchema.parse({
        connectionId: "connection-1",
        createdAt: now,
        kind: "hello"
      }).kind
    ).toBe("hello");
    expect(
      agentRealtimeEventSchema.parse({
        event: { createdAt: now, id: "event-1", payload: { taskId: "task-1" }, type: "chat.plan" },
        kind: "audit"
      }).kind
    ).toBe("audit");
    expect(
      agentRealtimeEventSchema.parse({
        kind: "task",
        task
      }).kind
    ).toBe("task");
  });

  it("accepts task tool result responses with continuation output", () => {
    const now = new Date("2026-01-01T00:00:00.000Z").toISOString();
    const parsed = taskToolResultResponseSchema.parse({
      continuation: {
        message: "{\"prices\":[]}"
      },
      task: {
        createdAt: now,
        message: "Extract pricing",
        output: "{\"prices\":[]}",
        plan: [],
        results: [],
        status: "completed",
        taskId: "task-1",
        updatedAt: now
      }
    });

    expect(parsed.task.output).toBe("{\"prices\":[]}");
  });

  it("accepts task artifact list responses", () => {
    const now = new Date("2026-01-01T00:00:00.000Z").toISOString();
    const parsed = taskArtifactListResponseSchema.parse({
      artifacts: [
        {
          byteLength: 18,
          content: "{\"links\":[]}",
          createdAt: now,
          id: "artifact-1",
          kind: "tabs",
          mimeType: "application/json",
          source: "tool-result",
          sourceResultId: "result-1",
          taskId: "task-1",
          title: "Open tabs"
        }
      ]
    });

    expect(parsed.artifacts[0]?.kind).toBe("tabs");
  });

  it("accepts task artifact delete responses", () => {
    const parsed = taskArtifactDeleteResponseSchema.parse({
      artifactId: "artifact-1",
      deleted: true,
      taskId: "task-1"
    });

    expect(parsed.deleted).toBe(true);
  });

  it("accepts task delete responses", () => {
    const parsed = taskDeleteResponseSchema.parse({
      artifactCount: 2,
      deleted: true,
      resultCount: 1,
      revokedApprovalCount: 0,
      taskId: "task-1"
    });

    expect(parsed.taskId).toBe("task-1");
  });

  it("accepts approval rejection requests and responses", () => {
    const now = new Date("2026-01-01T00:00:00.000Z").toISOString();
    const request = approvalRejectRequestSchema.parse({
      approvalId: "approval-1",
      reason: "User declined.",
      stepId: "step-1",
      taskId: "task-1",
      token: "token-1",
      toolCallId: "call-1"
    });
    const response = approvalRejectResponseSchema.parse({
      result: {
        error: request.reason,
        status: "rejected",
        toolName: "click"
      },
      task: {
        createdAt: now,
        message: "Click the button",
        plan: [
          {
            description: "Click button",
            id: request.stepId,
            status: "failed",
            toolCall: {
              args: { selector: "button" },
              id: request.toolCallId,
              toolName: "click"
            }
          }
        ],
        results: [],
        status: "failed",
        taskId: request.taskId,
        updatedAt: now
      }
    });

    expect(response.result.status).toBe("rejected");
    expect(response.task?.status).toBe("failed");
  });
});

describe("provider config validation", () => {
  it("accepts health responses with redacted provider state", () => {
    const parsed = healthResponseSchema.parse({
      provider: {
        type: "disabled"
      },
      providerSource: "default",
      status: "ok"
    });

    expect(parsed.status).toBe("ok");
  });

  it("accepts redacted provider config responses", () => {
    const parsed = providerConfigResponseSchema.parse({
      config: {
        apiKey: "[redacted]",
        baseUrl: "https://llm.example/v1",
        model: "test-model",
        type: "openai-compatible"
      },
      source: "stored"
    });

    expect(parsed.config.type).toBe("openai-compatible");
  });

  it("accepts provider config test responses", () => {
    const parsed = providerConfigTestResponseSchema.parse({
      config: {
        baseUrl: "http://127.0.0.1:11434",
        model: "llama3.2",
        type: "ollama"
      },
      message: "Provider responded.",
      ok: true
    });

    expect(parsed.ok).toBe(true);
  });
});

describe("memory validation", () => {
  it("accepts pending, confirmed, and list memory responses", () => {
    const now = new Date("2026-01-01T00:00:00.000Z").toISOString();
    const pending = pendingMemoryWriteResponseSchema.parse({
      pending: {
        content: "Prefer local models.",
        id: "memory-1",
        tags: ["preference"],
        token: "token-1"
      },
      status: "requires_approval"
    });
    const confirmed = confirmedMemoryWriteResponseSchema.parse({
      memory: {
        content: pending.pending.content,
        createdAt: now,
        id: pending.pending.id,
        tags: pending.pending.tags
      }
    });
    const list = memoryListResponseSchema.parse({
      memories: [confirmed.memory]
    });

    expect(list.memories[0]?.content).toBe("Prefer local models.");
  });
});
