import { createHash } from "node:crypto";
import { copyFileSync, existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { get } from "node:https";
import { basename, dirname, delimiter, isAbsolute, join, relative, resolve } from "node:path";
import { spawn, spawnSync, type ChildProcess, type SpawnSyncReturns } from "node:child_process";

export interface ChromiumWorkspacePlan {
  checkoutDirectory: string;
  depotToolsDirectory: string;
  managedPatchDirectory: string;
  patchManifestPath: string;
  vendoringPolicy: "external-checkout-only";
}

export function createChromiumWorkspacePlan(
  rootDirectory = "external/chromium"
): ChromiumWorkspacePlan {
  return {
    checkoutDirectory: `${rootDirectory}/src`,
    depotToolsDirectory: `${rootDirectory}/depot_tools`,
    managedPatchDirectory: "packages/browser/patches",
    patchManifestPath: "packages/browser/patches/manifest.json",
    vendoringPolicy: "external-checkout-only"
  };
}

export function formatChromiumWorkspacePlan(plan: ChromiumWorkspacePlan): string {
  return [
    "Chromium workspace plan:",
    `- depot_tools: ${plan.depotToolsDirectory}`,
    `- checkout: ${plan.checkoutDirectory}`,
    `- owned patches: ${plan.managedPatchDirectory}`,
    `- patch manifest: ${plan.patchManifestPath}`,
    `- policy: ${plan.vendoringPolicy}`
  ].join("\n");
}

export const defaultChromiumRepositoryUrl = "https://chromium.googlesource.com/chromium/src.git";
export const defaultDepotToolsRepositoryUrl = "https://chromium.googlesource.com/chromium/tools/depot_tools.git";

export interface ChromiumGClientConfigPlan {
  checkoutDirectory: string;
  chromiumRoot: string;
  configPath: string;
  content: string;
  repositoryUrl: string;
  solutionName: string;
}

export interface ChromiumGClientConfigPlanOptions {
  env?: NodeJS.ProcessEnv;
  repositoryUrl?: string;
  rootDirectory?: string;
}

export function createChromiumGClientConfigPlan(
  options: ChromiumGClientConfigPlanOptions = {}
): ChromiumGClientConfigPlan {
  const env = options.env ?? process.env;
  const rootDirectory = resolve(options.rootDirectory ?? process.cwd());
  const workspacePlan = createChromiumWorkspacePlan(env.OAB_CHROMIUM_ROOT);
  const checkoutDirectory = resolve(rootDirectory, workspacePlan.checkoutDirectory);
  const chromiumRoot = resolve(rootDirectory, dirname(workspacePlan.checkoutDirectory));
  const solutionName = basename(checkoutDirectory);
  const repositoryUrl = options.repositoryUrl ?? env.OAB_CHROMIUM_REPOSITORY_URL ?? defaultChromiumRepositoryUrl;

  return {
    checkoutDirectory,
    chromiumRoot,
    configPath: resolve(chromiumRoot, ".gclient"),
    content: formatGClientConfig(solutionName, repositoryUrl),
    repositoryUrl,
    solutionName
  };
}

export function writeChromiumGClientConfig(
  plan: ChromiumGClientConfigPlan,
  options: { overwrite?: boolean } = {}
): void {
  mkdirSync(plan.chromiumRoot, { recursive: true });

  if (!options.overwrite && existsSync(plan.configPath)) {
    throw new Error(`Refusing to overwrite existing Chromium gclient config: ${plan.configPath}`);
  }

  writeFileSync(plan.configPath, plan.content, "utf8");
}

export function formatChromiumGClientConfigPlan(plan: ChromiumGClientConfigPlan): string {
  return [
    "Chromium gclient config plan:",
    `- chromium root: ${plan.chromiumRoot}`,
    `- config: ${plan.configPath}`,
    `- solution: ${plan.solutionName}`,
    `- repository: ${plan.repositoryUrl}`,
    "- policy: writes only the external .gclient file; it does not sync Chromium source"
  ].join("\n");
}

export interface ChromiumCommandPlan {
  args: string[];
  command: string;
  cwd: string;
  label: string;
}

export type ChromiumBuildCommandName = keyof ChromiumBuildPlan["commands"];

export interface ChromiumCommandRunPlan {
  command: ChromiumCommandPlan;
  depotToolsDirectory: string;
  env: NodeJS.ProcessEnv;
  platform: NodeJS.Platform;
}

export interface DepotToolsBootstrapPlan {
  chromiumRoot: string;
  commands: {
    clone: ChromiumCommandPlan;
    update: ChromiumCommandPlan;
  };
  depotToolsDirectory: string;
  env: NodeJS.ProcessEnv;
  platform: NodeJS.Platform;
  repositoryUrl: string;
}

export interface DepotToolsBootstrapPlanOptions {
  env?: NodeJS.ProcessEnv;
  platform?: NodeJS.Platform;
  repositoryUrl?: string;
  rootDirectory?: string;
}

export interface ChromiumCipdClientBootstrapPlan {
  backendUrl: string;
  binaryPath: string;
  depotToolsDirectory: string;
  expectedSha256: string;
  executableAliasPaths: string[];
  platform: string;
  url: string;
  version: string;
}

export interface ChromiumCipdClientBootstrapPlanOptions {
  backendUrl?: string;
  env?: NodeJS.ProcessEnv;
  platform?: NodeJS.Platform;
  rootDirectory?: string;
}

export interface ChromiumCipdClientBootstrapResult {
  binaryPath: string;
  downloaded: boolean;
  executableAliasPaths: string[];
  sha256: string;
}

export interface ChromiumBuildPlan {
  buildDirectory: string;
  checkoutDirectory: string;
  commands: {
    build: ChromiumCommandPlan;
    generate: ChromiumCommandPlan;
    sync: ChromiumCommandPlan;
  };
  gnArgs: string[];
  target: "chrome";
}

export interface ChromiumBuildPlanOptions {
  arch?: string;
  env?: NodeJS.ProcessEnv;
  platform?: NodeJS.Platform;
  rootDirectory?: string;
}

export function createChromiumBuildPlan(
  options: ChromiumBuildPlanOptions = {}
): ChromiumBuildPlan {
  const env = options.env ?? process.env;
  const platform = options.platform ?? process.platform;
  const arch = options.arch ?? process.arch;
  const rootDirectory = resolve(options.rootDirectory ?? process.cwd());
  const workspacePlan = createChromiumWorkspacePlan(env.OAB_CHROMIUM_ROOT);
  const checkoutDirectory = resolve(rootDirectory, workspacePlan.checkoutDirectory);
  const chromiumRoot = resolve(rootDirectory, dirname(workspacePlan.checkoutDirectory));
  const buildDirectory = env.OAB_CHROMIUM_BUILD_DIR ?? "out/OpenAgentBrowser";
  const targetCpu = env.OAB_CHROMIUM_TARGET_CPU ?? chromiumHostCpu(platform, arch);
  const isDebug = (env.OAB_CHROMIUM_DEBUG ?? "1") !== "0";
  const gnArgs = [
    "is_component_build=true",
    `is_debug=${String(isDebug)}`,
    "symbol_level=1",
    "blink_symbol_level=0",
    `target_cpu="${targetCpu}"`
  ];
  const syncCommand: ChromiumCommandPlan = {
    args: ["sync", "--with_branch_heads", "--with_tags"],
    command: "gclient",
    cwd: chromiumRoot,
    label: "Sync external Chromium checkout"
  };

  return {
    buildDirectory,
    checkoutDirectory,
    commands: {
      build: {
        args: ["-C", buildDirectory, "chrome"],
        command: "autoninja",
        cwd: checkoutDirectory,
        label: "Build Chromium chrome target"
      },
      generate: {
        args: ["gen", buildDirectory, `--args=${gnArgs.join(" ")}`],
        command: "gn",
        cwd: checkoutDirectory,
        label: "Generate Chromium build files"
      },
      sync: {
        ...(platform === "win32"
          ? createWindowsGClientCommand(syncCommand, resolve(rootDirectory, workspacePlan.depotToolsDirectory), env)
          : syncCommand)
      }
    },
    gnArgs,
    target: "chrome"
  };
}

export function formatChromiumBuildPlan(plan: ChromiumBuildPlan): string {
  return [
    "Chromium build plan:",
    `- checkout: ${plan.checkoutDirectory}`,
    `- output: ${plan.buildDirectory}`,
    `- target: ${plan.target}`,
    "- GN args:",
    ...plan.gnArgs.map((arg) => `  - ${arg}`),
    "- Commands:",
    `  - ${formatCommandPlan(plan.commands.sync)}`,
    `  - ${formatCommandPlan(plan.commands.generate)}`,
    `  - ${formatCommandPlan(plan.commands.build)}`
  ].join("\n");
}

export function createDepotToolsBootstrapPlan(
  options: DepotToolsBootstrapPlanOptions = {}
): DepotToolsBootstrapPlan {
  const env = options.env ?? process.env;
  const rootDirectory = resolve(options.rootDirectory ?? process.cwd());
  const workspacePlan = createChromiumWorkspacePlan(env.OAB_CHROMIUM_ROOT);
  const chromiumRoot = resolve(rootDirectory, dirname(workspacePlan.checkoutDirectory));
  const depotToolsDirectory = resolve(rootDirectory, workspacePlan.depotToolsDirectory);
  const repositoryUrl = options.repositoryUrl ?? env.OAB_DEPOT_TOOLS_REPOSITORY_URL ?? defaultDepotToolsRepositoryUrl;
  const gitConfigArgs = env.OAB_GIT_SSL_BACKEND
    ? ["-c", `http.sslBackend=${env.OAB_GIT_SSL_BACKEND}`]
    : [];

  return {
    chromiumRoot,
    commands: {
      clone: {
        args: [...gitConfigArgs, "clone", repositoryUrl, depotToolsDirectory],
        command: "git",
        cwd: chromiumRoot,
        label: "Clone depot_tools into external Chromium workspace"
      },
      update: {
        args: [...gitConfigArgs, "pull", "--ff-only"],
        command: "git",
        cwd: depotToolsDirectory,
        label: "Update external depot_tools checkout"
      }
    },
    depotToolsDirectory,
    env,
    platform: options.platform ?? process.platform,
    repositoryUrl
  };
}

export function formatDepotToolsBootstrapPlan(plan: DepotToolsBootstrapPlan): string {
  return [
    "depot_tools bootstrap plan:",
    `- chromium root: ${plan.chromiumRoot}`,
    `- depot_tools: ${plan.depotToolsDirectory}`,
    `- repository: ${plan.repositoryUrl}`,
    `- clone command: ${formatCommandPlan(plan.commands.clone)}`,
    `- update command: ${formatCommandPlan(plan.commands.update)}`,
    "- policy: clones or updates only the ignored external Chromium tooling workspace"
  ].join("\n");
}

export function runDepotToolsBootstrap(
  plan: DepotToolsBootstrapPlan,
  options: { dryRun?: boolean } = {}
): SpawnSyncReturns<Buffer> | undefined {
  mkdirSync(plan.chromiumRoot, { recursive: true });

  if (options.dryRun) {
    return undefined;
  }

  const command = existsSync(plan.depotToolsDirectory)
    ? plan.commands.update
    : plan.commands.clone;

  return runDirectCommandPlan(command, plan.env);
}

export function createChromiumCipdClientBootstrapPlan(
  options: ChromiumCipdClientBootstrapPlanOptions = {}
): ChromiumCipdClientBootstrapPlan {
  const env = options.env ?? process.env;
  const rootDirectory = resolve(options.rootDirectory ?? process.cwd());
  const workspacePlan = createChromiumWorkspacePlan(env.OAB_CHROMIUM_ROOT);
  const depotToolsDirectory = resolve(rootDirectory, workspacePlan.depotToolsDirectory);
  const version = readFileSync(resolve(depotToolsDirectory, "cipd_client_version"), "utf8").trim();
  const platform = env.OAB_CIPD_PLATFORM ?? cipdHostPlatform(options.platform ?? process.platform, process.arch);
  const expectedSha256 = readCipdClientDigest(resolve(depotToolsDirectory, "cipd_client_version.digests"), platform);
  const backendUrl = options.backendUrl ?? env.OAB_CIPD_BACKEND_URL ?? "https://chrome-infra-packages.appspot.com";
  const binaryPath = resolve(depotToolsDirectory, platform.startsWith("windows-") ? ".cipd_client.exe" : ".cipd_client");
  const executableAliasPaths = platform.startsWith("windows-")
    ? [
        resolve(depotToolsDirectory, "cipd.exe"),
        resolve(depotToolsDirectory, ".cipd_bin", "cipd.exe")
      ]
    : [];

  return {
    backendUrl,
    binaryPath,
    depotToolsDirectory,
    expectedSha256,
    executableAliasPaths,
    platform,
    url: `${backendUrl}/client?platform=${encodeURIComponent(platform)}&version=${encodeURIComponent(version)}`,
    version
  };
}

export function formatChromiumCipdClientBootstrapPlan(plan: ChromiumCipdClientBootstrapPlan): string {
  return [
    "Chromium CIPD client bootstrap plan:",
    `- depot_tools: ${plan.depotToolsDirectory}`,
    `- platform: ${plan.platform}`,
    `- version: ${plan.version}`,
    `- binary: ${plan.binaryPath}`,
    ...plan.executableAliasPaths.map((aliasPath) => `- PATH alias: ${aliasPath}`),
    `- expected sha256: ${plan.expectedSha256}`,
    `- source: ${plan.url}`,
    "- policy: downloads only the ignored external depot_tools CIPD client"
  ].join("\n");
}

export async function bootstrapChromiumCipdClient(
  plan: ChromiumCipdClientBootstrapPlan,
  options: { force?: boolean } = {}
): Promise<ChromiumCipdClientBootstrapResult> {
  if (!options.force && existsSync(plan.binaryPath)) {
    const existing = readFileSync(plan.binaryPath);
    const sha256 = createHash("sha256").update(existing).digest("hex");
    if (sha256 !== plan.expectedSha256) {
      throw new Error(`Existing CIPD client SHA256 mismatch: ${sha256} != ${plan.expectedSha256}. Rerun with --force to replace it.`);
    }

    return {
      binaryPath: plan.binaryPath,
      downloaded: false,
      executableAliasPaths: ensureCipdExecutableAliases(plan),
      sha256
    };
  }

  const data = await downloadHttpsBuffer(plan.url);
  const sha256 = createHash("sha256").update(data).digest("hex");
  if (sha256 !== plan.expectedSha256) {
    throw new Error(`CIPD client SHA256 mismatch: ${sha256} != ${plan.expectedSha256}`);
  }

  mkdirSync(dirname(plan.binaryPath), { recursive: true });
  const tempPath = `${plan.binaryPath}.tmp.${process.pid}`;
  writeFileSync(tempPath, data);
  try {
    renameSync(tempPath, plan.binaryPath);
  } catch (error) {
    unlinkSync(tempPath);
    throw error;
  }

  return {
    binaryPath: plan.binaryPath,
    downloaded: true,
    executableAliasPaths: ensureCipdExecutableAliases(plan),
    sha256
  };
}

export function createChromiumCommandRunPlan(
  commandName: ChromiumBuildCommandName,
  options: ChromiumBuildPlanOptions = {}
): ChromiumCommandRunPlan {
  const env = options.env ?? process.env;
  const rootDirectory = resolve(options.rootDirectory ?? process.cwd());
  const workspacePlan = createChromiumWorkspacePlan(env.OAB_CHROMIUM_ROOT);
  const platform = options.platform ?? process.platform;
  const buildPlan = createChromiumBuildPlan({
    ...options,
    rootDirectory
  });
  const depotToolsDirectory = resolve(rootDirectory, workspacePlan.depotToolsDirectory);

  return {
    command: buildPlan.commands[commandName],
    depotToolsDirectory,
    env,
    platform
  };
}

export function formatChromiumCommandRunPlan(plan: ChromiumCommandRunPlan): string {
  return [
    "Chromium command run plan:",
    `- ${plan.command.label}`,
    `- command: ${formatCommandPlan(plan.command)}`,
    `- depot_tools: ${plan.depotToolsDirectory}`,
    "- policy: runs only against the external Chromium workspace"
  ].join("\n");
}

export function runChromiumCommand(
  plan: ChromiumCommandRunPlan,
  options: { dryRun?: boolean } = {}
): SpawnSyncReturns<Buffer> | undefined {
  if (options.dryRun) {
    return undefined;
  }

  if (!existsSync(plan.command.cwd)) {
    throw new Error(`Chromium command workspace is missing: ${plan.command.cwd}`);
  }

  const env = createChromiumCommandEnvironment(plan);
  if (env.VPYTHON_VIRTUALENV_ROOT) {
    mkdirSync(join(env.VPYTHON_VIRTUALENV_ROOT, "store"), { recursive: true });
  }

  return runCommandPlan(plan.command, env, plan.platform);
}

export function createChromiumCommandEnvironment(
  plan: Pick<ChromiumCommandRunPlan, "depotToolsDirectory" | "env" | "platform">
): NodeJS.ProcessEnv {
  const chromiumRoot = dirname(plan.depotToolsDirectory);
  const cipdPath = plan.platform === "win32"
    ? join(plan.depotToolsDirectory, ".cipd_bin", "cipd.exe")
    : join(plan.depotToolsDirectory, ".cipd_client");

  return withExternalChromiumToolsOnPath({
    ...plan.env,
    VPYTHON_CIPD_PATH: plan.env.VPYTHON_CIPD_PATH ?? cipdPath,
    VPYTHON_VIRTUALENV_ROOT: plan.env.VPYTHON_VIRTUALENV_ROOT ?? join(chromiumRoot, "vpython-root")
  }, plan.depotToolsDirectory, plan.platform);
}

export interface ChromiumPatchEntry {
  cleanRoomSpec: string;
  description: string;
  id: string;
  path: string;
  status: "planned" | "active";
  target: string;
}

export interface ChromiumPatchManifest {
  formatVersion: 1;
  patches: ChromiumPatchEntry[];
}

export interface PatchManifestValidationResult {
  manifest: ChromiumPatchManifest;
  violations: string[];
}

export interface ChromiumPatchApplicationStep {
  applyCommand: ChromiumCommandPlan;
  checkCommand: ChromiumCommandPlan;
  id: string;
  patchPath: string;
}

export interface ChromiumPatchApplicationPlan {
  checkoutDirectory: string;
  skippedPatchIds: string[];
  steps: ChromiumPatchApplicationStep[];
}

export interface ChromiumPatchApplicationPlanOptions {
  env?: NodeJS.ProcessEnv;
  rootDirectory?: string;
}

export function loadChromiumPatchManifest(
  manifestPath = createChromiumWorkspacePlan().patchManifestPath
): ChromiumPatchManifest {
  return parseChromiumPatchManifest(readFileSync(manifestPath, "utf8"));
}

export function parseChromiumPatchManifest(content: string): ChromiumPatchManifest {
  const parsed = JSON.parse(content) as unknown;
  const violations: string[] = [];

  if (!isRecord(parsed)) {
    throw new Error("Patch manifest must be a JSON object.");
  }

  if (parsed.formatVersion !== 1) {
    violations.push("formatVersion must be 1.");
  }

  if (!Array.isArray(parsed.patches)) {
    violations.push("patches must be an array.");
  }

  const patches = Array.isArray(parsed.patches)
    ? parsed.patches.flatMap((entry, index) => {
        if (!isRecord(entry)) {
          violations.push(`patches[${index}] must be an object.`);
          return [];
        }

        const patch = {
          cleanRoomSpec: stringField(entry, "cleanRoomSpec", violations, index),
          description: stringField(entry, "description", violations, index),
          id: stringField(entry, "id", violations, index),
          path: stringField(entry, "path", violations, index),
          status: statusField(entry, violations, index),
          target: stringField(entry, "target", violations, index)
        };

        return [patch];
      })
    : [];

  if (violations.length > 0) {
    throw new Error(`Invalid patch manifest:\n${violations.map((violation) => `- ${violation}`).join("\n")}`);
  }

  return {
    formatVersion: 1,
    patches
  };
}

export function validateChromiumPatchManifest(
  manifest: ChromiumPatchManifest,
  options: {
    exists?: (path: string) => boolean;
    managedPatchDirectory?: string;
    rootDirectory?: string;
  } = {}
): PatchManifestValidationResult {
  const rootDirectory = resolve(options.rootDirectory ?? process.cwd());
  const managedPatchDirectory = resolve(rootDirectory, options.managedPatchDirectory ?? createChromiumWorkspacePlan().managedPatchDirectory);
  const exists = options.exists ?? existsSync;
  const ids = new Set<string>();
  const violations: string[] = [];

  for (const patch of manifest.patches) {
    if (ids.has(patch.id)) {
      violations.push(`${patch.id}: duplicate patch id.`);
    }
    ids.add(patch.id);

    const patchPath = resolve(rootDirectory, patch.path);
    if (!isWithinDirectory(patchPath, managedPatchDirectory)) {
      violations.push(`${patch.id}: patch path must stay under ${relativePath(rootDirectory, managedPatchDirectory)}.`);
    }

    if (!patch.path.endsWith(".patch")) {
      violations.push(`${patch.id}: patch path must end with .patch.`);
    }

    if (!exists(patchPath)) {
      violations.push(`${patch.id}: patch file does not exist: ${patch.path}.`);
    }

    if (!patch.cleanRoomSpec.startsWith("docs/clean-room/")) {
      violations.push(`${patch.id}: cleanRoomSpec must reference docs/clean-room/.`);
    }

    if (patch.status === "active" && patch.description.length < 20) {
      violations.push(`${patch.id}: active patches need a specific description.`);
    }
  }

  return {
    manifest,
    violations
  };
}

export function formatPatchManifestValidation(result: PatchManifestValidationResult): string {
  if (result.violations.length > 0) {
    return [
      "Chromium patch manifest check failed:",
      ...result.violations.map((violation) => `- ${violation}`)
    ].join("\n");
  }

  return `Chromium patch manifest check passed for ${result.manifest.patches.length} owned patches.`;
}

export function createPatchApplicationPlan(
  manifest: ChromiumPatchManifest,
  options: ChromiumPatchApplicationPlanOptions = {}
): ChromiumPatchApplicationPlan {
  const env = options.env ?? process.env;
  const rootDirectory = resolve(options.rootDirectory ?? process.cwd());
  const workspacePlan = createChromiumWorkspacePlan(env.OAB_CHROMIUM_ROOT);
  const checkoutDirectory = resolve(rootDirectory, workspacePlan.checkoutDirectory);
  const activePatches = manifest.patches.filter((patch) => patch.status === "active");

  return {
    checkoutDirectory,
    skippedPatchIds: manifest.patches
      .filter((patch) => patch.status !== "active")
      .map((patch) => patch.id),
    steps: activePatches.map((patch) => {
      const patchPath = resolve(rootDirectory, patch.path);
      return {
        applyCommand: {
          args: ["apply", patchPath],
          command: "git",
          cwd: checkoutDirectory,
          label: `Apply ${patch.id}`
        },
        checkCommand: {
          args: ["apply", "--check", patchPath],
          command: "git",
          cwd: checkoutDirectory,
          label: `Check ${patch.id}`
        },
        id: patch.id,
        patchPath
      };
    })
  };
}

export function formatPatchApplicationPlan(plan: ChromiumPatchApplicationPlan): string {
  const lines = [
    "Chromium patch application plan:",
    `- checkout: ${plan.checkoutDirectory}`,
    `- active patches: ${plan.steps.length}`,
    `- planned/skipped patches: ${plan.skippedPatchIds.length}`
  ];

  if (plan.steps.length > 0) {
    lines.push("- Commands:");
    for (const step of plan.steps) {
      lines.push(`  - ${formatCommandPlan(step.checkCommand)}`);
      lines.push(`  - ${formatCommandPlan(step.applyCommand)}`);
    }
  }

  return lines.join("\n");
}

export interface ChromiumWorkspaceReadinessReport {
  checks: Array<{
    id: string;
    path: string;
    present: boolean;
    required: boolean;
  }>;
  ready: boolean;
}

export interface ChromiumWorkspaceProvenanceCheck {
  actual?: string;
  expected: string;
  id: string;
  path: string;
  present: boolean;
  verified: boolean;
}

export interface ChromiumWorkspaceProvenanceReport {
  checks: ChromiumWorkspaceProvenanceCheck[];
  verified: boolean;
  violations: string[];
}

export function checkChromiumWorkspaceReadiness(
  options: {
    env?: NodeJS.ProcessEnv;
    exists?: (path: string) => boolean;
    platform?: NodeJS.Platform;
    rootDirectory?: string;
  } = {}
): ChromiumWorkspaceReadinessReport {
  const env = options.env ?? process.env;
  const exists = options.exists ?? existsSync;
  const platform = options.platform ?? process.platform;
  const rootDirectory = resolve(options.rootDirectory ?? process.cwd());
  const workspacePlan = createChromiumWorkspacePlan(env.OAB_CHROMIUM_ROOT);
  const chromiumRoot = resolve(rootDirectory, dirname(workspacePlan.checkoutDirectory));
  const checkoutDirectory = resolve(rootDirectory, workspacePlan.checkoutDirectory);
  const depotToolsDirectory = resolve(rootDirectory, workspacePlan.depotToolsDirectory);
  const checks = [
    {
      id: "depot-tools",
      path: depotToolsDirectory,
      required: true
    },
    {
      id: "depot-tools-gclient",
      path: resolve(depotToolsDirectory, depotToolsExecutableName("gclient", platform)),
      required: true
    },
    {
      id: "depot-tools-gn",
      path: resolve(depotToolsDirectory, depotToolsExecutableName("gn", platform)),
      required: true
    },
    {
      id: "depot-tools-autoninja",
      path: resolve(depotToolsDirectory, depotToolsExecutableName("autoninja", platform)),
      required: true
    },
    {
      id: "chromium-checkout",
      path: checkoutDirectory,
      required: true
    },
    {
      id: "gclient-config",
      path: resolve(chromiumRoot, ".gclient"),
      required: true
    },
    {
      id: "chromium-build-file",
      path: resolve(checkoutDirectory, "BUILD.gn"),
      required: true
    },
    {
      id: "owned-patch-manifest",
      path: resolve(rootDirectory, workspacePlan.patchManifestPath),
      required: true
    }
  ].map((check) => ({
    ...check,
    present: exists(check.path)
  }));

  return {
    checks,
    ready: checks.every((check) => !check.required || check.present)
  };
}

export function formatChromiumWorkspaceReadiness(
  report: ChromiumWorkspaceReadinessReport
): string {
  return [
    "Chromium workspace readiness:",
    ...report.checks.map((check) =>
      `- ${check.present ? "ok" : "missing"} ${check.id}: ${check.path}`
    ),
    `- ready: ${String(report.ready)}`
  ].join("\n");
}

export function checkChromiumWorkspaceProvenance(
  options: {
    env?: NodeJS.ProcessEnv;
    exists?: (path: string) => boolean;
    readFile?: (path: string) => string | undefined;
    rootDirectory?: string;
  } = {}
): ChromiumWorkspaceProvenanceReport {
  const env = options.env ?? process.env;
  const exists = options.exists ?? existsSync;
  const readFile = options.readFile ?? readTextFileIfPresent;
  const rootDirectory = resolve(options.rootDirectory ?? process.cwd());
  const workspacePlan = createChromiumWorkspacePlan(env.OAB_CHROMIUM_ROOT);
  const gclientPlan = createChromiumGClientConfigPlan({
    env,
    rootDirectory
  });
  const checkoutDirectory = resolve(rootDirectory, workspacePlan.checkoutDirectory);
  const gitConfigPath = resolveCheckoutGitConfigPath(checkoutDirectory, exists, readFile);
  const expectedRepositoryUrl = gclientPlan.repositoryUrl;
  const checks: ChromiumWorkspaceProvenanceCheck[] = [
    {
      expected: expectedRepositoryUrl,
      id: "gclient-repository",
      path: gclientPlan.configPath,
      ...readRepositoryCheck(
        gclientPlan.configPath,
        exists,
        readFile,
        readGClientRepositoryUrl,
        expectedRepositoryUrl
      )
    },
    {
      expected: expectedRepositoryUrl,
      id: "checkout-origin",
      path: gitConfigPath,
      ...readRepositoryCheck(
        gitConfigPath,
        exists,
        readFile,
        readGitRemoteOriginUrl,
        expectedRepositoryUrl
      )
    }
  ];
  const violations = checks.flatMap((check) => {
    if (!check.present) {
      return [];
    }

    if (!check.actual) {
      return [`${check.id}: unable to read repository URL from ${relativePath(rootDirectory, check.path)}.`];
    }

    if (!repositoriesMatch(check.actual, check.expected)) {
      return [`${check.id}: expected ${check.expected}, got ${check.actual}.`];
    }

    return [];
  });

  return {
    checks,
    verified: checks.every((check) => check.present && check.verified) && violations.length === 0,
    violations
  };
}

export function formatChromiumWorkspaceProvenance(
  report: ChromiumWorkspaceProvenanceReport
): string {
  return [
    "Chromium workspace provenance:",
    ...report.checks.map((check) => {
      if (!check.present) {
        return `- missing ${check.id}: ${check.path}`;
      }

      if (check.verified) {
        return `- ok ${check.id}: ${check.actual}`;
      }

      return `- mismatch ${check.id}: expected ${check.expected}, got ${check.actual ?? "unreadable"}`;
    }),
    ...report.violations.map((violation) => `- violation: ${violation}`),
    `- verified: ${String(report.verified)}`
  ].join("\n");
}

export interface BrowserExecutableResolutionOptions {
  env?: NodeJS.ProcessEnv;
  exists?: (path: string) => boolean;
  platform?: NodeJS.Platform;
  rootDirectory?: string;
}

export interface DevBrowserLaunchPlan {
  agentUrl: string;
  args: string[];
  browserExecutable: string;
  extensionDirectory: string;
  profileDirectory: string;
  runtimeConfigPath: string;
  startUrl: string;
}

export interface DevBrowserLaunchPlanOptions extends BrowserExecutableResolutionOptions {
  rootDirectory?: string;
}

export const defaultDevBrowserStartUrl = "chrome://newtab/";

export function resolveBrowserExecutable(
  options: BrowserExecutableResolutionOptions = {}
): string {
  const env = options.env ?? process.env;
  const platform = options.platform ?? process.platform;
  const exists = options.exists ?? existsSync;

  if (env.OAB_BROWSER_EXECUTABLE) {
    return env.OAB_BROWSER_EXECUTABLE;
  }

  const found = [
    ...builtChromiumExecutableCandidates(options),
    ...browserExecutableCandidates(env, platform)
  ].find((candidate) => exists(candidate));
  if (!found) {
    throw new Error(
      [
        "No Chromium-compatible browser executable was found.",
        "Build Chromium with build:chromium or set OAB_BROWSER_EXECUTABLE to a Chrome, Chromium, Edge, or Chromium checkout executable."
      ].join(" ")
    );
  }

  return found;
}

export function builtChromiumExecutableCandidates(
  options: ChromiumBuildPlanOptions = {}
): string[] {
  const platform = options.platform ?? process.platform;
  const buildPlan = createChromiumBuildPlan(options);
  const outputDirectory = resolve(buildPlan.checkoutDirectory, buildPlan.buildDirectory);

  if (platform === "win32") {
    return [join(outputDirectory, "chrome.exe")];
  }

  if (platform === "darwin") {
    return [
      join(outputDirectory, "Chromium.app", "Contents", "MacOS", "Chromium"),
      join(outputDirectory, "Google Chrome for Testing.app", "Contents", "MacOS", "Google Chrome for Testing")
    ];
  }

  return [
    join(outputDirectory, "chrome"),
    join(outputDirectory, "chromium")
  ];
}

export function browserExecutableCandidates(
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform
): string[] {
  const candidates: string[] = [];

  if (platform === "win32") {
    const localAppData = env.LOCALAPPDATA;
    const programFiles = env.ProgramFiles;
    const programFilesX86 = env["ProgramFiles(x86)"];

    if (localAppData) {
      candidates.push(
        join(localAppData, "Google", "Chrome", "Application", "chrome.exe"),
        join(localAppData, "Chromium", "Application", "chrome.exe")
      );
    }

    for (const root of [programFiles, programFilesX86].filter(Boolean) as string[]) {
      candidates.push(
        join(root, "Google", "Chrome", "Application", "chrome.exe"),
        join(root, "Microsoft", "Edge", "Application", "msedge.exe"),
        join(root, "Chromium", "Application", "chrome.exe")
      );
    }

    candidates.push(...pathSearchCandidates(["chrome", "msedge", "chromium"], env, platform));
    return unique(candidates);
  }

  if (platform === "darwin") {
    candidates.push(
      "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
      "/Applications/Chromium.app/Contents/MacOS/Chromium",
      "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge"
    );
    candidates.push(...pathSearchCandidates(["google-chrome", "chromium", "microsoft-edge"], env, platform));
    return unique(candidates);
  }

  candidates.push(...pathSearchCandidates(["google-chrome", "google-chrome-stable", "chromium", "chromium-browser", "microsoft-edge"], env, platform));
  return unique(candidates);
}

export function createDevBrowserLaunchPlan(
  options: DevBrowserLaunchPlanOptions = {}
): DevBrowserLaunchPlan {
  const env = options.env ?? process.env;
  const rootDirectory = resolve(options.rootDirectory ?? process.cwd());
  const extensionDirectory = resolve(
    rootDirectory,
    env.OAB_EXTENSION_DIR ?? "packages/extension/.output/chrome-mv3"
  );
  const profileDirectory = resolve(
    rootDirectory,
    env.OAB_BROWSER_PROFILE_DIR ?? ".local/browser-profile"
  );
  const startUrl = env.OAB_BROWSER_START_URL ?? defaultDevBrowserStartUrl;
  const agentUrl = env.OAB_AGENT_URL ?? `http://127.0.0.1:${env.OAB_AGENT_PORT ?? "17376"}`;
  const browserExecutable = resolveBrowserExecutable(options);
  const runtimeConfigPath = resolve(extensionDirectory, "open-agent-config.json");
  const args = [
    `--user-data-dir=${profileDirectory}`,
    `--disable-extensions-except=${extensionDirectory}`,
    `--load-extension=${extensionDirectory}`,
    "--no-first-run",
    "--no-default-browser-check",
    "--new-window",
    startUrl
  ];

  return {
    agentUrl,
    args,
    browserExecutable,
    extensionDirectory,
    profileDirectory,
    runtimeConfigPath,
    startUrl
  };
}

export interface DevBrowserRuntimeConfig {
  agentBaseUrl: string;
}

export function createDevBrowserRuntimeConfig(plan: DevBrowserLaunchPlan): DevBrowserRuntimeConfig {
  return {
    agentBaseUrl: plan.agentUrl
  };
}

export function writeDevBrowserRuntimeConfig(plan: DevBrowserLaunchPlan): void {
  writeFileSync(
    plan.runtimeConfigPath,
    `${JSON.stringify(createDevBrowserRuntimeConfig(plan), null, 2)}\n`,
    "utf8"
  );
}

export function assertLaunchInputs(plan: DevBrowserLaunchPlan): void {
  if (!existsSync(plan.extensionDirectory)) {
    throw new Error(`Extension build directory does not exist: ${plan.extensionDirectory}`);
  }

  mkdirSync(plan.profileDirectory, { recursive: true });
}

export function launchDevBrowser(plan: DevBrowserLaunchPlan): ChildProcess {
  assertLaunchInputs(plan);
  return spawn(plan.browserExecutable, plan.args, {
    stdio: "inherit"
  });
}

export function findWorkspaceRoot(startDirectory = process.cwd()): string {
  let current = resolve(startDirectory);

  while (true) {
    if (existsSync(join(current, "pnpm-workspace.yaml"))) {
      return current;
    }

    const parent = dirname(current);
    if (parent === current) {
      throw new Error(`Unable to find workspace root from ${startDirectory}`);
    }
    current = parent;
  }
}

function readRepositoryCheck(
  path: string,
  exists: (path: string) => boolean,
  readFile: (path: string) => string | undefined,
  parseUrl: (content: string) => string | undefined,
  expected: string
): Omit<ChromiumWorkspaceProvenanceCheck, "expected" | "id" | "path"> {
  if (!exists(path)) {
    return {
      present: false,
      verified: false
    };
  }

  const actual = parseUrl(readFile(path) ?? "");

  return {
    ...(actual ? { actual } : {}),
    present: true,
    verified: actual ? repositoriesMatch(actual, expected) : false
  };
}

function readGClientRepositoryUrl(content: string): string | undefined {
  return content.match(/"url"\s*:\s*"([^"]+)"/)?.[1]?.replaceAll("\\\"", "\"");
}

