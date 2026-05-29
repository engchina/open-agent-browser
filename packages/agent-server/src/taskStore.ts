import {
  type BrowserToolResult,
  isHighRiskTool,
  summarizeBrowserToolResultForHistory,
  taskToolResultReportSchema,
  type AgentPlanStep,
  type TaskArtifact,
  type TaskRun,
  type TaskToolResultRecord,
  type TaskToolResultReport
} from "@open-agent-browser/shared";
import type { Database } from "./sqlite.js";

interface PlannedChatShape {
  message: string;
  plan: AgentPlanStep[];
  taskId: string;
  userMessage?: string;
}

export class TaskStore {
  private readonly artifacts = new Map<string, TaskArtifact[]>();
  private readonly tasks = new Map<string, TaskRun>();

  constructor(private readonly database?: Database) {
    this.database?.exec(`
      CREATE TABLE IF NOT EXISTS task_runs (
        task_id TEXT PRIMARY KEY,
        message TEXT NOT NULL,
        output TEXT,
        status TEXT NOT NULL,
        plan TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS task_tool_results (
        id TEXT PRIMARY KEY,
        task_id TEXT NOT NULL,
        step_id TEXT NOT NULL,
        tool_call_id TEXT NOT NULL,
        result TEXT NOT NULL,
        created_at TEXT NOT NULL,
        FOREIGN KEY(task_id) REFERENCES task_runs(task_id)
      );

      CREATE TABLE IF NOT EXISTS task_artifacts (
        id TEXT PRIMARY KEY,
        task_id TEXT NOT NULL,
        source TEXT NOT NULL,
        source_result_id TEXT,
        kind TEXT NOT NULL,
        title TEXT NOT NULL,
        mime_type TEXT NOT NULL,
        content TEXT NOT NULL,
        byte_length INTEGER NOT NULL,
        created_at TEXT NOT NULL,
        FOREIGN KEY(task_id) REFERENCES task_runs(task_id)
      );
    `);
    this.ensureOutputColumn();
  }

  create(chat: PlannedChatShape): TaskRun {
    const now = new Date().toISOString();
    const task: TaskRun = {
      createdAt: now,
      message: chat.userMessage ?? chat.message,
      plan: chat.plan,
      results: [],
      status: deriveTaskStatus(chat.plan),
      taskId: chat.taskId,
      updatedAt: now
    };

    if (this.database) {
      this.database
        .prepare("INSERT INTO task_runs (task_id, message, status, plan, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)")
        .run(task.taskId, task.message, task.status, JSON.stringify(task.plan), task.createdAt, task.updatedAt);
    } else {
      this.tasks.set(task.taskId, task);
    }
    return task;
  }

  get(taskId: string): TaskRun | undefined {
    if (this.database) {
      return this.getPersistedTask(taskId);
    }

    const task = this.tasks.get(taskId);
    return task ? cloneTask(task) : undefined;
  }

  validateToolResultReport(taskId: string, report: TaskToolResultReport): boolean {
    const task = this.database ? this.getPersistedTask(taskId) : this.tasks.get(taskId);
    if (!task) {
      return false;
    }

    const parsed = taskToolResultReportSchema.parse(report);
    validateReportMatchesPlan(task, parsed);
    return true;
  }

