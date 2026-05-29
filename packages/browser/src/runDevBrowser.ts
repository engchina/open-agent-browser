import { spawn, type ChildProcess } from "node:child_process";
import {
  assertLaunchInputs,
  createDevBrowserLaunchPlan,
  findWorkspaceRoot,
  launchDevBrowser,
  writeDevBrowserRuntimeConfig
} from "./index.js";

const rootDirectory = findWorkspaceRoot();
const plan = createDevBrowserLaunchPlan({ rootDirectory });

if (process.env.OAB_BROWSER_DRY_RUN === "1") {
  console.log(JSON.stringify({ dryRun: true, plan }, null, 2));
  process.exit(0);
}

assertLaunchInputs(plan);
writeDevBrowserRuntimeConfig(plan);
const agentProcess = await ensureAgent(plan.agentUrl, rootDirectory);
const browserProcess = launchDevBrowser(plan);

console.log(`Open Agent Browser launched with profile ${plan.profileDirectory}`);
console.log(`Agent server: ${plan.agentUrl}`);

const shutdown = () => {
  browserProcess.kill();
  agentProcess?.kill();
};

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
browserProcess.on("exit", () => {
  agentProcess?.kill();
});

async function ensureAgent(agentUrl: string, cwd: string): Promise<ChildProcess | undefined> {
  if (await isHealthy(agentUrl)) {
    return undefined;
  }

  const agentCommand = createAgentDevCommand();
  const child = spawn(agentCommand.command, agentCommand.args, {
    cwd,
    env: process.env,
    stdio: "inherit"
  });

  const ready = await waitForHealth(agentUrl, 20000);
  if (!ready) {
    child.kill();
    throw new Error(`Agent server did not become healthy at ${agentUrl}`);
  }

  return child;
}

async function waitForHealth(agentUrl: string, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    if (await isHealthy(agentUrl)) {
      return true;
    }
    await new Promise((resolve) => setTimeout(resolve, 400));
  }

  return false;
}

function createAgentDevCommand(): { args: string[]; command: string } {
  if (process.platform === "win32") {
    return {
      args: ["/d", "/s", "/c", "pnpm.cmd --filter @open-agent-browser/agent-server dev"],
      command: process.env.ComSpec ?? "cmd.exe"
    };
  }

  return {
    args: ["--filter", "@open-agent-browser/agent-server", "dev"],
    command: "pnpm"
  };
}

async function isHealthy(agentUrl: string): Promise<boolean> {
  try {
    const response = await fetch(`${agentUrl}/health`);
    return response.ok;
  } catch {
    return false;
  }
}