function readGitRemoteOriginUrl(content: string): string | undefined {
  let inOriginRemote = false;

  for (const line of content.split(/\r?\n/)) {
    const section = line.match(/^\s*\[(.+)]\s*$/)?.[1];
    if (section) {
      inOriginRemote = section === 'remote "origin"';
      continue;
    }

    if (!inOriginRemote) {
      continue;
    }

    const url = line.match(/^\s*url\s*=\s*(.+?)\s*$/)?.[1];
    if (url) {
      return url;
    }
  }

  return undefined;
}

function resolveCheckoutGitConfigPath(
  checkoutDirectory: string,
  exists: (path: string) => boolean,
  readFile: (path: string) => string | undefined
): string {
  const directConfigPath = resolve(checkoutDirectory, ".git", "config");
  if (exists(directConfigPath)) {
    return directConfigPath;
  }

  const dotGitPath = resolve(checkoutDirectory, ".git");
  if (exists(dotGitPath)) {
    const gitDir = readFile(dotGitPath)?.match(/^gitdir:\s*(.+?)\s*$/im)?.[1];
    if (gitDir) {
      return resolve(checkoutDirectory, gitDir, "config");
    }
  }

  return directConfigPath;
}

function repositoriesMatch(actual: string, expected: string): boolean {
  return normalizeRepositoryUrl(actual) === normalizeRepositoryUrl(expected);
}

