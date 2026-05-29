# open-agent-browser

An open-source, AI-native Chromium browser where local and BYO-LLM agents understand pages, plan tasks, and act on the web with human control, persistent memory, and privacy-first automation.

This repository is built under a clean-room policy. Public projects may be used as product and architecture references, but this codebase must not copy, adapt, or vendor AGPL browser-agent code.

## Workspace

- `packages/shared`: TypeScript schemas, public API types, browser tool validation, page snapshot sanitization, and context-policy trimming.
- `packages/agent-server`: Loopback HTTP/WebSocket API, SQLite-backed page snapshots, provider configuration, approval gates, task history, task artifacts, audit logging, and memory.
- `packages/extension`: WXT + React extension shell for side panel chat/history/audit/memory, an agent-aware new tab launch panel, settings, and browser tool execution.
- `packages/browser`: Chromium checkout/build orchestration scripts and a dev launcher that opens a Chromium-compatible browser with this extension loaded. Chromium source is never vendored in this repository.
- `packages/browser/patches`: Owned Chromium patch manifest and patch files. Patch metadata is verified without vendoring Chromium source.
- `docs/clean-room`: Source log, behavior specs, implementation notes, and originality checklist.
- `docs/architecture`: MVP architecture, threat model, and privacy model.
- `docs/compliance`: Generated dependency license inventory for release review.

## Development

```powershell
pnpm install
pnpm typecheck
pnpm test
pnpm lint
pnpm license:check
pnpm license:report
pnpm smoke:e2e
```

`pnpm lint` also runs the clean-room and license gates. The clean-room gate rejects upstream project names, package scopes, GitHub org names, and known internal path markers outside the provenance source log. The license gate scans the installed pnpm package tree and rejects AGPL/GPL/LGPL-only dependencies or upstream browser-agent package names. `pnpm license:report` writes the current dependency inventory to `docs/compliance/dependency-license-report.md`.

Start the local agent server:

```powershell
pnpm dev:agent
```

Start the extension development build:

```powershell
pnpm dev:extension
```

Launch the current browser MVP with an isolated local profile:

```powershell
pnpm build
pnpm dev:browser
```

The launcher will:

- build the extension into `packages/extension/.output/chrome-mv3`,
- write `open-agent-config.json` into that built extension output so the extension connects to the selected local agent URL by default,
- start the local agent server if `http://127.0.0.1:17376/health` is not already healthy,
- open the owned Chromium build when present, otherwise Chrome, Chromium, or Edge, with `--load-extension`,
- open `chrome://newtab/` by default so the first screen is the agent-aware launch panel,
- use `.local/browser-profile` so normal browser profiles are not modified.

Useful environment variables:

- `OAB_BROWSER_EXECUTABLE`: explicit Chrome/Chromium/Edge executable path. This overrides the owned Chromium build candidate.
- `OAB_BROWSER_START_URL`: first page opened by the dev browser; default `chrome://newtab/`.
- `OAB_BROWSER_PROFILE_DIR`: profile directory for the launched browser.
- `OAB_AGENT_URL`: explicit local agent base URL written into the dev extension runtime config.
- `OAB_AGENT_PORT`: local agent server port, default `17376`.
- `OAB_BROWSER_DRY_RUN=1`: print the launch plan without starting a browser.
- `OAB_SQLITE_PATH`: local agent database path, default `data/open-agent-browser.sqlite`.
- `OAB_ALLOWED_ORIGINS`: comma-separated extra browser origins allowed to call the local API. Extension origins are allowed automatically; ordinary web page origins are blocked by default.
- `OAB_CHROMIUM_ROOT`: external Chromium workspace root, default `external/chromium`.
- `OAB_DEPOT_TOOLS_REPOSITORY_URL`: override for the external `depot_tools` Git repository.
- `OAB_GIT_SSL_BACKEND`: optional per-command Git TLS backend override for `depot_tools` bootstrap and Chromium sync, for example `openssl` on Windows setups where schannel fails.
- `OAB_CIPD_BACKEND_URL`: optional Chromium CIPD client backend override, default `https://chrome-infra-packages.appspot.com`.
- `OAB_CIPD_PLATFORM`: optional CIPD client platform override, for example `windows-amd64`.
- `VPYTHON_VIRTUALENV_ROOT`: optional vpython cache root override; Chromium command wrappers default it to `external/chromium/vpython-root`.
- `VPYTHON_CIPD_PATH`: optional vpython CIPD executable override; Chromium command wrappers default it to the verified external `.cipd_bin/cipd.exe` alias.
- `OAB_CHROMIUM_BUILD_DIR`: Chromium output directory under `src`, default `out/OpenAgentBrowser`.
- `OAB_CHROMIUM_TARGET_CPU`: Chromium GN target CPU override.
- `OAB_CHROMIUM_DEBUG=0`: generate a non-debug Chromium build plan.

