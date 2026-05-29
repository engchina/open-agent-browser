import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { buildLicenseReport, formatLicenseReport } from "./license-policy.js";

const outputPath = join(process.cwd(), "docs", "compliance", "dependency-license-report.md");
const report = buildLicenseReport(process.cwd(), "generated-by-license-report-script");

mkdirSync(dirname(outputPath), { recursive: true });
writeFileSync(outputPath, formatLicenseReport(report), "utf8");

console.log(`Wrote dependency license report to ${outputPath}.`);