function normalizeRepositoryUrl(value: string): string {
  return value.trim().replace(/[\\/]$/, "").replace(/\.git$/i, "").toLowerCase();
}

function readTextFileIfPresent(path: string): string | undefined {
  try {
    return readFileSync(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT" ||
      (error as NodeJS.ErrnoException).code === "EISDIR") {
      return undefined;
    }
    throw error;
  }
}

function pathSearchCandidates(
  commands: string[],
  env: NodeJS.ProcessEnv,
  platform: NodeJS.Platform
): string[] {
  const pathValue = env.PATH ?? env.Path ?? "";
  const extensions = platform === "win32"
    ? (env.PATHEXT ?? ".EXE;.CMD;.BAT").split(";")
    : [""];

  return pathValue.split(delimiter).flatMap((directory) => {
    if (!directory) {
      return [];
    }

    return commands.flatMap((command) => {
      if (isAbsolute(command)) {
        return [command];
      }

      return extensions.map((extension) => join(directory, `${command}${extension.toLowerCase()}`));
    });
  });
}

function chromiumHostCpu(platform: NodeJS.Platform, arch: string): string {
  if (arch === "arm64") {
    return "arm64";
  }

  if (platform === "win32" || platform === "darwin" || platform === "linux") {
    return "x64";
  }

  return arch;
}

