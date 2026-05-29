import {
  Bot,
  Brain,
  Check,
  ClipboardList,
  Copy,
  Download,
  Eye,
  FileText,
  History,
  Layers,
  MousePointerClick,
  Play,
  Plus,
  RefreshCw,
  ScrollText,
  ShieldAlert,
  Send,
  Trash2,
  X
} from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import {
  agentRealtimeEventSchema,
  applyContextPolicyToSnapshot,
  isHighRiskTool,
  summarizeToolCallForApproval,
  type AgentPlanStep,
  type AuditEvent,
  type BrowserToolResult,
  type ContextPolicy,
  type HealthResponse,
  type HumanApprovalRequest,
  type MemoryRecord,
  type PendingMemoryWrite,
  type TaskArtifact,
  type TaskRun
} from "@open-agent-browser/shared";
import { executeBrowserTool, getPageSnapshot } from "../../lib/browserTools.js";
import { consumeLaunchDraft } from "../../lib/launchDraft.js";
import {
  cancelAllTasks,
  cancelTask,
  clearPublishedPageSnapshot,
  confirmMemoryWrite,
  deleteMemory,
  deleteTask,
  deleteTaskArtifact,
  fetchTask,
  getAgentBaseUrl,
  getHealth,
  listTaskArtifacts,
  publishPageSnapshot,
  listAuditEvents,
  listMemories,
  listTasks,
  openAgentEventSocket,
  reportToolResult,
  requestMemoryWrite,
  rejectApproval,
  requestToolExecution,
  sendChat
} from "../../lib/apiClient.js";

type Message = {
  body: string;
  role: "agent" | "user";
};

type View = "chat" | "history" | "audit" | "memory";
type AgentStatus = "checking" | "connected" | "offline";
type RealtimeStatus = "connecting" | "connected" | "offline";

const maxAutoRunSteps = 8;

