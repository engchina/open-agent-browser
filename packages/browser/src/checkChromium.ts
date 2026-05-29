import { existsSync } from "node:fs";
import { resolve } from "node:path";
import {
  checkChromiumWorkspaceReadiness,
  checkChromiumWorkspaceProvenance,
  createChromiumBuildPlan,
  createChromiumWorkspacePlan,
  createPatchApplicationPlan,
  findWorkspaceRoot,
  formatChromiumBuildPlan,
  formatChromiumWorkspacePlan,
  formatChromiumWorkspaceProvenance,
  formatChromiumWorkspaceReadiness,
  formatPatchApplicationPlan,
  loadChromiumPatchManifest
} from "./index.js";

const root = findWorkspaceRoot();
const plan = createChromiumWorkspacePlan(process.env.OAB_CHROMIUM_ROOT);
console.log(formatChromiumWorkspacePlan(plan));
console.log("");
console.log(formatChromiumWorkspaceReadiness(checkChromiumWorkspaceReadiness({ rootDirectory: root })));
console.log("");
const provenance = checkChromiumWorkspaceProvenance({ rootDirectory: root });
console.log(formatChromiumWorkspaceProvenance(provenance));
console.log("");
if (provenance.violations.length > 0) {
  process.exit(1);
}
console.log(formatPatchApplicationPlan(createPatchApplicationPlan(loadChromiumPatchManifest(resolve(root, plan.patchManifestPath)), {
  rootDirectory: root
})));
console.log("");
console.log(formatChromiumBuildPlan(createChromiumBuildPlan({ rootDirectory: root })));

if (!existsSync(resolve(root, plan.checkoutDirectory))) {
  console.log("Chromium checkout is not present yet. Run configure:chromium, bootstrap:depot-tools, then sync:chromium.");
  process.exit(0);
}

console.log("Chromium checkout directory exists.");