function cipdHostPlatform(platform: NodeJS.Platform, arch: string): string {
  if (platform === "win32") {
    return arch === "arm64" ? "windows-arm64" : "windows-amd64";
  }

  if (platform === "darwin") {
    return arch === "arm64" ? "mac-arm64" : "mac-amd64";
  }

  if (platform === "linux") {
    return arch === "arm64" ? "linux-arm64" : "linux-amd64";
  }

  throw new Error(`Unsupported CIPD host platform: ${platform}/${arch}`);
}

function readCipdClientDigest(digestPath: string, platform: string): string {
  const digestLine = readFileSync(digestPath, "utf8")
    .split(/\r?\n/)
    .find((line) => line.trim().startsWith(`${platform} `));

  const match = digestLine?.match(/sha256\s+([0-9a-f]{64})$/i);
  if (!match) {
    throw new Error(`No CIPD client SHA256 digest found for ${platform}.`);
  }

  return match[1]!.toLowerCase();
}

function ensureCipdExecutableAliases(plan: ChromiumCipdClientBootstrapPlan): string[] {
  const binary = readFileSync(plan.binaryPath);
  const binarySha256 = createHash("sha256").update(binary).digest("hex");
  if (binarySha256 !== plan.expectedSha256) {
    throw new Error(`CIPD client SHA256 mismatch before alias creation: ${binarySha256} != ${plan.expectedSha256}`);
  }

  for (const aliasPath of plan.executableAliasPaths) {
    mkdirSync(dirname(aliasPath), { recursive: true });
    const aliasSha256 = existsSync(aliasPath)
      ? createHash("sha256").update(readFileSync(aliasPath)).digest("hex")
      : undefined;

    if (aliasSha256 !== plan.expectedSha256) {
      copyFileSync(plan.binaryPath, aliasPath);
    }
  }

  return plan.executableAliasPaths;
}

