import React, { useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import type { ProviderConfig, ProviderConfigResponse } from "@open-agent-browser/shared";
import { getProviderConfig, testProviderConfig, updateProviderConfig } from "../../lib/apiClient.js";
import "./style.css";

function OptionsApp() {
  const [agentBaseUrl, setAgentBaseUrl] = useState("http://127.0.0.1:17376");
  const [apiKey, setApiKey] = useState("");
  const [baseUrl, setBaseUrl] = useState("http://127.0.0.1:11434");
  const [model, setModel] = useState("llama3.2");
  const [providerSource, setProviderSource] = useState<ProviderConfigResponse["source"]>("default");
  const [providerType, setProviderType] = useState<ProviderConfig["type"]>("disabled");
  const [saved, setSaved] = useState(false);
  const [status, setStatus] = useState("");
  const [testStatus, setTestStatus] = useState("");

  useEffect(() => {
    chrome.storage.local.get("agentBaseUrl").then((stored) => {
      if (typeof stored.agentBaseUrl === "string") {
        setAgentBaseUrl(stored.agentBaseUrl);
      }
    }).catch(() => {});
  }, []);

  useEffect(() => {
    getProviderConfig().then((response) => {
      applyProviderResponse(response);
    }).catch((error) => {
      setStatus(error instanceof Error ? error.message : "Unable to load provider config.");
    });
  }, []);

  async function save() {
    setStatus("");
    setTestStatus("");
    try {
      await chrome.storage.local.set({ agentBaseUrl });
      const config = buildProviderConfig();
      const response = await updateProviderConfig(config);
      applyProviderResponse(response);
      setSaved(true);
      window.setTimeout(() => setSaved(false), 1600);
    } catch (error) {
      setStatus(error instanceof Error ? error.message : "Unable to save settings.");
    }
  }

  async function test() {
    setStatus("");
    setTestStatus("Testing provider...");
    try {
      await chrome.storage.local.set({ agentBaseUrl });
      const result = await testProviderConfig(buildProviderConfig());
      setTestStatus(`${result.ok ? "OK" : "Failed"}: ${result.message}`);
    } catch (error) {
      setTestStatus("");
      setStatus(error instanceof Error ? error.message : "Unable to test provider.");
    }
  }

  function applyProviderResponse(response: ProviderConfigResponse) {
    setProviderSource(response.source);
    setProviderType(response.config.type);
    if (response.config.type === "ollama") {
      setBaseUrl(response.config.baseUrl);
      setModel(response.config.model);
      setApiKey("");
    } else if (response.config.type === "openai-compatible") {
      setBaseUrl(response.config.baseUrl);
      setModel(response.config.model);
      setApiKey("");
    }
  }

  function buildProviderConfig(): ProviderConfig {
    if (providerType === "disabled") {
      return { type: "disabled" };
    }

    if (providerType === "ollama") {
      return {
        baseUrl,
        model,
        type: "ollama"
      };
    }

    return {
      apiKey,
      baseUrl,
      model,
      type: "openai-compatible"
    };
  }

  return (
    <main className="settings">
      <h1>Settings</h1>
      <section>
        <h2>Agent</h2>
        <label>
          Agent server URL
          <input onChange={(event) => setAgentBaseUrl(event.target.value)} value={agentBaseUrl} />
        </label>
      </section>

      <section>
        <h2>Provider</h2>
        <label>
          Provider mode
          <select onChange={(event) => setProviderType(event.target.value as ProviderConfig["type"])} value={providerType}>
            <option value="disabled">Disabled</option>
            <option value="ollama">Ollama</option>
            <option value="openai-compatible">OpenAI-compatible</option>
          </select>
        </label>

        {providerType !== "disabled" && (
          <>
            <label>
              Base URL
              <input onChange={(event) => setBaseUrl(event.target.value)} value={baseUrl} />
            </label>
            <label>
              Model
              <input onChange={(event) => setModel(event.target.value)} value={model} />
            </label>
          </>
        )}

        {providerType === "openai-compatible" && (
          <label>
            API key
            <input
              onChange={(event) => setApiKey(event.target.value)}
              placeholder="Required when saving OpenAI-compatible mode"
              type="password"
              value={apiKey}
            />
          </label>
        )}

        <p className="meta">Current source: {providerSource}</p>
      </section>

      <div className="actions">
        <button onClick={() => void save()} type="button">Save</button>
        <button className="secondary" onClick={() => void test()} type="button">Test provider</button>
      </div>
      {saved && <p>Saved.</p>}
      {testStatus && <p className={testStatus.startsWith("OK") ? "success" : "error"}>{testStatus}</p>}
      {status && <p className="error">{status}</p>}
    </main>
  );
}

createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <OptionsApp />
  </React.StrictMode>
);