export function App() {
  const [messages, setMessages] = useState<Message[]>([
    {
      body: "Ready. Page context stays local until you ask me to use it.",
      role: "agent"
    }
  ]);
  const [input, setInput] = useState("");
  const [plan, setPlan] = useState<AgentPlanStep[]>([]);
  const [approvals, setApprovals] = useState<HumanApprovalRequest[]>([]);
  const [auditEvents, setAuditEvents] = useState<AuditEvent[]>([]);
  const [memoryContent, setMemoryContent] = useState("");
  const [memoryTags, setMemoryTags] = useState("");
  const [memories, setMemories] = useState<MemoryRecord[]>([]);
  const [pendingMemory, setPendingMemory] = useState<PendingMemoryWrite>();
  const [taskId, setTaskId] = useState<string>();
  const [selectedTaskId, setSelectedTaskId] = useState<string>();
  const [selectedArtifacts, setSelectedArtifacts] = useState<TaskArtifact[]>([]);
  const [tasks, setTasks] = useState<TaskRun[]>([]);
  const [view, setView] = useState<View>("chat");
  const [contextPolicy, setContextPolicy] = useState<ContextPolicy>("interactive-elements");
  const [busy, setBusy] = useState(false);
  const [agentHealth, setAgentHealth] = useState<HealthResponse>();
  const [agentStatus, setAgentStatus] = useState<AgentStatus>("checking");
  const [agentStatusMessage, setAgentStatusMessage] = useState("Checking local agent server.");
  const [realtimeStatus, setRealtimeStatus] = useState<RealtimeStatus>("connecting");
  const [realtimeStatusMessage, setRealtimeStatusMessage] = useState("Connecting to local event stream.");
  const taskIdRef = useRef<string | undefined>(undefined);
  const targetTabId = useMemo(() => readTargetTabId(), []);
  const canSend = useMemo(() => input.trim().length > 0 && !busy, [busy, input]);
  const agentStatusLabel = useMemo(
    () => formatAgentStatusLabel(agentStatus, agentHealth),
    [agentHealth, agentStatus]
  );
  const runnableSteps = useMemo(
    () => safeRunnableSteps(plan),
    [plan]
  );
  const canCancelCurrentTask = useMemo(
    () => Boolean(taskId) && hasCancelableSteps(plan),
    [plan, taskId]
  );
  const activeTaskCount = useMemo(
    () => tasks.filter(isCancelableTask).length,
    [tasks]
  );
  const selectedTask = useMemo(
    () => tasks.find((task) => task.taskId === selectedTaskId),
    [selectedTaskId, tasks]
  );

  useEffect(() => {
    void refreshAgentHealth();
  }, []);

  useEffect(() => {
    async function loadLaunchDraft() {
      const draft = await consumeLaunchDraft();
      if (!draft) {
        return;
      }

      setInput(draft.message);
      setMessages((current) => [
        ...current,
        {
          body: "Loaded task draft.",
          role: "agent"
        }
      ]);
    }

    void loadLaunchDraft();
  }, []);

  useEffect(() => {
    taskIdRef.current = taskId;
  }, [taskId]);

  useEffect(() => {
    let active = true;
    let socket: WebSocket | undefined;

    async function connect() {
      setRealtimeStatus("connecting");
      try {
        socket = await openAgentEventSocket();
      } catch (error) {
        if (!active) {
          return;
        }
        setRealtimeStatus("offline");
        setRealtimeStatusMessage(error instanceof Error ? error.message : "Failed to connect to local event stream.");
        return;
      }

      socket.addEventListener("open", () => {
        if (!active) {
          return;
        }
        setRealtimeStatus("connected");
        setRealtimeStatusMessage("Receiving task and audit updates from the local server.");
      });
      socket.addEventListener("message", (event) => {
        if (!active) {
          return;
        }
        handleRealtimeMessage(event.data);
      });
      socket.addEventListener("close", () => {
        if (!active) {
          return;
        }
        setRealtimeStatus("offline");
        setRealtimeStatusMessage("Local event stream is disconnected.");
      });
      socket.addEventListener("error", () => {
        if (!active) {
          return;
        }
        setRealtimeStatus("offline");
        setRealtimeStatusMessage("Local event stream reported an error.");
      });
    }

    void connect();

    return () => {
      active = false;
      socket?.close();
    };
  }, []);

  async function refreshAgentHealth() {
    setAgentStatus("checking");

    try {
      const [baseUrl, health] = await Promise.all([
        getAgentBaseUrl(),
        getHealth()
      ]);
      setAgentHealth(health);
      setAgentStatus("connected");
      setAgentStatusMessage(
        `Connected to ${baseUrl}. Provider: ${formatProviderLabel(health.provider)} (${health.providerSource}).`
      );
    } catch (error) {
      setAgentHealth(undefined);
      setAgentStatus("offline");
      setAgentStatusMessage(error instanceof Error ? error.message : "Local agent server is unreachable.");
    }
  }

  function handleRealtimeMessage(data: unknown) {
    try {
      const event = agentRealtimeEventSchema.parse(JSON.parse(String(data)));

      if (event.kind === "hello") {
        setRealtimeStatus("connected");
        setRealtimeStatusMessage(`Connected to local event stream: ${event.connectionId}.`);
        return;
      }

      if (event.kind === "audit") {
        setAuditEvents((current) => upsertAuditEvent(current, event.event));
        return;
      }

      setTasks((current) => upsertTask(current, event.task));
      if (event.task.taskId === taskIdRef.current) {
        setPlan(event.task.plan);
      }
    } catch {
      setRealtimeStatusMessage("Ignored an invalid local event stream payload.");
    }
  }

  async function submit() {
    if (!canSend) {
      return;
    }

    const message = input.trim();
    setInput("");
    setBusy(true);
    setMessages((current) => [...current, { body: message, role: "user" }]);

    try {
      const rawSnapshot = await getPageSnapshot(targetTabId, {
        maxElements: 500,
        maxTextLength: 30000
      });
      const snapshot = applyContextPolicyToSnapshot(rawSnapshot, contextPolicy);
      await publishPageSnapshot(snapshot);
      const response = await sendChat({
        contextPolicy,
        message,
        pageSnapshot: snapshot,
        tabId: snapshot.tabId
      });

      setPlan(response.plan);
      setApprovals(response.approvalRequests);
      setTaskId(response.taskId);
      await refreshHistory();
      await refreshAgentHealth();
      setMessages((current) => [...current, { body: response.message, role: "agent" }]);
      await runSafeStepsFromPlan(response.plan, response.taskId);
    } catch (error) {
      void refreshAgentHealth();
      setMessages((current) => [
        ...current,
        {
          body: error instanceof Error ? error.message : "Failed to contact local agent server.",
          role: "agent"
        }
      ]);
    } finally {
      setBusy(false);
    }
  }

  async function runStep(step: AgentPlanStep, confirmationToken?: string) {
    setBusy(true);
    try {
      await runStepCore(step, confirmationToken, true, taskId);
    } finally {
      setBusy(false);
    }
  }

  async function runStepCore(
    step: AgentPlanStep,
    confirmationToken?: string,
    autoContinue = false,
    activeTaskId = taskId
  ): Promise<AgentPlanStep[] | undefined> {
    if (!step.toolCall) {
      return undefined;
    }

    const toolCall = step.toolCall;
    markStep(step.id, "running");

    try {
      const serverResult = await requestToolExecution({
        ...toolCall,
        confirmationToken
      });

      if (serverResult.status === "requires_approval" && serverResult.approvalRequest) {
        markStep(step.id, "blocked");
        setApprovals((current) => mergeApprovals(current, [serverResult.approvalRequest!]));
        return undefined;
      }

      if (serverResult.status === "queued") {
        let result: BrowserToolResult;
        try {
          result = await executeBrowserTool(toolCall);
        } catch (executionError) {
          const message = errorMessage(executionError, "Tool execution failed.");
          const failedResult: BrowserToolResult = {
            auditLogId: serverResult.auditLogId,
            error: message,
            status: "error",
            toolName: toolCall.toolName
          };
          let nextPlan: AgentPlanStep[] | undefined;

          if (activeTaskId) {
            try {
              const report = await reportToolResult(activeTaskId, {
                result: failedResult,
                stepId: step.id,
                toolCallId: toolCall.id
              });
              setPlan(report.task.plan);
              setTasks((current) => upsertTask(current, report.task));
              nextPlan = report.task.plan;
              await refreshHistory();
            } catch (reportError) {
              markStep(step.id, "failed");
              setMessages((current) => [
                ...current,
                {
                  body: `${toolCall.toolName} failed: ${message}. Could not record the failed result: ${errorMessage(reportError, "Unknown reporting error.")}`,
                  role: "agent"
                }
              ]);
              return undefined;
            }
          } else {
            markStep(step.id, "failed");
          }

          setMessages((current) => [
            ...current,
            {
              body: `${toolCall.toolName} failed: ${message}`,
              role: "agent"
            }
          ]);
          return nextPlan;
        }
        let continuationMessage: string | undefined;
        let nextPlan: AgentPlanStep[] | undefined;
        const completedResult = {
          ...result,
          auditLogId: serverResult.auditLogId
        };

        if (activeTaskId) {
          const report = await reportToolResult(activeTaskId, {
            result: completedResult,
            stepId: step.id,
            toolCallId: toolCall.id
          });
          setPlan(report.task.plan);
          nextPlan = report.task.plan;
          if (report.approvalRequests.length > 0) {
            setApprovals((current) => mergeApprovals(current, report.approvalRequests));
          }
          await refreshHistory();
          if (report.continuation) {
            continuationMessage = report.continuation.message;
          }
        } else {
          markStep(step.id, "completed");
        }

        setMessages((current) => [
          ...current,
          {
            body: `${toolCall.toolName} completed: ${JSON.stringify(result.result).slice(0, 500)}`,
            role: "agent"
          },
          ...(continuationMessage ? [{ body: continuationMessage, role: "agent" as const }] : [])
        ]);

        if (autoContinue && nextPlan) {
          await runSafeStepsFromPlan(nextPlan, activeTaskId);
        }

        return nextPlan;
      }
    } catch (error) {
      setMessages((current) => [
        ...current,
        {
          body: error instanceof Error ? error.message : "Tool execution failed.",
          role: "agent"
        }
      ]);
      markStep(step.id, "failed");
    }

    return undefined;
  }

  async function approve(request: HumanApprovalRequest) {
    setApprovals((current) => current.filter((item) => item.id !== request.id));
    const step = plan.find((candidate) => candidate.toolCall?.id === request.toolCall.id);

    if (!step) {
      setMessages((current) => [
        ...current,
        {
          body: "The approval target is no longer in the active plan.",
          role: "agent"
        }
      ]);
      return;
    }

    await runStep(step, request.token);
  }

  async function reject(request: HumanApprovalRequest) {
    setBusy(true);
    try {
      const step = plan.find((candidate) => candidate.toolCall?.id === request.toolCall.id);
      const response = await rejectApproval({
        approvalId: request.id,
        reason: "Rejected from side panel.",
        stepId: step?.id,
        taskId,
        token: request.token,
        toolCallId: request.toolCall.id
      });

      setApprovals((current) => current.filter((item) => item.id !== request.id));
      if (response.task) {
        setPlan(response.task.plan);
        setTasks((current) => upsertTask(current, response.task!));
      } else if (step) {
        markStep(step.id, "failed");
      }
      await refreshHistory();
      setMessages((current) => [
        ...current,
        {
          body: `${request.toolCall.toolName} rejected.`,
          role: "agent"
        }
      ]);
    } catch (error) {
      setMessages((current) => [
        ...current,
        {
          body: error instanceof Error ? error.message : "Failed to reject approval.",
          role: "agent"
        }
      ]);
    } finally {
      setBusy(false);
    }
  }

  async function runRunnableSteps() {
    setBusy(true);
    try {
      await runSafeStepsFromPlan(plan, taskId);
    } finally {
      setBusy(false);
    }
  }

  async function cancelTaskRun(taskIdToCancel: string, reason: string) {
    setBusy(true);
    try {
      const response = await cancelTask(taskIdToCancel, reason);
      setTasks((current) => upsertTask(current, response.task));
      if (response.task.taskId === taskId) {
        setPlan(response.task.plan);
        setApprovals([]);
      }
      if (response.task.taskId === selectedTaskId) {
        setSelectedTaskId(response.task.taskId);
      }
      await refreshHistory();
      setMessages((current) => [
        ...current,
        {
          body: `Canceled task ${response.task.taskId.slice(0, 8)}.`,
          role: "agent"
        }
      ]);
    } catch (error) {
      setMessages((current) => [
        ...current,
        {
          body: error instanceof Error ? error.message : "Failed to cancel task.",
          role: "agent"
        }
      ]);
    } finally {
      setBusy(false);
    }
  }

  async function cancelAllTaskRuns() {
    setBusy(true);
    try {
      const response = await cancelAllTasks("Canceled from side panel global stop.");
      setTasks((current) =>
        response.tasks.reduce((nextTasks, task) => upsertTask(nextTasks, task), current)
      );
      if (taskId && response.tasks.some((task) => task.taskId === taskId)) {
        const currentTask = response.tasks.find((task) => task.taskId === taskId);
        setPlan(currentTask?.plan ?? []);
        setApprovals([]);
      }
      if (selectedTaskId && response.tasks.some((task) => task.taskId === selectedTaskId)) {
        setSelectedTaskId(selectedTaskId);
      }
      await refreshHistory();
      setMessages((current) => [
        ...current,
        {
          body: `Stopped ${response.canceledTaskCount} active task${response.canceledTaskCount === 1 ? "" : "s"} and revoked ${response.revokedApprovalCount} approval${response.revokedApprovalCount === 1 ? "" : "s"}.`,
          role: "agent"
        }
      ]);
    } catch (error) {
      setMessages((current) => [
        ...current,
        {
          body: error instanceof Error ? error.message : "Failed to stop active tasks.",
          role: "agent"
        }
      ]);
    } finally {
      setBusy(false);
    }
  }

  async function deleteTaskRun(taskIdToDelete: string) {
    setBusy(true);
    try {
      const response = await deleteTask(taskIdToDelete);
      setTasks((current) => current.filter((candidate) => candidate.taskId !== response.taskId));
      if (selectedTaskId === response.taskId) {
        setSelectedTaskId(undefined);
        setSelectedArtifacts([]);
      }
      if (taskId === response.taskId) {
        setTaskId(undefined);
        setPlan([]);
        setApprovals([]);
      }
      await refreshHistory();
      setMessages((current) => [
        ...current,
        {
          body: `Deleted task ${response.taskId.slice(0, 8)} and ${response.artifactCount} artifact${response.artifactCount === 1 ? "" : "s"}.`,
          role: "agent"
        }
      ]);
    } catch (error) {
      setMessages((current) => [
        ...current,
        {
          body: error instanceof Error ? error.message : "Failed to delete task.",
          role: "agent"
        }
      ]);
    } finally {
      setBusy(false);
    }
  }

  async function clearPageContext() {
    setBusy(true);
    try {
      const response = await clearPublishedPageSnapshot(targetTabId);
      await refreshHistory();
      setMessages((current) => [
        ...current,
        {
          body: `Cleared ${response.cleared} local page context record${response.cleared === 1 ? "" : "s"}.`,
          role: "agent"
        }
      ]);
    } catch (error) {
      setMessages((current) => [
        ...current,
        {
          body: error instanceof Error ? error.message : "Failed to clear page context.",
          role: "agent"
        }
      ]);
    } finally {
      setBusy(false);
    }
  }

  async function runSafeStepsFromPlan(steps: AgentPlanStep[], activeTaskId?: string) {
    let currentPlan = steps;
    const executedStepIds = new Set<string>();

    for (let runCount = 0; runCount < maxAutoRunSteps; runCount += 1) {
      const nextStep = safeRunnableSteps(currentPlan).find((step) => !executedStepIds.has(step.id));
      if (!nextStep) {
        return;
      }

      executedStepIds.add(nextStep.id);
      const updatedPlan = await runStepCore(nextStep, undefined, false, activeTaskId);
      if (updatedPlan) {
        currentPlan = updatedPlan;
      } else {
        currentPlan = currentPlan.map((step) =>
          step.id === nextStep.id ? { ...step, status: "completed" } : step
        );
      }
    }

    if (safeRunnableSteps(currentPlan).some((step) => !executedStepIds.has(step.id))) {
      setMessages((current) => [
        ...current,
        {
          body: `Stopped after ${maxAutoRunSteps} automatic safe steps. Review the remaining plan before continuing.`,
          role: "agent"
        }
      ]);
    }
  }

  function markStep(stepId: string, status: AgentPlanStep["status"]) {
    setPlan((current) =>
      current.map((step) => step.id === stepId ? { ...step, status } : step)
    );
  }

  function safeRunnableSteps(steps: AgentPlanStep[]): AgentPlanStep[] {
    return steps.filter((step) =>
      step.status === "pending" &&
      step.toolCall &&
      !isHighRiskTool(step.toolCall.toolName)
    );
  }

  function hasCancelableSteps(steps: AgentPlanStep[]): boolean {
    return steps.some((step) =>
      step.status === "pending" || step.status === "running" || step.status === "blocked"
    );
  }

  function isCancelableTask(task: TaskRun): boolean {
    return task.status === "pending" || task.status === "running" || task.status === "blocked";
  }

  async function switchView(nextView: View) {
    setView(nextView);
    if (nextView !== "chat") {
      setBusy(true);
      try {
        if (nextView === "memory") {
          await refreshMemories();
        } else {
          await refreshHistory();
        }
      } catch (error) {
        setMessages((current) => [
          ...current,
          {
            body: error instanceof Error ? error.message : "Failed to load history.",
            role: "agent"
          }
        ]);
      } finally {
        setBusy(false);
      }
    }
  }

  async function refreshHistory() {
    const [nextTasks, nextAuditEvents] = await Promise.all([
      listTasks(),
      listAuditEvents()
    ]);
    setTasks(nextTasks);
    setAuditEvents(nextAuditEvents);
  }

  async function refreshMemories() {
    setMemories(await listMemories());
  }

  async function openTask(taskIdToOpen: string) {
    setBusy(true);
    try {
      const [task, artifacts] = await Promise.all([
        fetchTask(taskIdToOpen),
        listTaskArtifacts(taskIdToOpen)
      ]);
      setSelectedTaskId(task.taskId);
      setSelectedArtifacts(artifacts);
      setTasks((current) => upsertTask(current, task));
    } catch (error) {
      setMessages((current) => [
        ...current,
        {
          body: error instanceof Error ? error.message : "Failed to load task details.",
          role: "agent"
        }
      ]);
    } finally {
      setBusy(false);
    }
  }

  async function copyArtifact(artifact: TaskArtifact) {
    await navigator.clipboard.writeText(artifact.content);
    setMessages((current) => [
      ...current,
      {
        body: `Copied artifact ${artifact.title}.`,
        role: "agent"
      }
    ]);
  }

  function downloadArtifact(artifact: TaskArtifact) {
    const url = URL.createObjectURL(new Blob([artifact.content], { type: artifact.mimeType }));
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = artifactFileName(artifact);
    document.body.append(anchor);
    anchor.click();
    anchor.remove();
    URL.revokeObjectURL(url);
  }

  async function deleteArtifactRecord(artifact: TaskArtifact) {
    setBusy(true);
    try {
      const response = await deleteTaskArtifact(artifact.taskId, artifact.id);
      setSelectedArtifacts((current) => current.filter((candidate) => candidate.id !== response.artifactId));
      await refreshHistory();
      setMessages((current) => [
        ...current,
        {
          body: `Deleted artifact ${response.artifactId.slice(0, 8)}.`,
          role: "agent"
        }
      ]);
    } catch (error) {
      setMessages((current) => [
        ...current,
        {
          body: error instanceof Error ? error.message : "Failed to delete artifact.",
          role: "agent"
        }
      ]);
    } finally {
      setBusy(false);
    }
  }

  async function resumeTask(taskIdToResume: string) {
    setBusy(true);
    try {
      const task = await fetchTask(taskIdToResume);
      const safePendingCount = safeRunnableSteps(task.plan).length;
      setTaskId(task.taskId);
      setSelectedTaskId(task.taskId);
      setPlan(task.plan);
      setTasks((current) => upsertTask(current, task));
      setView("chat");
      setMessages((current) => [
        ...current,
        {
          body: `Loaded task ${task.taskId.slice(0, 8)} with ${safePendingCount} safe pending steps.`,
          role: "agent"
        }
      ]);
      await runSafeStepsFromPlan(task.plan, task.taskId);
    } catch (error) {
      setMessages((current) => [
        ...current,
        {
          body: error instanceof Error ? error.message : "Failed to resume task.",
          role: "agent"
        }
      ]);
    } finally {
      setBusy(false);
    }
  }

  async function requestMemory() {
    const content = memoryContent.trim();
    if (!content || busy) {
      return;
    }

    setBusy(true);
    try {
      const tags = memoryTags.split(",").map((tag) => tag.trim()).filter(Boolean);
      const response = await requestMemoryWrite(content, tags);
      setPendingMemory(response.pending);
      setMessages((current) => [
        ...current,
        {
          body: "Memory write is pending confirmation.",
          role: "agent"
        }
      ]);
    } catch (error) {
      setMessages((current) => [
        ...current,
        {
          body: error instanceof Error ? error.message : "Failed to request memory write.",
          role: "agent"
        }
      ]);
    } finally {
      setBusy(false);
    }
  }

  async function confirmMemory() {
    if (!pendingMemory || busy) {
      return;
    }

    setBusy(true);
    try {
      await confirmMemoryWrite(pendingMemory.token);
      setPendingMemory(undefined);
      setMemoryContent("");
      setMemoryTags("");
      await refreshMemories();
      setMessages((current) => [
        ...current,
        {
          body: "Memory saved locally.",
          role: "agent"
        }
      ]);
    } catch (error) {
      setMessages((current) => [
        ...current,
        {
          body: error instanceof Error ? error.message : "Failed to confirm memory write.",
          role: "agent"
        }
      ]);
    } finally {
      setBusy(false);
    }
  }

  async function deleteMemoryRecord(memoryId: string) {
    setBusy(true);
    try {
      const response = await deleteMemory(memoryId);
      await refreshMemories();
      await refreshHistory();
      setMessages((current) => [
        ...current,
        {
          body: `Deleted local memory ${response.memoryId.slice(0, 8)}.`,
          role: "agent"
        }
      ]);
    } catch (error) {
      setMessages((current) => [
        ...current,
        {
          body: error instanceof Error ? error.message : "Failed to delete memory.",
          role: "agent"
        }
      ]);
    } finally {
      setBusy(false);
    }
  }

  return (
    <main className="shell">
      <header className="topbar">
        <div className="brand">
          <Bot size={18} />
          <span>Open Agent</span>
        </div>
        <div className="agent-status" data-state={agentStatus} title={agentStatusMessage}>
          <span aria-hidden="true" className="status-dot" />
          <span className="agent-status-label">{agentStatusLabel}</span>
          <button
            aria-label="Refresh agent status"
            className="status-refresh"
            disabled={agentStatus === "checking"}
            onClick={() => void refreshAgentHealth()}
            type="button"
          >
            <RefreshCw size={13} />
          </button>
        </div>
        <div className="event-status" data-state={realtimeStatus} title={realtimeStatusMessage}>
          <span aria-hidden="true" className="status-dot" />
          <span>{realtimeStatus === "connected" ? "Live" : realtimeStatus === "connecting" ? "Sync" : "No live"}</span>
        </div>
      </header>

      <nav className="tabs" aria-label="Views">
        <button className={view === "chat" ? "active" : ""} onClick={() => void switchView("chat")} type="button">
          <Bot size={15} />
          Chat
        </button>
        <button className={view === "history" ? "active" : ""} onClick={() => void switchView("history")} type="button">
          <History size={15} />
          History
        </button>
        <button className={view === "audit" ? "active" : ""} onClick={() => void switchView("audit")} type="button">
          <ScrollText size={15} />
          Audit
        </button>
        <button className={view === "memory" ? "active" : ""} onClick={() => void switchView("memory")} type="button">
          <Brain size={15} />
          Memory
        </button>
      </nav>

      {view === "chat" && (
        <>
          <section className="messages" aria-label="Conversation">
            {messages.map((message, index) => (
              <div className={`message ${message.role}`} key={`${message.role}-${index}`}>
                {message.body}
              </div>
            ))}
          </section>

          {approvals.length > 0 && (
            <section className="approvals" aria-label="Approvals">
              <div className="section-title">
                <ShieldAlert size={16} />
                <span>Review required</span>
              </div>
              {approvals.map((request) => (
                <article className="approval" key={request.id}>
                  <div className="approval-heading">
                    <strong>{summarizeToolCallForApproval(request.toolCall).title}</strong>
                    <span className={`risk-badge ${request.risk}`}>{request.risk} risk</span>
                  </div>
                  <p>{request.reason}</p>
                  <small className="approval-expiry">{formatApprovalExpiry(request.expiresAt)}</small>
                  <dl className="approval-details">
                    {summarizeToolCallForApproval(request.toolCall).details.map((detail) => (
                      <div key={detail.label}>
                        <dt>{detail.label}</dt>
                        <dd>{detail.value}</dd>
                      </div>
                    ))}
                  </dl>
                  <button className="primary" disabled={busy} onClick={() => void approve(request)} type="button">
                    <Check size={15} />
                    Approve
                  </button>
                  <button className="secondary danger" disabled={busy} onClick={() => void reject(request)} type="button">
                    <X size={15} />
                    Reject
                  </button>
                </article>
              ))}
            </section>
          )}

          {plan.length > 0 && (
            <section className="plan" aria-label="Plan">
              <div className="section-title">
                <ClipboardList size={16} />
                <span>Plan</span>
                {runnableSteps.length > 0 && (
                  <button className="compact-action" disabled={busy} onClick={() => void runRunnableSteps()} type="button">
                    <Play size={14} />
                    Run
                  </button>
                )}
                {canCancelCurrentTask && taskId && (
                  <button className="compact-action danger" disabled={busy} onClick={() => void cancelTaskRun(taskId, "Canceled from side panel plan.")} type="button">
                    <X size={14} />
                    Stop
                  </button>
                )}
              </div>
              {plan.map((step) => (
                <button
                  className="plan-step"
                  disabled={busy || !step.toolCall || step.status === "blocked"}
                  key={step.id}
                  onClick={() => void runStep(step)}
                  type="button"
                >
                  <span>{step.description}</span>
                  <small>{step.status}</small>
                </button>
              ))}
            </section>
          )}

          <form
            className="composer"
            onSubmit={(event) => {
              event.preventDefault();
              void submit();
            }}
          >
            <fieldset className="context-policy" aria-label="Context sent to local agent">
              <button
                className={contextPolicy === "visible-text" ? "active" : ""}
                onClick={() => setContextPolicy("visible-text")}
                title="Send visible page text only"
                type="button"
              >
                <FileText size={14} />
                Text
              </button>
              <button
                className={contextPolicy === "interactive-elements" ? "active" : ""}
                onClick={() => setContextPolicy("interactive-elements")}
                title="Send text, links, and sanitized interactive elements"
                type="button"
              >
                <MousePointerClick size={14} />
                Interactive
              </button>
              <button
                className={contextPolicy === "full-snapshot" ? "active" : ""}
                onClick={() => setContextPolicy("full-snapshot")}
                title="Send the largest sanitized snapshot"
                type="button"
              >
                <Layers size={14} />
                Full
              </button>
              <button
                aria-label="Clear local page context"
                className="context-clear"
                disabled={busy}
                onClick={() => void clearPageContext()}
                title="Clear the latest saved page snapshot for this tab"
                type="button"
              >
                <Trash2 size={14} />
                Clear page context
              </button>
            </fieldset>
            <textarea
              aria-label="Task"
              onChange={(event) => setInput(event.target.value)}
              placeholder="Ask the local agent to inspect or act on this page..."
              value={input}
            />
            <button aria-label="Send task" className="send" disabled={!canSend} type="submit">
              <Send size={17} />
            </button>
          </form>
        </>
      )}

      {view === "history" && (
        <section className="history-list" aria-label="Task history">
          <div className="history-toolbar">
            <div>
              <strong>Task history</strong>
              <small>{tasks.length} total · {activeTaskCount} active</small>
            </div>
            <button className="text-action danger" disabled={busy || activeTaskCount === 0} onClick={() => void cancelAllTaskRuns()} type="button">
              <X size={14} />
              Stop active
            </button>
          </div>
          {tasks.map((task) => (
            <article className={`history-item ${selectedTaskId === task.taskId ? "selected" : ""}`} key={task.taskId}>
              <div className="history-row">
                <strong>{task.status}</strong>
                <time>{new Date(task.updatedAt).toLocaleString()}</time>
              </div>
              <p>{task.message}</p>
              <div className="history-actions">
                <small>{task.taskId.slice(0, 8)} · {task.plan.length} steps · {task.results.length} results</small>
                <button className="text-action" disabled={busy} onClick={() => void openTask(task.taskId)} type="button">
                  <Eye size={14} />
                  Details
                </button>
                {safeRunnableSteps(task.plan).length > 0 && (
                  <button className="text-action" disabled={busy} onClick={() => void resumeTask(task.taskId)} type="button">
                    <Play size={14} />
                    Resume
                  </button>
                )}
                {isCancelableTask(task) && (
                  <button className="text-action danger" disabled={busy} onClick={() => void cancelTaskRun(task.taskId, "Canceled from task history.")} type="button">
                    <X size={14} />
                    Cancel
                  </button>
                )}
                <button className="text-action danger" disabled={busy} onClick={() => void deleteTaskRun(task.taskId)} type="button">
                  <Trash2 size={14} />
                  Delete
                </button>
              </div>
            </article>
          ))}
          {selectedTask && (
            <article className="task-detail">
              <div className="history-row">
                <strong>Task detail</strong>
                <small>{selectedTask.taskId}</small>
              </div>
              <div className="detail-grid">
                {selectedTask.plan.map((step) => (
                  <div className="detail-row" key={step.id}>
                    <span>{step.description}</span>
                    <small>{step.status}</small>
                  </div>
                ))}
              </div>
              {selectedTask.output && (
                <pre>{selectedTask.output.slice(0, 1200)}</pre>
              )}
              {selectedArtifacts.length > 0 && (
                <section className="artifact-list" aria-label="Task artifacts">
                  <div className="section-title">
                    <FileText size={15} />
                    <span>Artifacts</span>
                  </div>
                  {selectedArtifacts.map((artifact) => (
                    <article className="artifact-card" key={artifact.id}>
                      <div className="history-row">
                        <strong>{artifact.title}</strong>
                        <small>{artifact.kind}</small>
                      </div>
                      <div className="artifact-meta">
                        <span>{artifact.mimeType}</span>
                        <span>{formatArtifactSize(artifact.byteLength)}</span>
                      </div>
                      <pre className="artifact-preview">{artifact.content.slice(0, 1000)}</pre>
                      <div className="history-actions">
                        <small>{artifact.id.slice(0, 8)}</small>
                        <button className="text-action" disabled={busy} onClick={() => void copyArtifact(artifact)} type="button">
                          <Copy size={14} />
                          Copy
                        </button>
                        <button className="text-action" disabled={busy} onClick={() => downloadArtifact(artifact)} type="button">
                          <Download size={14} />
                          Download
                        </button>
                        <button className="text-action danger" disabled={busy} onClick={() => void deleteArtifactRecord(artifact)} type="button">
                          <Trash2 size={14} />
                          Delete
                        </button>
                      </div>
                    </article>
                  ))}
                </section>
              )}
              {selectedTask.results.length > 0 && (
                <details>
                  <summary>{selectedTask.results.length} tool results</summary>
                  <pre>{JSON.stringify(selectedTask.results, null, 2).slice(0, 1600)}</pre>
                </details>
              )}
            </article>
          )}
          {tasks.length === 0 && <p className="empty-state">No tasks recorded yet.</p>}
        </section>
      )}

      {view === "audit" && (
        <section className="history-list" aria-label="Audit events">
          {auditEvents.slice(0, 50).map((event) => (
            <article className="history-item" key={event.id}>
              <div className="history-row">
                <strong>{event.type}</strong>
                <time>{new Date(event.createdAt).toLocaleString()}</time>
              </div>
              <pre>{JSON.stringify(event.payload, null, 2).slice(0, 700)}</pre>
            </article>
          ))}
          {auditEvents.length === 0 && <p className="empty-state">No audit events recorded yet.</p>}
        </section>
      )}

      {view === "memory" && (
        <section className="memory-view" aria-label="Memory">
          <form
            className="memory-form"
            onSubmit={(event) => {
              event.preventDefault();
              void requestMemory();
            }}
          >
            <label>
              Memory
              <textarea
                onChange={(event) => setMemoryContent(event.target.value)}
                placeholder="Store a local preference or project note..."
                value={memoryContent}
              />
            </label>
            <label>
              Tags
              <input
                onChange={(event) => setMemoryTags(event.target.value)}
                placeholder="preference, project"
                value={memoryTags}
              />
            </label>
            <button className="primary" disabled={busy || memoryContent.trim().length === 0} type="submit">
              <Plus size={15} />
              Request save
            </button>
          </form>

          {pendingMemory && (
            <article className="approval">
              <strong>Confirm memory write</strong>
              <p>{pendingMemory.content}</p>
              {pendingMemory.tags.length > 0 && <small>{pendingMemory.tags.join(", ")}</small>}
              <button className="primary" disabled={busy} onClick={() => void confirmMemory()} type="button">
                <Check size={15} />
                Save locally
              </button>
            </article>
          )}

          <div className="memory-list">
            {memories.map((memory) => (
              <article className="history-item" key={memory.id}>
                <div className="history-row">
                  <strong>{memory.tags.join(", ") || "memory"}</strong>
                  <time>{new Date(memory.createdAt).toLocaleString()}</time>
                </div>
                <p>{memory.content}</p>
                <div className="history-actions">
                  <small>{memory.id.slice(0, 8)}</small>
                  <button className="text-action danger" disabled={busy} onClick={() => void deleteMemoryRecord(memory.id)} type="button">
                    <Trash2 size={14} />
                    Delete
                  </button>
                </div>
              </article>
            ))}
            {memories.length === 0 && <p className="empty-state">No memories saved yet.</p>}
          </div>
        </section>
      )}
    </main>
  );
}