function depotToolsExecutableName(command: string, platform: NodeJS.Platform): string {
  return platform === "win32" ? `${command}.bat` : command;
}

async function downloadHttpsBuffer(url: string, redirectCount = 0): Promise<Buffer> {
  if (redirectCount > 5) {
    throw new Error(`Too many redirects while downloading ${url}`);
  }

  return await new Promise<Buffer>((resolvePromise, reject) => {
    const request = get(url, (response) => {
      const statusCode = response.statusCode ?? 0;
      const location = response.headers.location;

      if (statusCode >= 300 && statusCode < 400 && location) {
        response.resume();
        downloadHttpsBuffer(new URL(location, url).toString(), redirectCount + 1)
          .then(resolvePromise, reject);
        return;
      }

      if (statusCode !== 200) {
        response.resume();
        reject(new Error(`Download failed with HTTP ${statusCode}: ${url}`));
        return;
      }

      const chunks: Buffer[] = [];
      response.on("data", (chunk: Buffer | string) => chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)));
      response.on("end", () => resolvePromise(Buffer.concat(chunks)));
    });

    request.on("error", reject);
  });
}

function createWindowsGClientCommand(
  syncCommand: ChromiumCommandPlan,
  depotToolsDirectory: string,
  env: NodeJS.ProcessEnv
): ChromiumCommandPlan {
  const vpythonRoot = env.VPYTHON_VIRTUALENV_ROOT ?? join(syncCommand.cwd, "vpython-root");

  return {
    ...syncCommand,
    args: [
      "-vpython-root",
      vpythonRoot,
      resolve(depotToolsDirectory, "gclient.py"),
      ...syncCommand.args
    ],
    command: "vpython3",
    label: "Sync external Chromium checkout through vpython"
  };
}

