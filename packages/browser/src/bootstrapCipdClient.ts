import {
  bootstrapChromiumCipdClient,
  createChromiumCipdClientBootstrapPlan,
  findWorkspaceRoot,
  formatChromiumCipdClientBootstrapPlan
} from "./index.js";

const root = findWorkspaceRoot();
const plan = createChromiumCipdClientBootstrapPlan({
  rootDirectory: root
});
const dryRun = process.argv.includes("--dry-run") || process.env.OAB_CHROMIUM_DRY_RUN === "1";
const force = process.argv.includes("--force");

console.log(formatChromiumCipdClientBootstrapPlan(plan));

if (dryRun) {
  console.log("Dry run only; CIPD client was not downloaded.");
} else {
  const result = await bootstrapChromiumCipdClient(plan, { force });
  console.log(result.downloaded
    ? `CIPD client downloaded: ${result.binaryPath}`
    : `CIPD client already present: ${result.binaryPath}`);
  for (const executableAliasPath of result.executableAliasPaths) {
    console.log(`CIPD PATH alias ready: ${executableAliasPath}`);
  }
  console.log(`CIPD client sha256: ${result.sha256}`);
}