Check owned Chromium patch metadata:

```powershell
pnpm --filter @open-agent-browser/browser check:patches
```

Print the clean-room Chromium workspace, patch, and build plan:

```powershell
pnpm --filter @open-agent-browser/browser plan:chromium
pnpm --filter @open-agent-browser/browser check:chromium
```

`check:chromium` also reports external workspace provenance when files are present. The generated `.gclient` repository URL and the checkout's `remote.origin.url` must match the configured Chromium source repository (`OAB_CHROMIUM_REPOSITORY_URL` or the default public Chromium repository). Missing external files are reported as not ready; mismatched origins fail the check.

Create the external `.gclient` file without syncing or vendoring Chromium source:

```powershell
pnpm --filter @open-agent-browser/browser configure:chromium
```

This writes only `external/chromium/.gclient` by default. Use `--force` only when you intentionally want to overwrite an existing external Chromium workspace config.

Clone or update `depot_tools` in the ignored external workspace:

```powershell
pnpm --filter @open-agent-browser/browser bootstrap:depot-tools
```

Download and verify the external `depot_tools` CIPD client when the default `depot_tools` PowerShell bootstrapper cannot reach CIPD:

```powershell
pnpm --filter @open-agent-browser/browser bootstrap:cipd-client
```

The command reads `depot_tools/cipd_client_version` and `depot_tools/cipd_client_version.digests`, downloads only the matching client binary into the ignored external `depot_tools` directory, verifies SHA256 before replacing the file, and prepares Windows `cipd.exe` aliases for PATH and vpython's `.cipd_bin` bundle directory. Use `--dry-run` to print the source URL and expected digest; use `--force` to replace an existing client after a mismatch.

After `depot_tools` is available, the explicit Chromium command wrappers can run against that external checkout:

```powershell
pnpm --filter @open-agent-browser/browser sync:chromium
pnpm --filter @open-agent-browser/browser gen:chromium
pnpm --filter @open-agent-browser/browser build:chromium
```

Use `--dry-run` or `OAB_CHROMIUM_DRY_RUN=1` to print the command wrapper plan without executing `gclient`, `gn`, or `autoninja`.

When `external/chromium/src/out/OpenAgentBrowser/chrome.exe` exists on Windows, or the equivalent built Chromium executable exists on macOS/Linux, `pnpm dev:browser` prefers that owned build before installed system browsers. This keeps local development on the Chromium fork path after a successful `build:chromium`.

If a locked-down Windows shell reports `failed to acquire read lock: Access is denied` from vpython, rerun the same Chromium command from a normal PowerShell session with write access to `external/chromium`. The wrapper already keeps vpython cache state under the ignored external workspace.

Chromium source and `depot_tools` stay outside this repository under `external/` or the path selected by `OAB_CHROMIUM_ROOT`; that directory is ignored by git. The patch manifest prevents untracked or out-of-tree Chromium changes from becoming part of the clean-room workflow. `patches:check-apply` verifies active owned patches against an external checkout with `git apply --check`; `patches:apply` applies them only when explicitly requested.

Provider settings can also be managed from the extension options page. The local agent stores the selected provider in SQLite unless `OAB_PROVIDER` is set, in which case environment variables take precedence.

The options page includes a provider test action. It calls `POST /v1/provider-config/test` with the current form values, sends one short connectivity prompt, and returns a redacted success or failure message without saving the submitted config.

The local agent also exposes `WS /v1/events` for realtime task and audit metadata. It is loopback-local, checks browser request origins, and is implemented without adding a WebSocket dependency.

The side panel connects to this stream and shows a compact live indicator. Task history, audit history, and the active plan are merged from these local events as tool results arrive.

Task history is actionable: the History view can fetch and render task details, including step status, tool results, persisted output, reusable artifacts, and safe pending steps that can be resumed in Chat. A task history record can also be deleted, which removes stored tool results, task output, and derived artifacts while leaving only metadata-only audit.

Task artifacts are local, SQLite-backed outputs generated from terminal tool results and persisted agent output. Extracted links, extracted text, sanitized snapshots, screenshot metadata, and JSON/text agent output can be reviewed, copied, downloaded, or deleted from the side panel History detail. Artifact audit events store metadata only, not artifact content.

Page snapshots expose only visible actionable controls; hidden, inert, or aria-hidden controls are omitted from the selector list. The local planner can map a named click request to a visible matched control from that snapshot, and sensitive controls such as send, submit, payment, purchase, delete, or download stay behind high-risk approval. The extension also refuses to click hidden/disabled targets or type into hidden/non-editable fields even when a direct selector is supplied.

