import { describe, expect, it } from "vitest";
import {
  scanContentForForbiddenReferences,
  scanPackageDependencies
} from "./clean-room-policy.js";

describe("clean-room policy", () => {
  it("flags upstream project references outside the provenance log", () => {
    const upstreamName = ["Browser", "OS"].join("");
    const violations = scanContentForForbiddenReferences(
      "packages/extension/entrypoints/sidepanel/App.tsx",
      `const label = "${upstreamName}";`
    );

    expect(violations).toContainEqual({
      match: upstreamName,
      path: "packages/extension/entrypoints/sidepanel/App.tsx",
      rule: "upstream-project-name"
    });
  });

  it("allows upstream references in the source log only", () => {
    const upstreamOrg = ["browser", "os-ai"].join("");
    const violations = scanContentForForbiddenReferences(
      "docs/clean-room/source-log.md",
      `https://github.com/${upstreamOrg}/example`
    );

    expect(violations).toHaveLength(0);
  });

  it("flags upstream package names in manifests", () => {
    const packageName = ["browser", "os-helper"].join("");
    const violations = scanPackageDependencies("package.json", [packageName]);

    expect(violations).toContainEqual({
      match: packageName,
      path: "package.json",
      rule: "forbidden-browser-agent-package"
    });
  });
});