function formatCommandPlan(plan: ChromiumCommandPlan): string {
  return `(cd ${plan.cwd} && ${[plan.command, ...plan.args].join(" ")})`;
}

function runCommandPlan(
  plan: ChromiumCommandPlan,
  env: NodeJS.ProcessEnv,
  platform: NodeJS.Platform
): SpawnSyncReturns<Buffer> {
  if (!existsSync(plan.cwd)) {
    throw new Error(`Chromium command workspace is missing: ${plan.cwd}`);
  }

  const invocation = createPlatformCommandInvocation(plan, platform);
  const result = spawnSync(invocation.command, invocation.args, {
    cwd: plan.cwd,
    env,
    stdio: "inherit"
  });

  if (result.error) {
    throw result.error;
  }

  if (result.status !== 0) {
    process.exit(result.status ?? 1);
  }

  return result;
}

function runDirectCommandPlan(
  plan: ChromiumCommandPlan,
  env: NodeJS.ProcessEnv
): SpawnSyncReturns<Buffer> {
  if (!existsSync(plan.cwd)) {
    throw new Error(`Chromium command workspace is missing: ${plan.cwd}`);
  }

  const result = spawnSync(plan.command, plan.args, {
    cwd: plan.cwd,
    env,
    stdio: "inherit"
  });

  if (result.error) {
    throw result.error;
  }

  if (result.status !== 0) {
    process.exit(result.status ?? 1);
  }

  return result;
}