  recordToolResult(taskId: string, report: TaskToolResultReport): TaskRun | undefined {
    const task = this.database ? this.getPersistedTask(taskId) : this.tasks.get(taskId);
    if (!task) {
      return undefined;
    }

    const parsed = taskToolResultReportSchema.parse(report);
    validateReportMatchesPlan(task, parsed);
    const storedReport: TaskToolResultReport = {
      ...parsed,
      result: summarizeBrowserToolResultForHistory(parsed.result)
    };
    const record: TaskToolResultRecord = {
      ...storedReport,
      createdAt: new Date().toISOString(),
      id: crypto.randomUUID()
    };

    task.results.push(record);
    task.plan = task.plan.map((step) => {
      if (step.id !== parsed.stepId) {
        return step;
      }

      return {
        ...step,
        status: statusForToolResult(parsed.result.status)
      };
    });
    task.plan = unblockSafeFollowUpSteps(task.plan);
    task.status = deriveTaskStatus(task.plan);
    task.updatedAt = record.createdAt;

    if (this.database) {
      this.database
        .prepare("INSERT INTO task_tool_results (id, task_id, step_id, tool_call_id, result, created_at) VALUES (?, ?, ?, ?, ?, ?)")
        .run(record.id, taskId, record.stepId, record.toolCallId, JSON.stringify(record.result), record.createdAt);
      for (const artifact of createArtifactsForToolResult(taskId, record)) {
        this.insertArtifact(artifact);
      }
      this.database
        .prepare("UPDATE task_runs SET status = ?, plan = ?, updated_at = ? WHERE task_id = ?")
        .run(task.status, JSON.stringify(task.plan), task.updatedAt, taskId);
    } else {
      this.appendArtifacts(taskId, createArtifactsForToolResult(taskId, record));
    }

    return cloneTask(task);
  }

  cancel(taskId: string): TaskRun | undefined {
    const task = this.database ? this.getPersistedTask(taskId) : this.tasks.get(taskId);
    if (!task) {
      return undefined;
    }

    if (task.status === "completed" || task.status === "failed" || task.status === "canceled") {
      return cloneTask(task);
    }

    const now = new Date().toISOString();
    const updated: TaskRun = {
      ...task,
      plan: task.plan.map((step) =>
        step.status === "completed" || step.status === "failed" || step.status === "canceled"
          ? step
          : { ...step, status: "canceled" }
      ),
      status: "canceled",
      updatedAt: now
    };

    if (this.database) {
      this.database
        .prepare("UPDATE task_runs SET status = ?, plan = ?, updated_at = ? WHERE task_id = ?")
        .run(updated.status, JSON.stringify(updated.plan), updated.updatedAt, taskId);
    } else {
      this.tasks.set(taskId, updated);
    }

    return cloneTask(updated);
  }

  cancelAllActive(): TaskRun[] {
    const activeTasks = this.list().filter(isCancelableTaskRun);
    const canceled: TaskRun[] = [];

    for (const task of activeTasks) {
      const updated = this.cancel(task.taskId);
      if (updated?.status === "canceled") {
        canceled.push(updated);
      }
    }

    return canceled;
  }

  delete(taskId: string): TaskRun | undefined {
    const task = this.database ? this.getPersistedTask(taskId) : this.tasks.get(taskId);
    if (!task) {
      return undefined;
    }

    if (this.database) {
      this.database.prepare("DELETE FROM task_artifacts WHERE task_id = ?").run(taskId);
      this.database.prepare("DELETE FROM task_tool_results WHERE task_id = ?").run(taskId);
      this.database.prepare("DELETE FROM task_runs WHERE task_id = ?").run(taskId);
    } else {
      this.tasks.delete(taskId);
      this.artifacts.delete(taskId);
    }

    return cloneTask(task);
  }

  setOutput(taskId: string, output: string): TaskRun | undefined {
    const task = this.database ? this.getPersistedTask(taskId) : this.tasks.get(taskId);
    if (!task) {
      return undefined;
    }

    const updated: TaskRun = {
      ...task,
      output,
      updatedAt: new Date().toISOString()
    };

    if (this.database) {
      this.database
        .prepare("UPDATE task_runs SET output = ?, updated_at = ? WHERE task_id = ?")
        .run(output, updated.updatedAt, taskId);
      this.insertArtifact(createOutputArtifact(taskId, output, updated.updatedAt));
    } else {
      this.tasks.set(taskId, updated);
      this.appendArtifacts(taskId, [createOutputArtifact(taskId, output, updated.updatedAt)]);
    }

    return cloneTask(updated);
  }

  updatePlan(taskId: string, plan: AgentPlanStep[]): TaskRun | undefined {
    const task = this.database ? this.getPersistedTask(taskId) : this.tasks.get(taskId);
    if (!task) {
      return undefined;
    }

    const updated: TaskRun = {
      ...task,
      plan,
      status: deriveTaskStatus(plan),
      updatedAt: new Date().toISOString()
    };

    if (this.database) {
      this.database
        .prepare("UPDATE task_runs SET status = ?, plan = ?, updated_at = ? WHERE task_id = ?")
        .run(updated.status, JSON.stringify(updated.plan), updated.updatedAt, taskId);
    } else {
      this.tasks.set(taskId, updated);
    }

    return cloneTask(updated);
  }

