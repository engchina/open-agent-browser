# Originality Checklist

Use this checklist before merging implementation changes.

- [ ] The change implements behavior from `docs/clean-room/behavior-spec.md` or a new original spec update.
- [ ] No upstream source file, patch, build script, UI text, CSS, icon, asset, or comment was copied.
- [ ] New dependencies do not introduce AGPL obligations or upstream browser-agent packages.
- [ ] New dependency licenses pass `pnpm license:check` or have an explicit documented review note.
- [ ] New browser patches are authored for this repository and documented.
- [ ] New browser patches are listed in `packages/browser/patches/manifest.json` and pass `pnpm --filter @open-agent-browser/browser check:patches`.
- [ ] Risky browser actions still require approval.
- [ ] Snapshot capture redacts sensitive attributes and truncates large content.
- [ ] `pnpm typecheck` passes.
- [ ] `pnpm test` passes.
- [ ] `pnpm lint` passes, including `pnpm clean-room:check`.
- [ ] `pnpm license:check` passes.
