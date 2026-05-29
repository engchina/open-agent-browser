import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  builtChromiumExecutableCandidates,
  browserExecutableCandidates,
  bootstrapChromiumCipdClient,
  checkChromiumWorkspaceReadiness,
  createChromiumCipdClientBootstrapPlan,
  createChromiumBuildPlan,
  createChromiumCommandRunPlan,
  createChromiumCommandEnvironment,
  createDepotToolsBootstrapPlan,
  createChromiumGClientConfigPlan,
  checkChromiumWorkspaceProvenance,
  createDevBrowserLaunchPlan,
  createDevBrowserRuntimeConfig,
  createPatchApplicationPlan,
  defaultDevBrowserStartUrl,
  defaultDepotToolsRepositoryUrl,
  formatChromiumWorkspaceProvenance,
  formatChromiumCipdClientBootstrapPlan,
  parseChromiumPatchManifest,
  resolveBrowserExecutable,
  runDepotToolsBootstrap,
  runChromiumCommand,
  validateChromiumPatchManifest,
  writeChromiumGClientConfig
} from "./index.js";

describe("browser executable resolution", () => {
  it("honors explicit executable configuration", () => {
    expect(
      resolveBrowserExecutable({
        env: { OAB_BROWSER_EXECUTABLE: "C:/Browser/chrome.exe" },
        exists: () => false,
        platform: "win32"
      })
    ).toBe("C:/Browser/chrome.exe");
  });

  it("prefers an owned Chromium build over installed browser candidates", () => {
    const rootDirectory = "E:/workspace/open-agent-browser";
    const ownedBuild = "E:\\workspace\\open-agent-browser\\external\\chromium\\src\\out\\OpenAgentBrowser\\chrome.exe";
    const installedChrome = "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe";

    expect(
      resolveBrowserExecutable({
        env: {
          ProgramFiles: "C:/Program Files"
        },
        exists: (path) => path === ownedBuild || path === installedChrome,
        platform: "win32",
        rootDirectory
      })
    ).toBe(ownedBuild);
  });

  it("creates platform-specific owned Chromium build executable candidates", () => {
    expect(
      builtChromiumExecutableCandidates({
        env: {
          OAB_CHROMIUM_BUILD_DIR: "out/TestBrowser"
        },
        platform: "win32",
        rootDirectory: "E:/workspace/open-agent-browser"
      })
    ).toEqual([
      "E:\\workspace\\open-agent-browser\\external\\chromium\\src\\out\\TestBrowser\\chrome.exe"
    ]);
  });

  it("searches Windows Chrome and Edge install locations", () => {
    const candidates = browserExecutableCandidates(
      {
        LOCALAPPDATA: "C:/Users/me/AppData/Local",
        ProgramFiles: "C:/Program Files",
        "ProgramFiles(x86)": "C:/Program Files (x86)"
      },
      "win32"
    );

    expect(candidates).toContain("C:\\Users\\me\\AppData\\Local\\Google\\Chrome\\Application\\chrome.exe");
    expect(candidates).toContain("C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe");
  });
});

describe("dev browser launch plan", () => {
  it("builds an isolated profile launch plan", () => {
    const plan = createDevBrowserLaunchPlan({
      env: {
        OAB_BROWSER_EXECUTABLE: "C:/Browser/chrome.exe",
        OAB_BROWSER_START_URL: "https://example.test",
        OAB_AGENT_PORT: "18181"
      },
      exists: () => true,
      platform: "win32",
      rootDirectory: "E:/workspace/open-agent-browser"
    });

    expect(plan.browserExecutable).toBe("C:/Browser/chrome.exe");
    expect(plan.agentUrl).toBe("http://127.0.0.1:18181");
    expect(plan.args).toContain("--new-window");
    expect(plan.args.some((arg) => arg.startsWith("--load-extension="))).toBe(true);
    expect(plan.profileDirectory).toContain(".local");
    expect(plan.runtimeConfigPath).toBe("E:\\workspace\\open-agent-browser\\packages\\extension\\.output\\chrome-mv3\\open-agent-config.json");
  });

  it("opens the agent-aware new tab by default", () => {
    const plan = createDevBrowserLaunchPlan({
      env: {
        OAB_BROWSER_EXECUTABLE: "C:/Browser/chrome.exe"
      },
      exists: () => true,
      platform: "win32",
      rootDirectory: "E:/workspace/open-agent-browser"
    });

    expect(defaultDevBrowserStartUrl).toBe("chrome://newtab/");
    expect(plan.startUrl).toBe(defaultDevBrowserStartUrl);
    expect(plan.args.at(-1)).toBe(defaultDevBrowserStartUrl);
  });

  it("creates an extension runtime config with the selected agent URL", () => {
    const plan = createDevBrowserLaunchPlan({
      env: {
        OAB_AGENT_URL: "http://127.0.0.1:19090",
        OAB_BROWSER_EXECUTABLE: "C:/Browser/chrome.exe"
      },
      exists: () => true,
      platform: "win32",
      rootDirectory: "E:/workspace/open-agent-browser"
    });

    expect(createDevBrowserRuntimeConfig(plan)).toEqual({
      agentBaseUrl: "http://127.0.0.1:19090"
    });
  });
});

