import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import {
  createChromiumWorkspacePlan,
  createPatchApplicationPlan,
  findWorkspaceRoot,
  formatPatchApplicationPlan,
  formatPatchManifestValidation,
  loadChromiumPatchManifest,
  validateChromiumPatchManifest
} from "./index.js";

const root = findWorkspaceRoot();
const workspacePlan = createChromiumWorkspacePlan(process.env.OAB_CHROMIUM_ROOT);
const manifest = loadChromiumPatchManifest(resolve(root, workspacePlan.patchManifestPath));
const validation = validateChromiumPatchManifest(manifest, {
  managedPatchDirectory: workspacePlan.managedPatchDirectory,
  rootDirectory: root
});

console.log(formatPatchManifestValidation(validation));
if (validation.violations.length > 0) {
  process.exit(1);
}

const plan = createPatchApplicationPlan(manifest, { rootDirectory: root });
console.log(formatPatchApplicationPlan(plan));

if (plan.steps.length === 0) {
  console.log("No active Chromium patches to check or apply.");
  process.exit(0);
}

if (!existsSync(plan.checkoutDirectory)) {
  console.error(`Chromium checkout is missing: ${plan.checkoutDirectory}`);
  process.exit(1);
}

const shouldApply = process.argv.includes("--apply");

for (const step of plan.steps) {
  runCommand(step.checkCommand.command, step.checkCommand.args, step.checkCommand.cwd);

  if (shouldApply) {
    runCommand(step.applyCommand.command, step.applyCommand.args, step.applyCommand.cwd);
  }
}

console.log(shouldApply ? "Active Chromium patches applied." : "Active Chromium patches apply cleanly.");

function runCommand(command: string, args: string[], cwd: string): void {
  const result = spawnSync(command, args, {
    cwd,
    stdio: "inherit"
  });

  if (result.status !== 0) {
    process.exit(result.status ?? 1);
  }
}