function createPlatformCommandInvocation(
  plan: ChromiumCommandPlan,
  platform: NodeJS.Platform
): { args: string[]; command: string } {
  if (platform !== "win32") {
    return {
      args: plan.args,
      command: plan.command
    };
  }

  return {
    args: ["/d", "/s", "/c", quoteWindowsCommand([plan.command, ...plan.args])],
    command: "cmd.exe"
  };
}

function quoteWindowsCommand(parts: string[]): string {
  return parts.map((part) => {
    if (/^[A-Za-z0-9_./:=+-]+$/.test(part)) {
      return part;
    }

    return `"${part.replaceAll("\"", "\\\"")}"`;
  }).join(" ");
}

function withExternalChromiumToolsOnPath(
  env: NodeJS.ProcessEnv,
  depotToolsDirectory: string,
  platform: NodeJS.Platform
): NodeJS.ProcessEnv {
  const pathKey = platform === "win32" && env.Path ? "Path" : "PATH";
  const currentPath = env[pathKey] ?? env.PATH ?? env.Path ?? "";
  const toolPaths = [depotToolsDirectory, join(depotToolsDirectory, ".cipd_bin")].join(delimiter);

  return withGitConfigOverrides({
    ...env,
    [pathKey]: currentPath
      ? `${toolPaths}${delimiter}${currentPath}`
      : toolPaths
  });
}

