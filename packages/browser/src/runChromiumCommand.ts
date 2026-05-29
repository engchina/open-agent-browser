import {
  type ChromiumBuildCommandName,
  createChromiumCommandRunPlan,
  findWorkspaceRoot,
  formatChromiumCommandRunPlan,
  runChromiumCommand
} from "./index.js";

const commandName = parseCommandName(process.argv[2]);
const root = findWorkspaceRoot();
const plan = createChromiumCommandRunPlan(commandName, {
  rootDirectory: root
});
const dryRun = process.argv.includes("--dry-run") || process.env.OAB_CHROMIUM_DRY_RUN === "1";

console.log(formatChromiumCommandRunPlan(plan));

if (dryRun) {
  console.log("Dry run only; no Chromium command was executed.");
} else {
  runChromiumCommand(plan);
}

function parseCommandName(value: string | undefined): ChromiumBuildCommandName {
  if (value === "sync" || value === "generate" || value === "build") {
    return value;
  }

  throw new Error("Expected Chromium command name: sync, generate, or build.");
}
