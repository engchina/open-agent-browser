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
import { resolve } from "node:path";

const root = findWorkspaceRoot();
const workspacePlan = createChromiumWorkspacePlan(process.env.OAB_CHROMIUM_ROOT);
const manifest = loadChromiumPatchManifest(resolve(root, workspacePlan.patchManifestPath));

console.log(formatChromiumWorkspacePlan(workspacePlan));
console.log("");
console.log(formatChromiumWorkspaceReadiness(checkChromiumWorkspaceReadiness({ rootDirectory: root })));
console.log("");
console.log(formatChromiumWorkspaceProvenance(checkChromiumWorkspaceProvenance({ rootDirectory: root })));
console.log("");
console.log(formatPatchApplicationPlan(createPatchApplicationPlan(manifest, { rootDirectory: root })));
console.log("");
console.log(formatChromiumBuildPlan(createChromiumBuildPlan({ rootDirectory: root })));
