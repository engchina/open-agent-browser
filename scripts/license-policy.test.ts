import { describe, expect, it } from "vitest";
import {
  checkLicenses,
  formatLicenseReport,
  type ScannedPackage
} from "./license-policy.js";

describe("license policy", () => {
  it("rejects missing, forbidden, and upstream browser-agent package metadata", () => {
    const packages: ScannedPackage[] = [
      {
        license: "UNKNOWN",
        name: "missing-license",
        path: "node_modules/.pnpm/missing-license/package.json",
        version: "1.0.0"
      },
      {
        license: "AGPL-3.0-only",
        name: "copyleft-browser-helper",
        path: "node_modules/.pnpm/copyleft-browser-helper/package.json",
        version: "1.0.0"
      },
      {
        license: "MIT",
        name: ["browser", "os-helper"].join(""),
        path: "node_modules/.pnpm/browser-agent-helper/package.json",
        version: "1.0.0"
      }
    ];

    const violations = checkLicenses(packages);

    expect(violations).toHaveLength(3);
    expect(violations.some((violation) => violation.includes("missing license"))).toBe(true);
    expect(violations.some((violation) => violation.includes("forbidden license"))).toBe(true);
    expect(violations.some((violation) => violation.includes("forbidden package name"))).toBe(true);
  });

  it("allows dual-license expressions when a permissive option is present", () => {
    const violations = checkLicenses([
      {
        license: "MIT OR GPL-3.0-or-later",
        name: "dual-licensed-package",
        path: "node_modules/.pnpm/dual-licensed-package/package.json",
        version: "1.0.0"
      }
    ]);

    expect(violations).toHaveLength(0);
  });

  it("formats a stable markdown report with escaped table cells", () => {
    const report = formatLicenseReport({
      allowedPackageCount: 1,
      generatedAt: "generated-by-test",
      packages: [
        {
          license: "MIT OR Apache-2.0",
          name: "@scope/package",
          path: "node_modules/.pnpm/@scope+package/node_modules/@scope/package/package.json",
          version: "1.2.3"
        }
      ],
      rootLicense: "MIT License",
      violations: []
    });

    expect(report).toContain("Generated: generated-by-test");
    expect(report).toContain("Root license: MIT License");
    expect(report).toContain("Violations: 0");
    expect(report).toContain("| @scope/package | 1.2.3 | MIT OR Apache-2.0 |");
  });
});
