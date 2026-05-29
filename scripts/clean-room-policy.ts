import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";

export interface CleanRoomViolation {
  match: string;
  path: string;
  rule: string;
}

interface ForbiddenRule {
  id: string;
  pattern: RegExp;
}

const upstreamProjectName = `${"browser"}${"os"}`;
const upstreamOrgName = `${"browser"}${"os"}-${"ai"}`;

const scannedRoots = [
  "packages",
  "scripts",
  "README.md",
  "docs",
  "package.json",
  "pnpm-workspace.yaml",
  "tsconfig.base.json"
];

const provenanceOnlyFiles = new Set([
  "docs/clean-room/source-log.md"
]);

const forbiddenReferenceRules: ForbiddenRule[] = [
  {
    id: "upstream-project-name",
    pattern: new RegExp(upstreamProjectName, "i")
  },
  {
    id: "upstream-github-org",
    pattern: new RegExp(upstreamOrgName, "i")
  },
  {
    id: "upstream-package-scope",
    pattern: new RegExp(`@${upstreamOrgName}`, "i")
  },
  {
    id: "upstream-cli-name",
    pattern: new RegExp(`${upstreamProjectName}-cli`, "i")
  },
  {
    id: "upstream-internal-path-apps-agent",
    pattern: /apps[\\/]agent/i
  },
  {
    id: "upstream-internal-path-apps-server",
    pattern: /apps[\\/]server/i
  },
  {
    id: "upstream-codename",
    pattern: new RegExp(`${"Fela"}fax`, "i")
  }
];

const forbiddenDependencyRules: ForbiddenRule[] = [
  {
    id: "forbidden-browser-agent-package",
    pattern: new RegExp(upstreamProjectName, "i")
  },
  {
    id: "forbidden-agpl-package",
    pattern: new RegExp(`${"ag"}${"pl"}`, "i")
  }
];

const ignoredDirectories = new Set([
  ".git",
  ".wxt",
  "coverage",
  "dist",
  "node_modules"
]);

const textFilePattern =
  /\.(css|html|json|md|mjs|ts|tsx|yaml|yml)$/i;

export function scanWorkspaceForCleanRoomViolations(root: string): CleanRoomViolation[] {
  return [
    ...scanSourceFiles(root),
    ...scanPackageManifests(root)
  ];
}

export function scanContentForForbiddenReferences(
  path: string,
  content: string
): CleanRoomViolation[] {
  const normalizedPath = normalizePath(path);
  if (provenanceOnlyFiles.has(normalizedPath)) {
    return [];
  }

  return forbiddenReferenceRules.flatMap((rule) => {
    const match = content.match(rule.pattern)?.[0];
    return match ? [{ match, path: normalizedPath, rule: rule.id }] : [];
  });
}

export function scanPackageDependencies(
  path: string,
  dependencyNames: string[]
): CleanRoomViolation[] {
  const normalizedPath = normalizePath(path);

  return dependencyNames.flatMap((dependencyName) =>
    forbiddenDependencyRules.flatMap((rule) =>
      rule.pattern.test(dependencyName)
        ? [{ match: dependencyName, path: normalizedPath, rule: rule.id }]
        : []
    )
  );
}

function scanSourceFiles(root: string): CleanRoomViolation[] {
  const violations: CleanRoomViolation[] = [];

  for (const rootEntry of scannedRoots) {
    const target = join(root, rootEntry);
    try {
      for (const file of walk(target)) {
        const rel = relative(root, file).replaceAll("\\", "/");
        const content = readFileSync(file, "utf8");
        violations.push(...scanContentForForbiddenReferences(rel, content));
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        throw error;
      }
    }
  }

  return violations;
}

function scanPackageManifests(root: string): CleanRoomViolation[] {
  const manifests = walk(join(root, "packages")).filter((file) =>
    file.endsWith("package.json")
  );
  manifests.push(join(root, "package.json"));

  return manifests.flatMap((manifest) => {
    const rel = relative(root, manifest).replaceAll("\\", "/");
    const pkg = JSON.parse(readFileSync(manifest, "utf8")) as {
      dependencies?: Record<string, string>;
      devDependencies?: Record<string, string>;
      optionalDependencies?: Record<string, string>;
    };
    return scanPackageDependencies(rel, [
      ...Object.keys(pkg.dependencies ?? {}),
      ...Object.keys(pkg.devDependencies ?? {}),
      ...Object.keys(pkg.optionalDependencies ?? {})
    ]);
  });
}

function walk(path: string): string[] {
  const stats = statSync(path);
  if (stats.isFile()) {
    return textFilePattern.test(path) ? [path] : [];
  }

  return readdirSync(path).flatMap((entry) => {
    if (ignoredDirectories.has(entry)) {
      return [];
    }

    return walk(join(path, entry));
  });
}

function normalizePath(path: string): string {
  return path.replaceAll("\\", "/");
}
