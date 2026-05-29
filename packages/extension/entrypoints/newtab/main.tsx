import { Bot, PanelRightOpen, RefreshCw, Send, Settings, ShieldCheck } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { createRoot } from "react-dom/client";
import type { HealthResponse } from "@open-agent-browser/shared";
import { getAgentBaseUrl, getHealth } from "../../lib/apiClient.js";
import { saveLaunchDraft } from "../../lib/launchDraft.js";
import "./style.css";

type AgentState = "checking" | "connected" | "offline";

function NewTab() {
  const [agentUrl, setAgentUrl] = useState("");
  const [health, setHealth] = useState<HealthResponse>();
  const [state, setState] = useState<AgentState>("checking");
  const [message, setMessage] = useState("Checking local agent.");
  const [taskDraft, setTaskDraft] = useState("");
  const [opening, setOpening] = useState(false);
  const canStartTask = useMemo(() => taskDraft.trim().length > 0 && !opening, [opening, taskDraft]);

  const providerLabel = useMemo(() => {
    if (!health) {
      return "Unknown";
    }
    if (health.provider.type === "openai-compatible") {
      return "OpenAI-compatible";
    }
    if (health.provider.type === "ollama") {
      return "Ollama";
    }
    return "Disabled";
  }, [health]);

  useEffect(() => {
    void refreshStatus();
  }, []);

  async function refreshStatus(): Promise<void> {
    setState("checking");
    setMessage("Checking local agent.");
    const baseUrl = await getAgentBaseUrl();
    setAgentUrl(baseUrl);

    try {
      const response = await getHealth();
      setHealth(response);
      setState("connected");
      setMessage("Local agent connected.");
    } catch (error) {
      setHealth(undefined);
      setState("offline");
      setMessage(error instanceof Error ? error.message : "Local agent unavailable.");
    }
  }

  async function openSidePanel(): Promise<void> {
    setOpening(true);
    try {
      const tab = await chrome.tabs.getCurrent();
      if (typeof tab?.id === "number") {
        await chrome.sidePanel.open({ tabId: tab.id });
      } else {
        await chrome.sidePanel.open({ windowId: chrome.windows.WINDOW_ID_CURRENT });
      }
      setMessage("Side panel requested.");
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Unable to open side panel.");
    } finally {
      setOpening(false);
    }
  }

  async function startDraftTask(): Promise<void> {
    if (!canStartTask) {
      return;
    }

    await saveLaunchDraft(taskDraft);
    setTaskDraft("");
    await openSidePanel();
  }

  return (
    <main className="newtab-shell">
      <section className="overview" aria-labelledby="page-title">
        <div className="brand-mark" aria-hidden="true">
          <Bot size={28} strokeWidth={1.8} />
        </div>
        <div>
          <h1 id="page-title">Open Agent Browser</h1>
          <p>Local-first agentic browsing with human approval.</p>
        </div>
      </section>

      <section className="workspace" aria-label="Agent workspace">
        <div className="status-band" data-state={state}>
          <div className="status-title">
            <ShieldCheck size={20} strokeWidth={1.8} />
            <span>{statusLabel(state)}</span>
          </div>
          <p>{message}</p>
        </div>

        <dl className="status-grid">
          <div>
            <dt>Provider</dt>
            <dd>{providerLabel}</dd>
          </div>
          <div>
            <dt>Source</dt>
            <dd>{health?.providerSource ?? "Unknown"}</dd>
          </div>
          <div>
            <dt>Endpoint</dt>
            <dd>{agentUrl || "Unknown"}</dd>
          </div>
        </dl>

        <form
          className="launch-form"
          onSubmit={(event) => {
            event.preventDefault();
            void startDraftTask();
          }}
        >
          <label htmlFor="launch-task">Task</label>
          <div className="launch-input-row">
            <textarea
              id="launch-task"
              onChange={(event) => setTaskDraft(event.target.value)}
              placeholder="Open a URL, summarize a page, or extract links..."
              value={taskDraft}
            />
            <button className="primary" disabled={!canStartTask} type="submit">
              <Send size={18} strokeWidth={1.8} />
              <span>Start</span>
            </button>
          </div>
        </form>

        <div className="actions" aria-label="Actions">
          <button className="primary" disabled={opening} onClick={() => void openSidePanel()} type="button">
            <PanelRightOpen size={18} strokeWidth={1.8} />
            <span>{opening ? "Opening" : "Open Side Panel"}</span>
          </button>
          <button onClick={() => void chrome.runtime.openOptionsPage()} type="button">
            <Settings size={18} strokeWidth={1.8} />
            <span>Options</span>
          </button>
          <button onClick={() => void refreshStatus()} type="button">
            <RefreshCw size={18} strokeWidth={1.8} />
            <span>Refresh</span>
          </button>
        </div>
      </section>
    </main>
  );
}

function statusLabel(state: AgentState): string {
  switch (state) {
    case "checking":
      return "Checking";
    case "connected":
      return "Connected";
    case "offline":
      return "Offline";
  }
}

createRoot(document.getElementById("root")!).render(<NewTab />);