function withGitConfigOverrides(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  if (!env.OAB_GIT_SSL_BACKEND) {
    return env;
  }

  return {
    ...env,
    GIT_CONFIG_COUNT: "1",
    GIT_CONFIG_KEY_0: "http.sslBackend",
    GIT_CONFIG_VALUE_0: env.OAB_GIT_SSL_BACKEND
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function stringField(
  entry: Record<string, unknown>,
  field: keyof ChromiumPatchEntry,
  violations: string[],
  index: number
): string {
  const value = entry[field];
  if (typeof value !== "string" || value.trim().length === 0) {
    violations.push(`patches[${index}].${field} must be a non-empty string.`);
    return "";
  }

  return value;
}

function statusField(
  entry: Record<string, unknown>,
  violations: string[],
  index: number
): ChromiumPatchEntry["status"] {
  const value = entry.status;
  if (value === "planned" || value === "active") {
    return value;
  }

  violations.push(`patches[${index}].status must be planned or active.`);
  return "planned";
}

function isWithinDirectory(target: string, directory: string): boolean {
  const relativeTarget = relative(directory, target);
  return relativeTarget.length > 0 && !relativeTarget.startsWith("..") && !isAbsolute(relativeTarget);
}

function relativePath(rootDirectory: string, target: string): string {
  return relative(rootDirectory, target).replaceAll("\\", "/");
}

function formatGClientConfig(solutionName: string, repositoryUrl: string): string {
  return [
    "# Generated by Open Agent Browser.",
    "# Chromium source stays outside this repository; owned patches stay under packages/browser/patches.",
    "solutions = [",
    "  {",
    `    "name": "${escapeGClientString(solutionName)}",`,
    `    "url": "${escapeGClientString(repositoryUrl)}",`,
    "    \"managed\": False,",
    "    \"custom_deps\": {},",
    "    \"custom_vars\": {},",
    "  },",
    "]",
    "target_os = []",
    ""
  ].join("\n");
}

function escapeGClientString(value: string): string {
  return value.replaceAll("\\", "\\\\").replaceAll("\"", "\\\"");
}

function unique(values: string[]): string[] {
  return [...new Set(values)];
}