  list(): TaskRun[] {
    if (!this.database) {
      return [...this.tasks.values()].map(cloneTask);
    }

    return this.database
      .prepare("SELECT task_id FROM task_runs ORDER BY created_at DESC")
      .all()
      .flatMap((row) => {
        const typed = row as { task_id: string };
        const task = this.getPersistedTask(typed.task_id);
        return task ? [task] : [];
      });
  }

  listArtifacts(taskId: string): TaskArtifact[] {
    if (!this.database) {
      return (this.artifacts.get(taskId) ?? []).map(cloneArtifact);
    }

    return (this.database
      .prepare(`
        SELECT id, task_id, source, source_result_id, kind, title, mime_type, content, byte_length, created_at
        FROM task_artifacts
        WHERE task_id = ?
        ORDER BY created_at ASC
      `)
      .all(taskId) as Array<{
        byte_length: number;
        content: string;
        created_at: string;
        id: string;
        kind: TaskArtifact["kind"];
        mime_type: string;
        source: TaskArtifact["source"];
        source_result_id: string | null;
        task_id: string;
        title: string;
      }>).map((row) => ({
        byteLength: row.byte_length,
        content: row.content,
        createdAt: row.created_at,
        id: row.id,
        kind: row.kind,
        mimeType: row.mime_type,
        source: row.source,
        ...(row.source_result_id ? { sourceResultId: row.source_result_id } : {}),
        taskId: row.task_id,
        title: row.title
      }));
  }

  deleteArtifact(taskId: string, artifactId: string): TaskArtifact | undefined {
    if (!this.get(taskId)) {
      return undefined;
    }

    if (!this.database) {
      const current = this.artifacts.get(taskId) ?? [];
      const artifact = current.find((candidate) => candidate.id === artifactId);
      if (!artifact) {
        return undefined;
      }

      this.artifacts.set(taskId, current.filter((candidate) => candidate.id !== artifactId));
      return cloneArtifact(artifact);
    }

    const artifact = this.getPersistedArtifact(taskId, artifactId);
    if (!artifact) {
      return undefined;
    }

    this.database
      .prepare("DELETE FROM task_artifacts WHERE task_id = ? AND id = ?")
      .run(taskId, artifactId);
    return artifact;
  }

  private getPersistedTask(taskId: string): TaskRun | undefined {
    if (!this.database) {
      return undefined;
    }

    const rows = this.database
      .prepare("SELECT task_id, message, output, status, plan, created_at, updated_at FROM task_runs WHERE task_id = ?")
      .all(taskId);
    const row = rows[0] as {
      created_at: string;
      message: string;
      output: string | null;
      plan: string;
      status: TaskRun["status"];
      task_id: string;
      updated_at: string;
    } | undefined;

    if (!row) {
      return undefined;
    }

    const resultRows = this.database
      .prepare("SELECT id, step_id, tool_call_id, result, created_at FROM task_tool_results WHERE task_id = ? ORDER BY created_at ASC")
      .all(taskId) as Array<{
        created_at: string;
        id: string;
        result: string;
        step_id: string;
        tool_call_id: string;
      }>;

    const task: TaskRun = {
      createdAt: row.created_at,
      message: row.message,
      plan: JSON.parse(row.plan) as AgentPlanStep[],
      results: resultRows.map((resultRow) => ({
        createdAt: resultRow.created_at,
        id: resultRow.id,
        result: JSON.parse(resultRow.result) as TaskToolResultRecord["result"],
        stepId: resultRow.step_id,
        toolCallId: resultRow.tool_call_id
      })),
      status: row.status,
      taskId: row.task_id,
      updatedAt: row.updated_at
    };

    if (row.output) {
      task.output = row.output;
    }

    return task;
  }

