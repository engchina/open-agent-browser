import { mkdirSync } from "node:fs";
import { resolve } from "node:path";
import { createChromiumWorkspacePlan, findWorkspaceRoot, formatChromiumWorkspacePlan } from "./index.js";

const root = findWorkspaceRoot();
const plan = createChromiumWorkspacePlan(process.env.OAB_CHROMIUM_ROOT);
mkdirSync(resolve(root, plan.managedPatchDirectory), { recursive: true });

console.log(formatChromiumWorkspacePlan(plan));
console.log("Created owned patch directory. Patch metadata is tracked through the manifest.");
console.log("Chromium source checkout remains external to this repository.");
