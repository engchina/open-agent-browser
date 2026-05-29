import {
  createChromiumGClientConfigPlan,
  findWorkspaceRoot,
  formatChromiumGClientConfigPlan,
  writeChromiumGClientConfig
} from "./index.js";

const root = findWorkspaceRoot();
const plan = createChromiumGClientConfigPlan({ rootDirectory: root });
const overwrite = process.argv.includes("--force");

writeChromiumGClientConfig(plan, { overwrite });

console.log(formatChromiumGClientConfigPlan(plan));
console.log(overwrite ? "Chromium .gclient config written with --force." : "Chromium .gclient config written.");
console.log("Next step: run bootstrap:depot-tools, then sync:chromium.");