  private ensureOutputColumn(): void {
    if (!this.database) {
      return;
    }

    const columns = this.database.prepare("PRAGMA table_info(task_runs)").all() as Array<{ name: string }>;
    if (!columns.some((column) => column.name === "output")) {
      this.database.prepare("ALTER TABLE task_runs ADD COLUMN output TEXT").run();
    }
  }

  private appendArtifacts(taskId: string, artifacts: TaskArtifact[]): void {
    if (artifacts.length === 0) {
      return;
    }

    const current = this.artifacts.get(taskId) ?? [];
    this.artifacts.set(taskId, [
      ...current,
      ...artifacts.map(cloneArtifact)
    ]);
  }

  private insertArtifact(artifact: TaskArtifact): void {
    if (!this.database) {
      return;
    }

    this.database
      .prepare(`
        INSERT INTO task_artifacts (
          id,
          task_id,
          source,
          source_result_id,
          kind,
          title,
          mime_type,
          content,
          byte_length,
          created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `)
      .run(
        artifact.id,
        artifact.taskId,
        artifact.source,
        artifact.sourceResultId ?? null,
        artifact.kind,
        artifact.title,
        artifact.mimeType,
        artifact.content,
        artifact.byteLength,
        artifact.createdAt
      );
  }

  private getPersistedArtifact(taskId: string, artifactId: string): TaskArtifact | undefined {
    if (!this.database) {
      return undefined;
    }

    const rows = this.database
      .prepare(`
        SELECT id, task_id, source, source_result_id, kind, title, mime_type, content, byte_length, created_at
        FROM task_artifacts
        WHERE task_id = ? AND id = ?
      `)
      .all(taskId, artifactId) as Array<{
        byte_length: number;
        content: string;
        created_at: string;
        id: string;
        kind: TaskArtifact["kind"];
        mime_type: string;
        source: TaskArtifact["source"];
        source_result_id: string | null;
        task_id: string;
        title: string;
      }>;
    const row = rows[0];
    if (!row) {
      return undefined;
    }

    return {
      byteLength: row.byte_length,
      content: row.content,
      createdAt: row.created_at,
      id: row.id,
      kind: row.kind,
      mimeType: row.mime_type,
      source: row.source,
      ...(row.source_result_id ? { sourceResultId: row.source_result_id } : {}),
      taskId: row.task_id,
      title: row.title
    };
  }
}

export class TaskToolResultValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TaskToolResultValidationError";
  }
}

function validateReportMatchesPlan(task: TaskRun, report: TaskToolResultReport): void {
  if (task.status === "canceled") {
    throw new TaskToolResultValidationError("Tool results cannot be recorded for a canceled task.");
  }

  const step = task.plan.find((candidate) => candidate.id === report.stepId);
  if (!step) {
    throw new TaskToolResultValidationError("Tool result step does not belong to this task.");
  }

  if (!step.toolCall) {
    throw new TaskToolResultValidationError("Tool result step has no planned browser tool call.");
  }

  if (step.toolCall.id !== report.toolCallId) {
    throw new TaskToolResultValidationError("Tool result call ID does not match the planned browser tool call.");
  }

  if (step.toolCall.toolName !== report.result.toolName) {
    throw new TaskToolResultValidationError("Tool result tool name does not match the planned browser tool call.");
  }

  if (report.result.status === "queued" || report.result.status === "requires_approval") {
    throw new TaskToolResultValidationError("Tool result status must be a terminal browser execution result.");
  }
}

function statusForToolResult(status: TaskToolResultReport["result"]["status"]): AgentPlanStep["status"] {
  switch (status) {
    case "completed":
    case "queued":
      return "completed";
    case "requires_approval":
      return "blocked";
    case "rejected":
    case "error":
      return "failed";
  }
}

function unblockSafeFollowUpSteps(plan: AgentPlanStep[]): AgentPlanStep[] {
  const hasCompletedHighRiskStep = plan.some((step) =>
    step.status === "completed" && step.toolCall && isHighRiskTool(step.toolCall.toolName)
  );

  if (!hasCompletedHighRiskStep) {
    return plan;
  }

  return plan.map((step) => {
    if (step.status !== "blocked" || !step.toolCall || isHighRiskTool(step.toolCall.toolName)) {
      return step;
    }

    return {
      ...step,
      status: "pending"
    };
  });
}

