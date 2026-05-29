import {
  createDepotToolsBootstrapPlan,
  findWorkspaceRoot,
  formatDepotToolsBootstrapPlan,
  runDepotToolsBootstrap
} from "./index.js";

const root = findWorkspaceRoot();
const plan = createDepotToolsBootstrapPlan({
  rootDirectory: root
});
const dryRun = process.argv.includes("--dry-run") || process.env.OAB_CHROMIUM_DRY_RUN === "1";

console.log(formatDepotToolsBootstrapPlan(plan));

if (dryRun) {
  console.log("Dry run only; depot_tools was not cloned or updated.");
} else {
  runDepotToolsBootstrap(plan);
}