describe("Chromium patch manifest", () => {
  it("parses and validates owned patch entries", () => {
    const manifest = parseChromiumPatchManifest(JSON.stringify({
      formatVersion: 1,
      patches: [
        {
          cleanRoomSpec: "docs/clean-room/behavior-spec.md",
          description: "Owned browser side panel entry point patch.",
          id: "0001-owned-entrypoint",
          path: "packages/browser/patches/0001-owned-entrypoint.patch",
          status: "planned",
          target: "chromium/src"
        }
      ]
    }));
    const result = validateChromiumPatchManifest(manifest, {
      exists: (path) => path.endsWith("0001-owned-entrypoint.patch"),
      rootDirectory: "E:/workspace/open-agent-browser"
    });

    expect(result.violations).toEqual([]);
  });

  it("rejects patch paths outside the managed directory", () => {
    const manifest = parseChromiumPatchManifest(JSON.stringify({
      formatVersion: 1,
      patches: [
        {
          cleanRoomSpec: "docs/clean-room/behavior-spec.md",
          description: "This patch path leaves the managed patch directory.",
          id: "0001-bad-path",
          path: "external/chromium/src/bad.patch",
          status: "planned",
          target: "chromium/src"
        }
      ]
    }));
    const result = validateChromiumPatchManifest(manifest, {
      exists: () => true,
      rootDirectory: "E:/workspace/open-agent-browser"
    });

    expect(result.violations.some((violation) => violation.includes("must stay under"))).toBe(true);
  });

  it("rejects duplicate patch ids", () => {
    const manifest = parseChromiumPatchManifest(JSON.stringify({
      formatVersion: 1,
      patches: [
        {
          cleanRoomSpec: "docs/clean-room/behavior-spec.md",
          description: "First owned patch.",
          id: "0001-duplicate",
          path: "packages/browser/patches/0001-a.patch",
          status: "planned",
          target: "chromium/src"
        },
        {
          cleanRoomSpec: "docs/clean-room/behavior-spec.md",
          description: "Second owned patch.",
          id: "0001-duplicate",
          path: "packages/browser/patches/0001-b.patch",
          status: "planned",
          target: "chromium/src"
        }
      ]
    }));
    const result = validateChromiumPatchManifest(manifest, {
      exists: () => true,
      rootDirectory: "E:/workspace/open-agent-browser"
    });

    expect(result.violations.some((violation) => violation.includes("duplicate patch id"))).toBe(true);
  });
});

