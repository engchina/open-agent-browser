# Owned Chromium Patches

This directory is for patches authored in this repository only.

Rules:

- Do not vendor Chromium source here.
- Do not copy patches from other browser-agent projects.
- Keep every patch listed in `manifest.json`.
- Link each patch to a behavior spec under `docs/clean-room/`.
- Run `pnpm --filter @open-agent-browser/browser check:patches` before merging browser patch changes.
- Use `pnpm --filter @open-agent-browser/browser patches:check-apply` to verify active patches against an external checkout.
- Use `pnpm --filter @open-agent-browser/browser patches:apply` only when you explicitly want to apply active patches.
- Use `pnpm --filter @open-agent-browser/browser configure:chromium` to write the external `.gclient` file before manually running Chromium sync commands.

The current MVP can run with an installed Chromium-compatible browser and the extension loaded. Chromium source checkout remains external under `external/chromium` or `OAB_CHROMIUM_ROOT`.
