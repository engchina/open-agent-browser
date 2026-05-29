import { createHash } from "node:crypto";
import type { Dirent } from "node:fs";
import { access, mkdir, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { join, relative, resolve } from "node:path";

interface PackageJson {
  name?: string;
  version?: string;
}

interface ZipSource {
  archivePath: string;
  sourcePath: string;
}

interface ArtifactInfo {
  name: string;
  path: string;
  sha256: string;
  size: number;
}

const crcTable = new Uint32Array(256).map((_, index) => {
  let value = index;
  for (let bit = 0; bit < 8; bit += 1) {
    value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
  }
  return value >>> 0;
});

const workspaceRoot = process.cwd();
const outDir = resolve(workspaceRoot, readArgValue("--out-dir") ?? "artifacts/release");
const rootPackage = JSON.parse(await readFile(join(workspaceRoot, "package.json"), "utf8")) as PackageJson;
const packageName = assertString(rootPackage.name, "package.json name");
const version = assertString(rootPackage.version, "package.json version");
const shortSha = resolveShortSha();
const buildLabel = `v${version}-${shortSha}`;

await rm(outDir, { force: true, recursive: true });
await mkdir(outDir, { recursive: true });

const extensionDirectory = join(workspaceRoot, "packages", "extension", ".output", "chrome-mv3");
const dependencyLicenseReportPath = join(workspaceRoot, "docs", "compliance", "dependency-license-report.md");
const packageEntries = [
  join(workspaceRoot, "LICENSE"),
  join(workspaceRoot, "README.md"),
  join(workspaceRoot, "package.json"),
  join(workspaceRoot, "pnpm-lock.yaml"),
  join(workspaceRoot, "pnpm-workspace.yaml"),
  join(workspaceRoot, "packages", "agent-server", "package.json"),
  join(workspaceRoot, "packages", "agent-server", "dist"),
  join(workspaceRoot, "packages", "browser", "package.json"),
  join(workspaceRoot, "packages", "browser", "dist"),
  join(workspaceRoot, "packages", "browser", "patches"),
  join(workspaceRoot, "packages", "extension", "package.json"),
  extensionDirectory,
  join(workspaceRoot, "packages", "shared", "package.json"),
  join(workspaceRoot, "packages", "shared", "dist"),
  dependencyLicenseReportPath
];

await assertFile(dependencyLicenseReportPath);
await assertDirectory(extensionDirectory);
await assertDirectory(join(workspaceRoot, "packages", "agent-server", "dist"));
await assertDirectory(join(workspaceRoot, "packages", "browser", "dist"));
await assertDirectory(join(workspaceRoot, "packages", "shared", "dist"));

const extensionZip = join(outDir, `${packageName}-extension-chrome-mv3-${buildLabel}.zip`);
await createZip(
  extensionZip,
  await collectZipSources(extensionDirectory, "")
);

const workspaceZip = join(outDir, `${packageName}-workspace-${buildLabel}.zip`);
const workspaceSources = (
  await Promise.all(packageEntries.map((entry) => collectPackageEntry(entry, packageName)))
).flat();
await createZip(workspaceZip, workspaceSources);

const artifacts = [
  await describeArtifact(extensionZip, outDir),
  await describeArtifact(workspaceZip, outDir)
];

const manifest = {
  artifacts,
  cleanRoom: {
    chromiumSourceVendored: false,
    dependencyLicenseReport: true,
    policy: "Release artifacts are generated from this repository's own build outputs."
  },
  commit: process.env.GITHUB_SHA ?? null,
  generatedAt: new Date().toISOString(),
  name: packageName,
  ref: process.env.GITHUB_REF_NAME ?? null,
  version
};

const manifestPath = join(outDir, `${packageName}-manifest-${buildLabel}.json`);
await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
artifacts.push(await describeArtifact(manifestPath, outDir));

const notesPath = join(outDir, `${packageName}-release-notes-${buildLabel}.md`);
await writeFile(notesPath, formatReleaseNotes(packageName, version, artifacts), "utf8");

console.log(`Packaged ${artifacts.length} release artifacts in ${relativePath(workspaceRoot, outDir)}:`);
for (const artifact of artifacts) {
  console.log(`- ${artifact.name} (${artifact.size} bytes, sha256 ${artifact.sha256})`);
}

function readArgValue(name: string): string | undefined {
  const inline = process.argv.find((arg) => arg.startsWith(`${name}=`));
  if (inline) {
    return inline.slice(name.length + 1);
  }

  const index = process.argv.indexOf(name);
  if (index >= 0) {
    return process.argv[index + 1];
  }

  return undefined;
}

function assertString(value: unknown, label: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(`${label} must be a non-empty string.`);
  }

  return value;
}