function deriveTaskStatus(plan: AgentPlanStep[]): TaskRun["status"] {
  if (plan.length > 0 && plan.every((step) => step.status === "completed" || step.status === "canceled")) {
    return plan.some((step) => step.status === "canceled") ? "canceled" : "completed";
  }

  if (plan.some((step) => step.status === "failed")) {
    return "failed";
  }

  if (plan.some((step) => step.status === "blocked")) {
    return "blocked";
  }

  if (plan.some((step) => step.status === "running")) {
    return "running";
  }

  if (plan.some((step) => step.status === "pending")) {
    return "pending";
  }

  return "completed";
}

function isCancelableTaskRun(task: TaskRun): boolean {
  return task.status === "pending" || task.status === "running" || task.status === "blocked";
}

function cloneTask(task: TaskRun): TaskRun {
  return {
    ...task,
    plan: task.plan.map((step) => ({ ...step })),
    results: task.results.map((result) => ({ ...result }))
  };
}

function createArtifactsForToolResult(taskId: string, record: TaskToolResultRecord): TaskArtifact[] {
  const result = record.result as BrowserToolResult;
  if (result.status !== "completed") {
    return [];
  }

  switch (result.toolName) {
    case "extractLinks":
      return [
        createArtifact({
          content: formatJson(result.result),
          createdAt: record.createdAt,
          kind: "links",
          mimeType: "application/json",
          source: "tool-result",
          sourceResultId: record.id,
          taskId,
          title: "Extracted links"
        })
      ];
    case "extractText": {
      const text = isRecord(result.result) && typeof result.result.text === "string"
        ? result.result.text
        : formatJson(result.result);
      return [
        createArtifact({
          content: text,
          createdAt: record.createdAt,
          kind: "text",
          mimeType: "text/plain",
          source: "tool-result",
          sourceResultId: record.id,
          taskId,
          title: "Extracted text"
        })
      ];
    }
    case "getPageSnapshot":
      return [
        createArtifact({
          content: formatJson(result.result),
          createdAt: record.createdAt,
          kind: "snapshot",
          mimeType: "application/json",
          source: "tool-result",
          sourceResultId: record.id,
          taskId,
          title: "Page snapshot"
        })
      ];
    case "screenshot":
      return [
        createArtifact({
          content: formatJson(result.result),
          createdAt: record.createdAt,
          kind: "screenshot-metadata",
          mimeType: "application/json",
          source: "tool-result",
          sourceResultId: record.id,
          taskId,
          title: "Screenshot metadata"
        })
      ];
    case "listTabs":
      return [
        createArtifact({
          content: formatJson(result.result),
          createdAt: record.createdAt,
          kind: "tabs",
          mimeType: "application/json",
          source: "tool-result",
          sourceResultId: record.id,
          taskId,
          title: "Open tabs"
        })
      ];
    default:
      return [];
  }
}

function createOutputArtifact(taskId: string, output: string, createdAt: string): TaskArtifact {
  const json = tryParseJson(output);
  return createArtifact({
    content: json === undefined ? output : JSON.stringify(json, null, 2),
    createdAt,
    kind: json === undefined ? "text" : "json",
    mimeType: json === undefined ? "text/plain" : "application/json",
    source: "agent-output",
    taskId,
    title: "Agent output"
  });
}

function createArtifact(input: Omit<TaskArtifact, "byteLength" | "id">): TaskArtifact {
  return {
    ...input,
    byteLength: Buffer.byteLength(input.content, "utf8"),
    id: crypto.randomUUID()
  };
}

function formatJson(value: unknown): string {
  return JSON.stringify(value ?? null, null, 2);
}

function tryParseJson(value: string): unknown | undefined {
  try {
    return JSON.parse(value) as unknown;
  } catch {
    return undefined;
  }
}

function cloneArtifact(artifact: TaskArtifact): TaskArtifact {
  return {
    ...artifact
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