describe("Chromium workspace planning", () => {
  it("creates a clean-room gclient config plan for an external checkout", () => {
    const plan = createChromiumGClientConfigPlan({
      rootDirectory: "E:/workspace/open-agent-browser"
    });

    expect(plan.chromiumRoot).toBe("E:\\workspace\\open-agent-browser\\external\\chromium");
    expect(plan.configPath).toBe("E:\\workspace\\open-agent-browser\\external\\chromium\\.gclient");
    expect(plan.solutionName).toBe("src");
    expect(plan.content).toContain('"url": "https://chromium.googlesource.com/chromium/src.git"');
    expect(plan.content).toContain('"managed": False');
  });

  it("writes the external gclient config without overwriting by default", () => {
    const tempDirectory = mkdtempSync(join(tmpdir(), "open-agent-browser-chromium-"));
    try {
      const plan = createChromiumGClientConfigPlan({
        rootDirectory: tempDirectory
      });

      writeChromiumGClientConfig(plan);
      expect(existsSync(plan.configPath)).toBe(true);
      expect(readFileSync(plan.configPath, "utf8")).toBe(plan.content);
      expect(() => writeChromiumGClientConfig(plan)).toThrow(/Refusing to overwrite/);

      writeFileSync(plan.configPath, "custom config", "utf8");
      writeChromiumGClientConfig(plan, { overwrite: true });
      expect(readFileSync(plan.configPath, "utf8")).toBe(plan.content);
    } finally {
      rmSync(tempDirectory, { force: true, recursive: true });
    }
  });

  it("verifies external Chromium workspace provenance when config and checkout origin match", () => {
    const tempDirectory = mkdtempSync(join(tmpdir(), "open-agent-browser-provenance-"));
    try {
      const plan = createChromiumGClientConfigPlan({
        rootDirectory: tempDirectory
      });
      const gitDirectory = join(plan.checkoutDirectory, ".git");

      mkdirSync(plan.chromiumRoot, { recursive: true });
      mkdirSync(gitDirectory, { recursive: true });
      writeFileSync(plan.configPath, plan.content, "utf8");
      writeFileSync(
        join(gitDirectory, "config"),
        [
          "[remote \"origin\"]",
          `  url = ${plan.repositoryUrl}`,
          ""
        ].join("\n"),
        "utf8"
      );

      const report = checkChromiumWorkspaceProvenance({
        rootDirectory: tempDirectory
      });

      expect(report.violations).toEqual([]);
      expect(report.verified).toBe(true);
      expect(formatChromiumWorkspaceProvenance(report)).toContain("ok checkout-origin");
    } finally {
      rmSync(tempDirectory, { force: true, recursive: true });
    }
  });

  it("flags external Chromium checkout provenance mismatches", () => {
    const tempDirectory = mkdtempSync(join(tmpdir(), "open-agent-browser-provenance-mismatch-"));
    try {
      const plan = createChromiumGClientConfigPlan({
        rootDirectory: tempDirectory
      });
      const gitDirectory = join(plan.checkoutDirectory, ".git");

      mkdirSync(gitDirectory, { recursive: true });
      writeFileSync(
        join(gitDirectory, "config"),
        [
          "[remote \"origin\"]",
          "  url = https://example.com/not-chromium.git",
          ""
        ].join("\n"),
        "utf8"
      );

      const report = checkChromiumWorkspaceProvenance({
        rootDirectory: tempDirectory
      });

      expect(report.verified).toBe(false);
      expect(report.violations).toContain(
        `checkout-origin: expected ${plan.repositoryUrl}, got https://example.com/not-chromium.git.`
      );
    } finally {
      rmSync(tempDirectory, { force: true, recursive: true });
    }
  });

  it("creates a GN/Ninja build plan for an external checkout", () => {
    const plan = createChromiumBuildPlan({
      arch: "x64",
      env: {
        OAB_BROWSER_EXECUTABLE: "C:/Browser/chrome.exe",
        OAB_CHROMIUM_BUILD_DIR: "out/TestBrowser"
      },
      platform: "win32",
      rootDirectory: "E:/workspace/open-agent-browser"
    });

    expect(plan.checkoutDirectory).toBe("E:\\workspace\\open-agent-browser\\external\\chromium\\src");
    expect(plan.buildDirectory).toBe("out/TestBrowser");
    expect(plan.gnArgs).toContain('target_cpu="x64"');
    expect(plan.commands.generate.command).toBe("gn");
    expect(plan.commands.build.args).toEqual(["-C", "out/TestBrowser", "chrome"]);
  });

  it("creates executable command wrappers for the external Chromium checkout", () => {
    const plan = createChromiumCommandRunPlan("generate", {
      env: {
        OAB_CHROMIUM_BUILD_DIR: "out/TestBrowser",
        OAB_CHROMIUM_ROOT: "external/chromium",
        PATH: "C:/Windows/System32"
      },
      platform: "win32",
      rootDirectory: "E:/workspace/open-agent-browser"
    });

    expect(plan.command.command).toBe("gn");
    expect(plan.command.args).toEqual(["gen", "out/TestBrowser", expect.stringContaining("target_cpu")]);
    expect(plan.command.cwd).toBe("E:\\workspace\\open-agent-browser\\external\\chromium\\src");
    expect(plan.depotToolsDirectory).toBe("E:\\workspace\\open-agent-browser\\external\\chromium\\depot_tools");
    expect(runChromiumCommand(plan, { dryRun: true })).toBeUndefined();
  });

  it("passes scoped Git TLS config to Chromium command children", () => {
    const plan = createChromiumCommandRunPlan("sync", {
      env: {
        OAB_CHROMIUM_ROOT: "external/chromium",
        OAB_GIT_SSL_BACKEND: "openssl",
        PATH: "C:/Windows/System32"
      },
      platform: "win32",
      rootDirectory: "E:/workspace/open-agent-browser"
    });
    const env = createChromiumCommandEnvironment(plan);

    expect(plan.command.command).toBe("vpython3");
    expect(plan.command.args.slice(0, 3)).toEqual([
      "-vpython-root",
      "E:\\workspace\\open-agent-browser\\external\\chromium\\vpython-root",
      "E:\\workspace\\open-agent-browser\\external\\chromium\\depot_tools\\gclient.py"
    ]);
    expect(env.GIT_CONFIG_COUNT).toBe("1");
    expect(env.GIT_CONFIG_KEY_0).toBe("http.sslBackend");
    expect(env.GIT_CONFIG_VALUE_0).toBe("openssl");
    expect(env.PATH ?? env.Path).toContain("external\\chromium\\depot_tools");
    expect(env.PATH ?? env.Path).toContain("external\\chromium\\depot_tools\\.cipd_bin");
    expect(env.VPYTHON_CIPD_PATH).toBe("E:\\workspace\\open-agent-browser\\external\\chromium\\depot_tools\\.cipd_bin\\cipd.exe");
    expect(env.VPYTHON_VIRTUALENV_ROOT).toBe("E:\\workspace\\open-agent-browser\\external\\chromium\\vpython-root");
  });

  it("creates a depot_tools bootstrap plan outside the source tree", () => {
    const plan = createDepotToolsBootstrapPlan({
      env: {
        OAB_CHROMIUM_ROOT: "external/chromium"
      },
      platform: "win32",
      rootDirectory: "E:/workspace/open-agent-browser"
    });

    expect(plan.chromiumRoot).toBe("E:\\workspace\\open-agent-browser\\external\\chromium");
    expect(plan.depotToolsDirectory).toBe("E:\\workspace\\open-agent-browser\\external\\chromium\\depot_tools");
    expect(plan.repositoryUrl).toBe(defaultDepotToolsRepositoryUrl);
    expect(plan.commands.clone).toMatchObject({
      args: ["clone", defaultDepotToolsRepositoryUrl, "E:\\workspace\\open-agent-browser\\external\\chromium\\depot_tools"],
      command: "git",
      cwd: "E:\\workspace\\open-agent-browser\\external\\chromium"
    });
    expect(plan.commands.update).toMatchObject({
      args: ["pull", "--ff-only"],
      command: "git",
      cwd: "E:\\workspace\\open-agent-browser\\external\\chromium\\depot_tools"
    });
    expect(runDepotToolsBootstrap(plan, { dryRun: true })).toBeUndefined();
  });

  it("can scope git TLS backend overrides to depot_tools bootstrap commands", () => {
    const plan = createDepotToolsBootstrapPlan({
      env: {
        OAB_CHROMIUM_ROOT: "external/chromium",
        OAB_GIT_SSL_BACKEND: "openssl"
      },
      platform: "win32",
      rootDirectory: "E:/workspace/open-agent-browser"
    });

    expect(plan.commands.clone.args.slice(0, 2)).toEqual(["-c", "http.sslBackend=openssl"]);
    expect(plan.commands.update.args.slice(0, 2)).toEqual(["-c", "http.sslBackend=openssl"]);
  });

  it("creates a CIPD client bootstrap plan from depot_tools metadata", () => {
    const tempDirectory = mkdtempSync(join(tmpdir(), "open-agent-browser-cipd-"));
    try {
      const depotToolsDirectory = join(tempDirectory, "external", "chromium", "depot_tools");
      mkdirSync(depotToolsDirectory, { recursive: true });
      writeFileSync(join(depotToolsDirectory, "cipd_client_version"), "git_revision:test-version\n", "utf8");
      writeFileSync(
        join(depotToolsDirectory, "cipd_client_version.digests"),
        "windows-amd64    sha256  2034bc85fd0c285e4cbb69706241a08e130ed90309b0bfab3c54974828a413b7\n",
        "utf8"
      );

      const plan = createChromiumCipdClientBootstrapPlan({
        env: {
          OAB_CHROMIUM_ROOT: "external/chromium"
        },
        platform: "win32",
        rootDirectory: tempDirectory
      });

      expect(plan.binaryPath).toBe(join(depotToolsDirectory, ".cipd_client.exe"));
      expect(plan.executableAliasPaths).toEqual([
        join(depotToolsDirectory, "cipd.exe"),
        join(depotToolsDirectory, ".cipd_bin", "cipd.exe")
      ]);
      expect(plan.expectedSha256).toBe("2034bc85fd0c285e4cbb69706241a08e130ed90309b0bfab3c54974828a413b7");
      expect(plan.platform).toBe("windows-amd64");
      expect(plan.url).toContain("platform=windows-amd64");
      expect(formatChromiumCipdClientBootstrapPlan(plan)).toContain("Chromium CIPD client bootstrap plan");
    } finally {
      rmSync(tempDirectory, { force: true, recursive: true });
    }
  });

  it("verifies an existing CIPD client and creates a Windows PATH alias", async () => {
    const tempDirectory = mkdtempSync(join(tmpdir(), "open-agent-browser-cipd-existing-"));
    try {
      const depotToolsDirectory = join(tempDirectory, "external", "chromium", "depot_tools");
      const clientData = Buffer.from("test cipd client");
      const clientSha256 = createHash("sha256").update(clientData).digest("hex");
      mkdirSync(depotToolsDirectory, { recursive: true });
      writeFileSync(join(depotToolsDirectory, "cipd_client_version"), "git_revision:test-version\n", "utf8");
      writeFileSync(
        join(depotToolsDirectory, "cipd_client_version.digests"),
        `windows-amd64    sha256  ${clientSha256}\n`,
        "utf8"
      );

      const plan = createChromiumCipdClientBootstrapPlan({
        env: {
          OAB_CHROMIUM_ROOT: "external/chromium"
        },
        platform: "win32",
        rootDirectory: tempDirectory
      });
      writeFileSync(plan.binaryPath, clientData);

      const result = await bootstrapChromiumCipdClient(plan);

      expect(result.downloaded).toBe(false);
      expect(result.executableAliasPaths).toEqual(plan.executableAliasPaths);
      for (const executableAliasPath of plan.executableAliasPaths) {
        expect(readFileSync(executableAliasPath)).toEqual(clientData);
      }
    } finally {
      rmSync(tempDirectory, { force: true, recursive: true });
    }
  });

  it("reports missing external Chromium prerequisites", () => {
    const report = checkChromiumWorkspaceReadiness({
      exists: (path) => path.endsWith("manifest.json"),
      platform: "win32",
      rootDirectory: "E:/workspace/open-agent-browser"
    });

    expect(report.ready).toBe(false);
    expect(report.checks.find((check) => check.id === "owned-patch-manifest")?.present).toBe(true);
    expect(report.checks.find((check) => check.id === "chromium-checkout")?.present).toBe(false);
  });

  it("checks concrete depot_tools command entrypoints", () => {
    const report = checkChromiumWorkspaceReadiness({
      exists: (path) =>
        path.endsWith("depot_tools") ||
        path.endsWith("gclient.bat") ||
        path.endsWith("gn.bat") ||
        path.endsWith("autoninja.bat") ||
        path.endsWith(".gclient") ||
        path.endsWith("BUILD.gn") ||
        path.endsWith("manifest.json"),
      platform: "win32",
      rootDirectory: "E:/workspace/open-agent-browser"
    });

    expect(report.checks.find((check) => check.id === "depot-tools-gclient")?.path).toBe("E:\\workspace\\open-agent-browser\\external\\chromium\\depot_tools\\gclient.bat");
    expect(report.checks.find((check) => check.id === "depot-tools-gn")?.present).toBe(true);
    expect(report.checks.find((check) => check.id === "depot-tools-autoninja")?.present).toBe(true);
  });

  it("plans active patch checks without applying planned placeholders", () => {
    const manifest = parseChromiumPatchManifest(JSON.stringify({
      formatVersion: 1,
      patches: [
        {
          cleanRoomSpec: "docs/clean-room/behavior-spec.md",
          description: "A planned future Chromium patch.",
          id: "0001-planned",
          path: "packages/browser/patches/0001-planned.patch",
          status: "planned",
          target: "chromium/src"
        },
        {
          cleanRoomSpec: "docs/clean-room/behavior-spec.md",
          description: "An active owned Chromium patch.",
          id: "0002-active",
          path: "packages/browser/patches/0002-active.patch",
          status: "active",
          target: "chromium/src"
        }
      ]
    }));
    const plan = createPatchApplicationPlan(manifest, {
      rootDirectory: "E:/workspace/open-agent-browser"
    });

    expect(plan.skippedPatchIds).toEqual(["0001-planned"]);
    expect(plan.steps).toHaveLength(1);
    expect(plan.steps[0]?.checkCommand.args).toContain("--check");
    expect(plan.steps[0]?.applyCommand.args[0]).toBe("apply");
  });
});
