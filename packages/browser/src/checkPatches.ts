import {
  createChromiumWorkspacePlan,
  findWorkspaceRoot,
  formatPatchManifestValidation,
  loadChromiumPatchManifest,
  validateChromiumPatchManifest
} from "./index.js";
import { resolve } from "node:path";

const root = findWorkspaceRoot();
const plan = createChromiumWorkspacePlan(process.env.OAB_CHROMIUM_ROOT);
const manifest = loadChromiumPatchManifest(resolve(root, plan.patchManifestPath));
const result = validateChromiumPatchManifest(manifest, {
  managedPatchDirectory: plan.managedPatchDirectory,
  rootDirectory: root
});

console.log(formatPatchManifestValidation(result));

if (result.violations.length > 0) {
  process.exit(1);
}