function formatAgentStatusLabel(status: AgentStatus, health?: HealthResponse): string {
  if (status === "checking") {
    return "Checking";
  }

  if (status === "offline" || !health) {
    return "Offline";
  }

  return `${formatProviderLabel(health.provider)} - ${formatProviderSource(health.providerSource)}`;
}

function formatProviderSource(source: HealthResponse["providerSource"]): string {
  if (source === "environment") {
    return "env";
  }

  return source;
}

function formatProviderLabel(provider: HealthResponse["provider"]): string {
  if (provider.type === "disabled") {
    return "Local mode";
  }

  if (provider.type === "ollama") {
    return `Ollama ${provider.model}`;
  }

  return `API ${provider.model}`;
}

function upsertAuditEvent(events: AuditEvent[], event: AuditEvent): AuditEvent[] {
  if (events.some((candidate) => candidate.id === event.id)) {
    return events;
  }

  return [...events, event].sort((left, right) => left.createdAt.localeCompare(right.createdAt));
}

function upsertTask(tasks: TaskRun[], task: TaskRun): TaskRun[] {
  const next = tasks.filter((candidate) => candidate.taskId !== task.taskId);
  next.push(task);
  return next.sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
}

function mergeApprovals(
  current: HumanApprovalRequest[],
  incoming: HumanApprovalRequest[]
): HumanApprovalRequest[] {
  const existingIds = new Set(current.map((approval) => approval.id));
  return [
    ...current,
    ...incoming.filter((approval) => !existingIds.has(approval.id))
  ];
}

function formatApprovalExpiry(expiresAt: string): string {
  const expiry = new Date(expiresAt);
  if (Number.isNaN(expiry.getTime())) {
    return "Approval expires soon.";
  }

  return `Expires ${expiry.toLocaleTimeString()}`;
}

function formatArtifactSize(byteLength: number): string {
  if (byteLength < 1024) {
    return `${byteLength} B`;
  }

  return `${(byteLength / 1024).toFixed(1)} KB`;
}

function artifactFileName(artifact: TaskArtifact): string {
  const extension = artifact.mimeType === "application/json" ? "json" : "txt";
  const safeTitle = artifact.title.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
  return `${safeTitle || "artifact"}-${artifact.id.slice(0, 8)}.${extension}`;
}

function readTargetTabId(): number | undefined {
  const raw = new URLSearchParams(window.location.search).get("tabId");
  if (!raw) {
    return undefined;
  }

  const parsed = Number(raw);
  return Number.isInteger(parsed) && parsed >= 0 ? parsed : undefined;
}

function errorMessage(error: unknown, fallback: string): string {
  return error instanceof Error && error.message ? error.message : fallback;
}
