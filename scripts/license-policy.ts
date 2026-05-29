import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";

interface PackageMetadata {
  license?: unknown;
  licenses?: unknown;
  name?: unknown;
  version?: unknown;
}

export interface ScannedPackage {
  license: string;
  name: string;
  path: string;
  version: string;
}

export interface LicenseReport {
  allowedPackageCount: number;
  generatedAt: string;
  packages: ScannedPackage[];
  rootLicense: string;
  violations: string[];
}

const forbiddenNamePatterns = [new RegExp(`${"browser"}${"os"}`, "i")];
const forbiddenLicensePatterns = [
  /(^|[^A-Z])AGPL([^A-Z]|$)/i,
  /(^|[^A-Z])GPL([^A-Z]|$)/i,
  /(^|[^A-Z])LGPL([^A-Z]|$)/i
];
const allowedLicenseOptionPatterns = [
  /^0?BSD-\d-Clause$/i,
  /^Apache-2\.0$/i,
  /^BlueOak-1\.0\.0$/i,
  /^CC0-1\.0$/i,
  /^ISC$/i,
  /^MIT$/i,
  /^MPL-2\.0$/i,
  /^Python-2\.0$/i,
  /^Unicode-3\.0$/i
];

export function listInstalledPackages(root: string): ScannedPackage[] {
  const pnpmStore = join(root, "node_modules", ".pnpm");
  if (!existsSync(pnpmStore)) {
    throw new Error("node_modules/.pnpm was not found. Run pnpm install before checking licenses.");
  }

  const packages = new Map<string, ScannedPackage>();

  for (const virtualEntry of readdirSync(pnpmStore)) {
    const nodeModulesPath = join(pnpmStore, virtualEntry, "node_modules");
    if (!existsSync(nodeModulesPath) || !statSync(nodeModulesPath).isDirectory()) {
      continue;
    }

    for (const packageJson of listPackageJsonFiles(nodeModulesPath)) {
      const pkg = JSON.parse(readFileSync(packageJson, "utf8")) as PackageMetadata;
      if (typeof pkg.name !== "string" || typeof pkg.version !== "string") {
        continue;
      }

      const key = `${pkg.name}@${pkg.version}`;
      packages.set(key, {
        license: normalizeLicense(pkg),
        name: pkg.name,
        path: relative(root, packageJson).replaceAll("\\", "/"),
        version: pkg.version
      });
    }
  }

  return [...packages.values()].sort((a, b) => `${a.name}@${a.version}`.localeCompare(`${b.name}@${b.version}`));
}

export function checkLicenses(packages: ScannedPackage[]): string[] {
  const violations: string[] = [];

  for (const pkg of packages) {
    if (pkg.license === "UNKNOWN") {
      violations.push(`${pkg.name}@${pkg.version}: missing license metadata (${pkg.path})`);
    }

    for (const pattern of forbiddenNamePatterns) {
      if (pattern.test(pkg.name)) {
        violations.push(`${pkg.name}@${pkg.version}: forbidden package name (${pkg.path})`);
      }
    }

    if (hasForbiddenLicense(pkg.license)) {
      violations.push(`${pkg.name}@${pkg.version}: forbidden license ${pkg.license} (${pkg.path})`);
    }
  }

  return violations;
}

export function buildLicenseReport(root: string, generatedAt = new Date().toISOString()): LicenseReport {
  const packages = listInstalledPackages(root);
  const violations = checkLicenses(packages);

  return {
    allowedPackageCount: packages.length - violations.length,
    generatedAt,
    packages,
    rootLicense: readRootLicenseName(root),
    violations
  };
}

export function formatLicenseReport(report: LicenseReport): string {
  const lines = [
    "# Dependency License Report",
    "",
    `Generated: ${report.generatedAt}`,
    `Root license: ${report.rootLicense}`,
    `Installed packages scanned: ${report.packages.length}`,
    `Allowed packages: ${report.allowedPackageCount}`,
    `Violations: ${report.violations.length}`,
    "",
    "## Violations",
    "",
    ...(
      report.violations.length > 0
        ? report.violations.map((violation) => `- ${violation}`)
        : ["None."]
    ),
    "",
    "## Packages",
    "",
    "| Package | Version | License | Metadata path |",
    "| --- | --- | --- | --- |",
    ...report.packages.map((pkg) =>
      `| ${escapeMarkdownTableCell(pkg.name)} | ${escapeMarkdownTableCell(pkg.version)} | ${escapeMarkdownTableCell(pkg.license)} | ${escapeMarkdownTableCell(pkg.path)} |`
    ),
    ""
  ];

  return `${lines.join("\n")}`;
}

function listPackageJsonFiles(nodeModulesPath: string): string[] {
  return readdirSync(nodeModulesPath).flatMap((entry) => {
    const entryPath = join(nodeModulesPath, entry);
    if (!statSync(entryPath).isDirectory()) {
      return [];
    }

    if (entry.startsWith("@")) {
      return readdirSync(entryPath)
        .map((scopedEntry) => join(entryPath, scopedEntry, "package.json"))
        .filter(existsSync);
    }

    const packageJson = join(entryPath, "package.json");
    return existsSync(packageJson) ? [packageJson] : [];
  });
}

function normalizeLicense(pkg: PackageMetadata): string {
  if (typeof pkg.license === "string") {
    return pkg.license;
  }

  if (pkg.license && typeof pkg.license === "object" && "type" in pkg.license) {
    const typed = pkg.license as { type?: unknown };
    if (typeof typed.type === "string") {
      return typed.type;
    }
  }

  if (typeof pkg.licenses === "string") {
    return pkg.licenses;
  }

  if (Array.isArray(pkg.licenses)) {
    return pkg.licenses.map((license) => {
      if (typeof license === "string") {
        return license;
      }
      if (license && typeof license === "object" && "type" in license) {
        const typed = license as { type?: unknown };
        return typeof typed.type === "string" ? typed.type : "UNKNOWN";
      }
      return "UNKNOWN";
    }).join(" OR ");
  }

  return "UNKNOWN";
}

function hasForbiddenLicense(license: string): boolean {
  if (!forbiddenLicensePatterns.some((pattern) => pattern.test(license))) {
    return false;
  }

  return !licenseOptions(license).some((option) =>
    allowedLicenseOptionPatterns.some((pattern) => pattern.test(option))
  );
}

function licenseOptions(license: string): string[] {
  return license
    .replace(/[()]/g, "")
    .split(/\s+OR\s+/i)
    .map((option) => option.trim())
    .filter(Boolean);
}

function readRootLicenseName(root: string): string {
  const licensePath = join(root, "LICENSE");
  if (!existsSync(licensePath)) {
    return "MISSING";
  }

  const firstLine = readFileSync(licensePath, "utf8").split(/\r?\n/, 1)[0]?.trim();
  return firstLine && firstLine.length > 0 ? firstLine : "UNKNOWN";
}

function escapeMarkdownTableCell(value: string): string {
  return value.replaceAll("\\", "\\\\").replaceAll("|", "\\|").replace(/\r?\n/g, " ");
}
