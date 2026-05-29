# Clean-Room Source Log

This project is MIT licensed. It may learn from public product behavior and architecture descriptions, but implementation must be original.

## Allowed References

| Date | Source | Use | Notes |
| --- | --- | --- | --- |
| 2026-05-28 | `https://github.com/browseros-ai/BrowserOS` README | Product-level feature inventory and high-level architecture categories | No source files, patches, implementation code, or file contents are copied. |
| 2026-05-28 | `https://github.com/browseros-ai/BrowserOS/blob/main/LICENSE` | License risk assessment | Upstream is AGPL-3.0, so this repository must not copy or adapt upstream source expression. |
| 2026-05-28 | Chromium public documentation | Browser build and extension platform research | Use original scripts and owned patches only. |
| 2026-05-28 | Chrome Extensions documentation | Side panel, scripting, storage, and tab APIs | Used for API behavior, not copied examples. |

## Disallowed Inputs

- Upstream browser-agent source files.
- Upstream Chromium patches.
- Upstream build scripts.
- Upstream UI source, CSS, text, icons, or asset files.
- Upstream package names, internal path names, comments, or proprietary identifiers.
- Mechanical rewrites of upstream code.

## Process

1. Convert reference observations into behavior-level notes in `behavior-spec.md`.
2. Implement from public platform APIs, standards, and this repository's own design.
3. Keep implementation notes in `implementation-notes.md`.
4. For Chromium changes, add an owned patch entry under `packages/browser/patches/manifest.json`.
5. Run `pnpm clean-room:check`, `pnpm license:check`, and `pnpm --filter @open-agent-browser/browser check:patches` before merging changes.
6. For any commercial release, get legal review before distribution.