function resolveShortSha(): string {
  const sha = process.env.GITHUB_SHA;
  if (sha && /^[0-9a-f]{7,40}$/i.test(sha)) {
    return sha.slice(0, 12);
  }

  return "local";
}

async function assertDirectory(path: string): Promise<void> {
  const info = await stat(path).catch(() => undefined);
  if (!info?.isDirectory()) {
    throw new Error(`Required build directory is missing: ${relativePath(workspaceRoot, path)}`);
  }
}

async function assertFile(path: string): Promise<void> {
  const info = await stat(path).catch(() => undefined);
  if (!info?.isFile()) {
    throw new Error(`Required release file is missing: ${relativePath(workspaceRoot, path)}. Run pnpm license:report before packaging.`);
  }
}

async function collectPackageEntry(path: string, packageName: string): Promise<ZipSource[]> {
  if (!(await fileExists(path))) {
    return [];
  }

  const archiveRoot = join(packageName, relativePath(workspaceRoot, path));
  const info = await stat(path);
  if (info.isDirectory()) {
    return collectZipSources(path, archiveRoot);
  }

  return [{ archivePath: archivePath(archiveRoot), sourcePath: path }];
}

async function collectZipSources(root: string, archiveRoot: string): Promise<ZipSource[]> {
  const entries = await readdir(root, { withFileTypes: true });
  entries.sort(compareDirents);

  const files: ZipSource[] = [];
  for (const entry of entries) {
    const sourcePath = join(root, entry.name);
    const nestedArchivePath = archivePath(archiveRoot, entry.name);

    if (entry.isDirectory()) {
      files.push(...await collectZipSources(sourcePath, nestedArchivePath));
    } else if (entry.isFile()) {
      files.push({
        archivePath: nestedArchivePath,
        sourcePath
      });
    }
  }

  return files;
}

function compareDirents(left: Dirent, right: Dirent): number {
  return left.name.localeCompare(right.name, "en");
}

function archivePath(...parts: string[]): string {
  return parts
    .filter((part) => part.length > 0)
    .join("/")
    .replaceAll("\\", "/")
    .replace(/^\/+/, "");
}

async function fileExists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