Snapshots redact common sensitive text patterns such as email addresses, bearer tokens, OpenAI-style API keys, likely payment card numbers, and sensitive URL query values before storage or provider prompts.

If a tool is accepted by the server but fails inside the extension, the side panel reports a terminal `error` result back to task history. The failed step is persisted for audit/debugging instead of leaving the server-side task stuck behind a queued dispatch.

Reviewed page-changing actions are also page-bound. Planned `click`, `type`, and `press` calls can carry the page URL seen at approval time; the extension refuses to execute them if the tab navigates before the user approves.

Pending, running, or blocked tasks can also be canceled from the side panel. Canceling marks unfinished steps as `canceled`, revokes outstanding approvals for that task, writes local audit metadata, and prevents late tool results from advancing the task. The History view also has a global `Stop active` control that applies the same cancellation and approval revocation to every active task while leaving terminal task records unchanged.

The local browser tool set now includes tab awareness: `listTabs` returns bounded metadata for tabs in the current window, and `activateTab` can focus an existing tab only when the task includes an explicit tab ID. These actions are validated by the agent server and do not mutate remote page state. New-tab creation and tab closing are available through `openTab` and `closeTab`, but both require approval before the extension calls Chrome's tabs API. Direct URL downloads are available through `downloadUrl`; they also require approval before the extension calls Chrome's downloads API.

The extension new tab page shows local agent connectivity, provider mode, the resolved agent endpoint, and launch actions for the side panel and options page. A task entered on the new tab is handed off as a one-time side panel draft, so the user can review context policy before sending.

The browser context menu can also prepare side panel drafts from the current page, selected text, or a link. These drafts stay in local extension storage and are not submitted until the user sends them from the side panel.

The address bar supports the `agent` keyword. Type `agent summarize this page` or `agent https://example.test` to prepare the same reviewable side panel draft from the active tab context.

The extension also registers browser commands for opening the side panel and drafting a current-page summary task. Defaults are `Alt+Shift+A` for opening the panel and `Alt+Shift+S` for the summary draft; users can change shortcuts in the browser extension shortcut settings.

Run the browser extension smoke test:

```powershell
pnpm smoke:e2e
```

This uses `playwright-core` with an installed Chromium-compatible browser. It launches a temporary profile, loads the built extension, opens a local fixture page, verifies ordinary web page origins cannot fetch the local agent API, checks `/health` through the extension API client, captures and publishes a page snapshot from the extension, reads it back from `/v1/page/snapshot`, verifies scoped `getPageSnapshot` capture options, sensitive text and URL redaction, accessible label capture, structured heading/table capture, replayable snapshot selectors for anonymous controls, semantic high-risk click planning from a named visible control, hidden-control omission and execution blocking, stale page approval blocking, tab listing, explicit tab activation, approval-gated tab opening, approval-gated tab closing, and approval-gated direct downloads, opens `WS /v1/events` from an extension page, calls the local agent server, executes `extractLinks`, reports the result back to the task run, verifies tool-result reports are bound to the planned step/tool call and reject non-terminal execution states, verifies link JSON continuation output and task artifacts, verifies realtime task/audit messages, fetches task detail, verifies the new tab launch panel is connected to the local agent and hands off a task draft to the side panel, opens the side panel History UI and verifies the Details panel, extracted-link artifact, artifact deletion control, and task history deletion, opens the side panel Chat UI against the fixture tab and verifies History shows the original user task, verifies side panel task cancellation controls and the History `Stop active` control, verifies side panel approval cards show reviewable action details, target descriptions, and risk labels, verifies side panel automatic execution of a provider-appended safe follow-up step, verifies side panel tool execution errors are persisted as failed task history, approves guarded navigation to a pricing fixture, verifies structured pricing-table JSON continuation, verifies navigation-gated link extraction, verifies scroll, guarded key press, and full-page screenshot browser controls, verifies raw screenshot data is redacted before task-history persistence, verifies explicit approval rejection without mutating the fixture form, verifies a guarded name/email form fill and keeps submit blocked until a submit approval token is used, verifies approved typing updates a controlled-input fixture, verifies history/audit reads, verifies a memory write is not persisted until confirmed, then verifies local fake OpenAI-compatible and Ollama providers update health, receive confirmed memory context, can test, can drive `/v1/chat`, can propose a validated safe browser tool plan, preserves local safety wording before provider-supplied approval notes, and can continue after a browser observation by appending a validated follow-up tool. The side panel can choose `visible-text`, `interactive-elements`, or `full-snapshot`; the selected policy is applied before the snapshot is published or sent to the agent.

Create local release artifacts:

```powershell
pnpm build
pnpm license:report
pnpm package:release
```

Packaging fails if `docs/compliance/dependency-license-report.md` is missing, so release archives always carry the dependency license inventory used for clean-room review.