async function createZip(outputPath: string, sources: ZipSource[]): Promise<void> {
  if (sources.length === 0) {
    throw new Error(`Cannot create empty zip archive: ${outputPath}`);
  }

  const fileParts: Buffer[] = [];
  const centralDirectoryParts: Buffer[] = [];
  let offset = 0;

  for (const source of sources) {
    const data = await readFile(source.sourcePath);
    if (data.length > 0xffffffff) {
      throw new Error(`File is too large for this release zip writer: ${source.sourcePath}`);
    }

    const nameBuffer = Buffer.from(source.archivePath, "utf8");
    const modified = await stat(source.sourcePath);
    const { date, time } = toDosDateTime(modified.mtime);
    const crc = crc32(data);
    const localHeader = Buffer.alloc(30);
    localHeader.writeUInt32LE(0x04034b50, 0);
    localHeader.writeUInt16LE(10, 4);
    localHeader.writeUInt16LE(0, 6);
    localHeader.writeUInt16LE(0, 8);
    localHeader.writeUInt16LE(time, 10);
    localHeader.writeUInt16LE(date, 12);
    localHeader.writeUInt32LE(crc, 14);
    localHeader.writeUInt32LE(data.length, 18);
    localHeader.writeUInt32LE(data.length, 22);
    localHeader.writeUInt16LE(nameBuffer.length, 26);
    localHeader.writeUInt16LE(0, 28);
    fileParts.push(localHeader, nameBuffer, data);

    const centralHeader = Buffer.alloc(46);
    centralHeader.writeUInt32LE(0x02014b50, 0);
    centralHeader.writeUInt16LE(20, 4);
    centralHeader.writeUInt16LE(10, 6);
    centralHeader.writeUInt16LE(0, 8);
    centralHeader.writeUInt16LE(0, 10);
    centralHeader.writeUInt16LE(time, 12);
    centralHeader.writeUInt16LE(date, 14);
    centralHeader.writeUInt32LE(crc, 16);
    centralHeader.writeUInt32LE(data.length, 20);
    centralHeader.writeUInt32LE(data.length, 24);
    centralHeader.writeUInt16LE(nameBuffer.length, 28);
    centralHeader.writeUInt16LE(0, 30);
    centralHeader.writeUInt16LE(0, 32);
    centralHeader.writeUInt16LE(0, 34);
    centralHeader.writeUInt16LE(0, 36);
    centralHeader.writeUInt32LE(0, 38);
    centralHeader.writeUInt32LE(offset, 42);
    centralDirectoryParts.push(centralHeader, nameBuffer);

    offset += localHeader.length + nameBuffer.length + data.length;
  }

  const centralDirectory = Buffer.concat(centralDirectoryParts);
  const endRecord = Buffer.alloc(22);
  endRecord.writeUInt32LE(0x06054b50, 0);
  endRecord.writeUInt16LE(0, 4);
  endRecord.writeUInt16LE(0, 6);
  endRecord.writeUInt16LE(sources.length, 8);
  endRecord.writeUInt16LE(sources.length, 10);
  endRecord.writeUInt32LE(centralDirectory.length, 12);
  endRecord.writeUInt32LE(offset, 16);
  endRecord.writeUInt16LE(0, 20);

  await writeFile(outputPath, Buffer.concat([...fileParts, centralDirectory, endRecord]));
}

function toDosDateTime(date: Date): { date: number; time: number } {
  const year = Math.max(date.getFullYear(), 1980);
  return {
    date: ((year - 1980) << 9) | ((date.getMonth() + 1) << 5) | date.getDate(),
    time: (date.getHours() << 11) | (date.getMinutes() << 5) | Math.floor(date.getSeconds() / 2)
  };
}

function crc32(data: Buffer): number {
  let crc = 0xffffffff;
  for (const byte of data) {
    crc = crcTable[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

async function describeArtifact(path: string, root: string): Promise<ArtifactInfo> {
  const data = await readFile(path);
  return {
    name: relativePath(root, path),
    path: relativePath(workspaceRoot, path),
    sha256: createHash("sha256").update(data).digest("hex"),
    size: data.length
  };
}

function formatReleaseNotes(packageName: string, version: string, artifacts: ArtifactInfo[]): string {
  return [
    `# ${packageName} v${version}`,
    "",
    "Generated release package.",
    "",
    "## Artifacts",
    "",
    ...artifacts.map((artifact) => `- \`${artifact.name}\` (${artifact.size} bytes, sha256 \`${artifact.sha256}\`)`),
    "",
    "## Notes",
    "",
    "- Chromium source is not vendored in these archives.",
    "- Run the repository validation workflow before publishing these assets."
  ].join("\n");
}

function relativePath(from: string, to: string): string {
  return relative(from, to).replaceAll("\\", "/");
}
