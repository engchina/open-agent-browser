# MVP Architecture

## Components

| Component | Responsibility |
| --- | --- |
| Extension side panel | User task entry, plan display, approvals, active-tab tool execution, local memory review |
| Extension new tab | Agent connectivity status, provider mode, resolved endpoint, side-panel/options launch actions |
| Extension browser tools | Page snapshot capture and publishing, safe extraction, guarded browser actions |
| Agent server | Loopback HTTP/WebSocket API, schema validation, SQLite-backed page snapshots, task state, task artifacts, provider calls, approval tokens, audit log, memory persistence |
| Shared package | Public TypeScript contracts and validation schemas |
| Browser package | Chromium checkout plan, owned patch manifest, dev profile launcher, build orchestration |

## Data Flow

1. User enters a task in the side panel.
2. Side panel reads `GET /health` to show local agent reachability and redacted provider state.
3. Extension captures an active-tab snapshot and applies the selected context policy.
4. Extension publishes the policy-trimmed snapshot to `POST /v1/page/snapshot`, keeping it in the local server's SQLite-backed snapshot store.
5. Extension calls `POST /v1/chat` on the loopback server with the user task, `contextPolicy`, and policy-trimmed `pageSnapshot`.
6. Server reads confirmed local memories as bounded user preference context.
7. Server builds a guarded task run and returns a local or provider-generated message plus approval requests.
8. If a configured provider proposes additional browser tool calls, the server validates the proposal against the shared schemas, ignores invalid entries, de-duplicates existing local steps, and applies the same high-risk approval rules.
9. The side panel automatically runs currently pending safe read-only steps, and asks the server to validate each `POST /v1/tools/execute` call.
10. If the server returns `queued`, the extension executes the browser action.
11. Extension reports completed tool results to `POST /v1/tasks/{taskId}/tool-results`, and the server updates step/task status.
12. The server creates local task artifacts for reusable outputs such as extracted links, extracted text, page snapshots, screenshot metadata, and agent-generated JSON/text output.
13. If the task reaches a completed observation point, a provider is configured, and the provider-generated step budget is still available, the server may ask the provider for a bounded continuation over the persisted task/tool observations.
14. Provider continuation may return text or additional `toolCalls`; additional calls are validated, marked as `provider-continuation`, appended to the task plan, and high-risk calls return approval requests in the same tool-result response.
15. If the updated plan unlocks or appends safe pending steps, the side panel continues them automatically up to a bounded local step limit; the server also caps provider-generated continuation steps with `OAB_MAX_PROVIDER_CONTINUATION_STEPS`.
16. If a task is complete and the result can be interpreted locally, the server returns a continuation message and persists it as task output.
17. If the server returns `requires_approval`, the UI waits for the user to approve before executing that tool.
18. If the user rejects an approval, the extension calls `POST /v1/approvals/reject`; the server consumes the token, records a rejected tool result, and the browser action is not executed.
19. User memory writes use the same human-control pattern: request a pending write, then confirm before SQLite persistence.
20. The side panel keeps a local WebSocket connected to `WS /v1/events` and merges task/audit updates into the History, Audit, and active Plan views.
21. The History view can fetch a task by ID, expand its plan/results/output/artifacts, copy, download, or delete artifacts, delete complete task history records, and resume pending safe steps in the Chat view.
22. The new tab page reads the same local agent configuration, shows the current agent/provider status, and exposes launch actions for the side panel and options page.
23. A task entered on the new tab is saved as a one-time launch draft; the side panel consumes it on load and pre-fills the task composer without auto-submitting.
24. A browser context menu click on a page, selected text, or link can also save a one-time side panel draft. It opens the side panel for review, but does not submit the task automatically.
25. The browser address bar exposes the `agent` keyword. Address-bar input creates the same one-time side panel draft for review, using the active tab URL as optional context.
26. Browser keyboard commands can open the side panel or create a current-page summary draft. They use the same review-first launch draft path.
27. The user can cancel a pending, running, or blocked task; the server marks unfinished steps canceled, revokes outstanding approval tokens for that task plan, publishes the task update, and rejects any later tool result report for that task.
28. The user can stop all currently active tasks from History; the server bulk-cancels pending, running, and blocked tasks, revokes outstanding approval tokens for those task plans, and publishes each canceled task update.

## Public API

- `GET /health`
- `GET /v1/provider-config`
- `PUT /v1/provider-config`
- `POST /v1/provider-config/test`
- `POST /v1/chat`
- `POST /v1/approvals/reject`
- `POST /v1/tools/execute`
- `GET /v1/audit-events`
- `GET /v1/tasks`
- `GET /v1/tasks/{taskId}`
- `POST /v1/tasks/cancel-all`
- `DELETE /v1/tasks/{taskId}`
- `GET /v1/tasks/{taskId}/artifacts`
- `DELETE /v1/tasks/{taskId}/artifacts/{artifactId}`
- `POST /v1/tasks/{taskId}/cancel`
- `POST /v1/tasks/{taskId}/tool-results`
- `GET /v1/page/snapshot`
- `POST /v1/page/snapshot`
- `DELETE /v1/page/snapshot`
- `GET /v1/memory`
- `POST /v1/memory`
- `DELETE /v1/memory/{memoryId}`
- `WS /v1/events`

`POST /v1/chat` accepts `{tabId, message, contextPolicy, pageSnapshot?}`. If `pageSnapshot` is present, the server treats it as untrusted page data and uses it only for summary/planning context. If no provider is configured, the server returns a deterministic local snapshot summary.

Configured providers may return either plain text or a JSON object containing `{message, toolCalls}`. Provider `toolCalls` are untrusted proposals: the server assigns its own IDs, validates the tool name and args against `packages/shared`, ignores invalid entries, marks accepted steps as either `provider-plan` or `provider-continuation`, and sends high-risk proposals through the approval registry before the extension can execute them.

The side panel currently exposes three context policies before each chat request: `visible-text`, `interactive-elements`, and `full-snapshot`. The selected policy is applied before snapshot publish and before chat, and `/v1/chat` applies it again server-side before planning or provider use. `visible-text` strips links, element metadata, heading outlines, and table summaries, so local snapshot reads reflect the same data boundary the provider prompt receives.

Snapshot sanitization preserves non-secret interaction hints such as field names, accessible labels, placeholders, autocomplete values, roles, and input types so page understanding can identify form controls. Captured input values and secret-like attribute values are redacted before they can enter task history or provider prompts.

When the side panel is opened with a `tabId` query parameter, it uses that tab for snapshot capture and tool execution. This keeps extension-page smoke tests and development entry points aligned with the active-page behavior of the real side panel.

All local API routes apply a browser Origin guard before routing. Requests without an `Origin` header are accepted for local CLI/test clients, extension origins are accepted automatically, and ordinary web page origins are rejected unless they are explicitly listed in `OAB_ALLOWED_ORIGINS`.

`GET /health` returns `{status, provider, providerSource}`. Provider details are redacted with the same schema used by `GET /v1/provider-config`, and the side panel uses this response to show connected, checking, or offline state.

`POST /v1/page/snapshot` accepts a sanitized `PageSnapshot`, applies server-side sanitization again, stores it in local SQLite when available, and records a metadata-only audit event. `GET /v1/page/snapshot?tabId=...` returns the latest published snapshot for that tab, while `GET /v1/page/snapshot` returns the latest snapshot overall.

`DELETE /v1/page/snapshot?tabId=...` clears the saved snapshot for that tab and clears the global latest pointer when it points to the same tab. `DELETE /v1/page/snapshot` clears all saved snapshots. Both forms return `{cleared}` and write `page.snapshot.cleared` audit metadata without copying page text or DOM content into the audit log. The side panel exposes this as a local page-context clear action near the context policy selector.

The `getPageSnapshot` browser tool honors its capture options before sanitization. `includeLinks=false` removes the link list and anchor elements from the snapshot, and `includeInputs=false` removes input/select/textarea elements while leaving other controls such as buttons available for page understanding.

Snapshot capture derives accessible labels from `aria-label`, `aria-labelledby`, associated `<label>` elements, wrapping labels, titles, alt text, and placeholders, then exposes those labels as sanitized element metadata for local planning and provider prompts.

Snapshot capture also extracts a bounded heading outline and bounded HTML table summaries. The shared snapshot contract stores table captions, headers, rows, and replayable table selectors so local summaries and provider prompts can reason over structured page content without relying only on flattened body text.

Snapshot elements include replayable CSS selectors for browser tools. Selector generation prefers stable IDs, then unique `name` attributes, then parent-scoped `nth-of-type` paths so anonymous controls can still be clicked without relying on global collection indexes.

Snapshot capture omits hidden, inert, and aria-hidden controls from actionable element metadata. Extension-side click and type execution also rejects hidden, disabled, or non-editable targets even if a direct selector reaches `/v1/tools/execute`.

`POST /v1/tasks/{taskId}/tool-results` accepts `{stepId, toolCallId, result}` and records the browser-side result against the task run. The reported step ID, tool call ID, and result tool name must match the task plan before state changes are persisted, and the result status must be a terminal browser execution outcome such as `completed`, `error`, or `rejected`; mismatches and non-terminal statuses return `400`. It returns `{task, continuation?}`. This is the audit boundary between server-approved intent and extension-executed browser actions.

Completed tool results can create local task artifacts. `extractLinks` creates JSON link artifacts, `extractText` creates text artifacts, `getPageSnapshot` creates JSON snapshot artifacts, and `screenshot` creates JSON screenshot metadata artifacts with raw image data redacted before persistence. When the server persists a deterministic or provider continuation output, it also creates an `agent-output` artifact as JSON when parseable or plain text otherwise. Artifact creation audit events include IDs, kinds, MIME types, byte lengths, and source metadata, but not artifact content.

`GET /v1/tasks/{taskId}/artifacts` returns `{artifacts}` for local task review and export. `DELETE /v1/tasks/{taskId}/artifacts/{artifactId}` removes one derived artifact without deleting the task run or original tool result. The side panel renders these artifacts in the History detail view and offers local copy, download, and delete controls.

`POST /v1/tasks/{taskId}/cancel` accepts `{reason?}` and returns `{task}`. Active pending, running, and blocked steps become `canceled`; already completed or failed steps keep their status. Outstanding approval tokens whose tool call IDs appear in that task plan are revoked before the response is returned. The server writes `task.canceled` audit metadata including a revoked approval count, and later `/tool-results` reports for the canceled task return `400`.

`POST /v1/tasks/cancel-all` accepts `{reason?}` and returns `{tasks, canceledTaskCount, revokedApprovalCount}`. It cancels every pending, running, or blocked task, leaves terminal tasks unchanged, revokes outstanding approval tokens for every canceled plan, and publishes each canceled task over `WS /v1/events`. Its `tasks.canceled` audit payload contains task IDs, counts, optional reason, and revoked approval count only.

`DELETE /v1/tasks/{taskId}` deletes the local task run, stored tool results, task output, and derived artifacts. It also revokes outstanding approval tokens whose tool call IDs appear in the deleted plan. The response includes deleted result/artifact counts and revoked approval count. The audit event records task ID, status, plan/result/artifact counts, and revoked approval count only; it does not copy task messages, tool results, artifact content, page text, or provider output.

`POST /v1/tools/execute` accepts the public shape `{toolName, args, confirmationToken?}` plus optional `tabId` and optional internal `id`. If no ID is provided, the server generates one before audit logging, validation, and approval handling. High-risk calls still return `requires_approval` until the reviewed tool name, tab, and validated arguments are resubmitted with the matching confirmation token before its local expiry time.

When provider continuation appends high-risk follow-up steps, the response also includes `approvalRequests`. The side panel merges those requests into the Review UI, shows the local expiry time, and still waits for the server to return `queued` before executing any browser action. When the configured provider continuation budget is exhausted, `/tool-results` returns a stop continuation message, persists it as task output, and skips another provider call.

The Review UI renders a shared redacted approval summary for every risky tool call. Users can inspect the risk label, destination URL, current URL, origin-change summary, selector, text preview, or key before approving, while password/token/secret/card-like values are displayed as `[redacted]`. Ordinary reviewed clicks are shown as medium risk; cross-origin navigation, submit, send, download, login, payment, purchase, delete, and account-changing actions are highlighted as high risk.

Provider-proposed approval reasons are not trusted as the primary safety explanation. When a provider supplies a `reason`, the server keeps the local safety reason first and appends the provider text only as a `Provider note`, so a model cannot downgrade or hide sensitive click, navigation, download, or typing risk in the approval card.

When the planner can identify a submit control from the sanitized snapshot, it includes the control text or accessible label plus selector in the click approval description, so approval is tied to a reviewable page target rather than only a generic action name.

When the user asks to click a named page control, the planner can match visible button/link-like snapshot elements by their text, accessible label, value, or name, then create a guarded `click` call with the matched selector. Sensitive labels such as send, submit, payment, purchase, delete, or download are classified as high risk and stay behind the same approval-token flow.

Screenshot results are summarized before task-history persistence. The extension can use the raw `data:image/png;base64,...` result for the current execution, including full-page screenshots stitched from local scroll captures, but the server stores only redacted screenshot metadata in SQLite-backed task results.

`POST /v1/approvals/reject` accepts `{approvalId, token, taskId?, stepId?, toolCallId?, reason?}`. A valid rejection consumes the pending approval token, returns a `rejected` tool result, writes `approval.rejected`, and updates the referenced task step to failed when task identifiers are supplied. Tool call mismatches, expired approval tokens, partial task context, task misses, and step/tool mismatches are rejected before token consumption or rejection audit writes, so a malformed rejection cannot invalidate the user's pending approval.

`GET /v1/tasks/{taskId}` returns `{task}` for task detail views. The side panel uses this to reopen prior tasks, inspect tool results, and resume any safe pending tool steps without re-planning.

For the MVP acceptance case "summarize this page and extract all links", `/v1/chat` returns the page-aware summary and a safe `extractLinks` step. After the extension reports the link extraction result, the server persists deterministic link JSON as task output.

For the MVP acceptance case "open a URL and extract pricing as JSON", the server plans a guarded `navigate` call, unlocks a safe `getPageSnapshot` step after navigation completes, then generates deterministic JSON from structured pricing tables first, with text parsing as a fallback. Pricing JSON mode requires an explicit structured/JSON output request so a URL path such as `/pricing` does not accidentally add pricing extraction to a link-only task.

For the MVP acceptance case "fill a test form with name and email", the server can plan guarded `type` calls for name/email fields and a separate guarded `click` call for submit. The extension must not submit the form until the submit tool call is approved by the local server.

For page-changing approvals, locally planned `click`, `type`, and `press` calls carry the page URL captured at planning time. The extension checks that URL immediately before executing the reviewed action, so an approval card left open across navigation cannot authorize the same selector or key press on a different page.

The extension executes approved `type` calls through the page's native input/textarea value setter and dispatches input/change events. This keeps simple forms and framework-controlled inputs aligned with the reviewed typed value.

For browser-control tasks, the server can plan local `scroll` and visible/full-page `screenshot` steps without approval, while `press` remains guarded because it can trigger shortcuts or form submission on the active element.

For tab-control tasks, the server can plan `listTabs` to return current-window tab IDs, titles, URLs, indexes, window IDs, and active state. It can plan `activateTab` only when the user provides an explicit tab ID. Both tools are safe local actions after server-side schema validation because they do not mutate remote page state.

The server can also plan `openTab` for explicit new-tab URL requests and `closeTab` for explicit tab ID close requests. Both are high-risk local browser actions: `openTab` can leave the current site or trigger authentication/download flows, and `closeTab` can discard unsaved page state. They must pass the same approval-token flow as other risky tools before the extension invokes Chrome's tabs API.

The server can plan `downloadUrl` for explicit URL download requests. Downloads are high-risk because they write files locally and can expose private URLs in browser download history, so the extension invokes Chrome's downloads API only after the reviewed tool call is approved and the server returns `queued`.

When an extension-side browser tool throws after the server has accepted the dispatch, the side panel reports a terminal `error` result to the task store. This makes the failed step, error message, and audit-linked dispatch visible in task history instead of leaving the run in a misleading pending or running state.

Task runs, task cancellation state, tool results, audit events, confirmed memory records, provider settings, and latest page snapshots are persisted in SQLite. Set `OAB_SQLITE_PATH` to choose the database location.

`GET /v1/memory` returns confirmed local memories. `POST /v1/memory` with `{content, tags}` returns a pending write and `status: "requires_approval"`; `POST /v1/memory` with `{confirmToken}` persists that pending write.

`DELETE /v1/memory/{memoryId}` deletes one confirmed local memory and returns `{deleted, memoryId}`. The audit event stores only the memory ID and tags, not the memory content, so users can remove stale preferences without expanding audit payloads.

Confirmed memories are included in `/v1/chat` planning and provider prompts as bounded preference/project context. Chat plan audit events record the task ID, provider source, plan step count, approval count, and memory count; they do not duplicate memory content.

Provider configuration is persisted in SQLite through `PUT /v1/provider-config`. Environment variables still take precedence when `OAB_PROVIDER` is set. `GET /v1/provider-config` returns redacted API keys only.

`POST /v1/provider-config/test` accepts a provider config payload, sends a short connectivity prompt to that provider, and returns `{ok, message, config}` with the config redacted. It does not save the submitted config.

`WS /v1/events` is a loopback WebSocket stream for realtime local UI updates. It emits:

- `hello`: connection acknowledgement with a connection ID and timestamp.
- `task`: current task run state after task creation or tool-result updates.
- `audit`: newly appended audit events, using the same metadata boundaries as the persisted audit log.

The side panel shows a compact live status indicator for this stream. If connected, task and audit views update without requiring a manual refresh.

The WebSocket upgrade path uses the same Origin guard as HTTP APIs.

The extension and server communicate only through these contracts.

## Development Browser Launcher

`pnpm dev:browser` creates a local browser run without touching the user's normal profile:

- builds the extension first,
- writes `open-agent-config.json` into the built extension output with the selected loopback agent URL,
- starts the loopback agent server when needed,
- loads `packages/extension/.output/chrome-mv3`,
- uses `.local/browser-profile`,
- opens `OAB_BROWSER_START_URL` or `chrome://newtab/` so the first screen is the extension's agent-aware launch panel.

The launcher first honors `OAB_BROWSER_EXECUTABLE`, then searches the owned Chromium build output selected by `OAB_CHROMIUM_BUILD_DIR`, then common Chrome, Chromium, and Edge install paths, and finally PATH search. This lets `pnpm dev:browser` move onto the external Chromium fork automatically after `build:chromium` produces a browser executable.

The extension resolves its agent URL in this order:

- explicit `chrome.storage.local.agentBaseUrl` saved from Options,
- packaged `open-agent-config.json` generated by the dev launcher,
- built-in default `http://127.0.0.1:17376`.

## Chromium Patch Workflow

Chromium source remains outside this repository. Owned patches live under `packages/browser/patches` and must be listed in `packages/browser/patches/manifest.json`.

`pnpm --filter @open-agent-browser/browser check:patches` verifies:

- every manifest entry has an owned patch file,
- patch paths stay inside the managed patch directory,
- patch IDs are unique,
- each patch points back to a clean-room behavior spec.

`pnpm --filter @open-agent-browser/browser plan:chromium` prints the external checkout layout, patch application plan, and GN/Ninja command plan without downloading or modifying Chromium source.

`pnpm --filter @open-agent-browser/browser check:chromium` reports readiness for:

- external `depot_tools`,
- concrete `gclient`, `gn`, and `autoninja` entrypoints under external `depot_tools`,
- external `chromium/src`,
- `.gclient`,
- `chromium/src/BUILD.gn`,
- the owned patch manifest.

It also reports clean-room provenance for present external workspace files. The generated `.gclient` repository URL and the checkout's `remote.origin.url` must match the configured Chromium source repository (`OAB_CHROMIUM_REPOSITORY_URL` or the default public Chromium repository); mismatches fail the check before patch or build commands should be trusted.

`pnpm --filter @open-agent-browser/browser configure:chromium` writes the external `.gclient` file for the Chromium source solution. It creates only the ignored external workspace config and does not run `gclient sync`, download Chromium source, apply patches, or vendor third-party source into this repository.

`bootstrap:depot-tools` clones or updates Chromium's `depot_tools` inside the ignored external workspace. It can scope a Git TLS backend override through `OAB_GIT_SSL_BACKEND` without changing global Git config. `bootstrap:cipd-client` is a Windows-friendly fallback for environments where the `depot_tools` PowerShell bootstrapper cannot download CIPD: it reads the public `cipd_client_version` metadata from the external checkout, downloads only the matching CIPD client into ignored `depot_tools`, verifies the published SHA256 digest before replacing the file, and prepares Windows `cipd.exe` aliases for PATH and vpython's `.cipd_bin` bundle directory. `sync:chromium`, `gen:chromium`, and `build:chromium` run the planned `gclient sync`, `gn gen`, and `autoninja -C ... chrome` commands against that same external workspace. They print the exact command and external `depot_tools` path first, support `--dry-run`/`OAB_CHROMIUM_DRY_RUN=1`, prepend the external `depot_tools` and `.cipd_bin` directories to PATH for the child process, default vpython cache state to `external/chromium/vpython-root`, and pass the same scoped Git TLS override to git subprocesses spawned by `gclient`.

`patches:check-apply` runs `git apply --check` for active owned patches against the external checkout. `patches:apply` applies those active patches only when explicitly invoked. Planned patch placeholders are tracked in the manifest but skipped by the apply plan.

## License Reporting

`pnpm license:check` fails the build when installed pnpm package metadata includes missing licenses, AGPL/GPL/LGPL-only licenses without a permissive alternative, or forbidden upstream browser-agent package names.

`pnpm license:report` writes `docs/compliance/dependency-license-report.md`, including package name, version, license metadata, and package metadata path for every installed pnpm package found under `node_modules/.pnpm`.

## End-to-End Smoke

`pnpm smoke:e2e` verifies the current browser loop in a real extension runtime:

- starts an in-memory local agent server,
- serves a local HTML fixture,
- launches a Chromium-compatible browser through `playwright-core`,
- loads the built MV3 extension,
- verifies a normal web page origin is blocked from the loopback API,
- verifies the extension new tab launch panel sees the same local agent endpoint and connected provider state,
- verifies a new tab task draft is consumed by the side panel composer,
- checks `/health` through the extension API client,
- captures and publishes the fixture tab snapshot from the extension page,
- reads the same snapshot back from `/v1/page/snapshot`,
- verifies scoped `getPageSnapshot` calls can omit links and inputs before extension-side execution returns a snapshot,
- verifies sensitive text and URL query values are redacted from captured snapshots,
- verifies accessible label capture for form controls,
- verifies structured heading and table capture,
- verifies replayable snapshot selectors for anonymous controls,
- verifies semantic high-risk click planning from a named visible snapshot control,
- verifies hidden controls are omitted from actionable snapshots and cannot be clicked by direct selector execution,
- verifies stale page approvals are blocked when the tab URL changes before execution,
- verifies tab listing, explicit tab activation, approval-gated tab opening, and approval-gated tab closing through the extension tabs API,
- calls `/v1/chat`,
- executes `extractLinks`,
- reports the result to `/v1/tasks/{taskId}/tool-results`,
- verifies deterministic link JSON is returned as continuation output,
- approves a guarded navigation to the local pricing fixture, captures a structured page snapshot, and verifies a pricing JSON continuation from table rows,
- verifies requested navigation gates later link extraction until the navigation completes,
- verifies cross-site navigation approvals include local source-page context and high-risk classification,
- reads task history and audit events back through the extension API client,
- fetches an individual task detail and task artifacts, opens the side panel History view, and verifies the Details panel renders the selected task, extracted-link artifact, and artifact deletion control,
- verifies the side panel can delete a task history record after artifact review,
- opens the side panel Chat UI against the fixture tab, sends a user task, waits for safe tool execution, and verifies History shows the original user request,
- opens the side panel Chat UI for a form task and verifies approval cards show reviewable selectors and typed values,
- verifies side panel approval cards show the local expiry time for pending approvals,
- opens the side panel Chat UI with a provider continuation task and verifies a provider-appended safe follow-up step is automatically executed by the UI,
- opens the event stream from an extension page and verifies `hello`, task, and audit messages,
- verifies high-risk `type` actions stay blocked without an approval token,
- verifies approved typing updates both ordinary form fields and a controlled-input fixture that only reacts to native setter plus input events,
- verifies provider-proposed safe tool calls are validated by the server and executed by the extension only after the server returns `queued`,
- verifies provider-supplied approval reasons remain notes after the local safety reason for risky actions,
- verifies provider continuation can observe a completed browser tool result, append a safe follow-up tool call, and have the extension execute it only after server validation,
- verifies a name/email form task fills both fields and does not submit until the submit click is approved,
- verifies scroll, key press, and full-page screenshot browser controls in the real extension runtime, including approval gating for `press`,
- verifies raw screenshot data is redacted before task-history persistence,
- verifies explicit approval rejection consumes the token, records a failed task step, and does not mutate the fixture form,
- uses a chat-issued approval token to type into the fixture form and report completion.
- verifies memory writes are not persisted until a confirmation token is submitted.
- verifies confirmed local memories can be deleted and no longer appear in later memory lists.
- starts local fake OpenAI-compatible and Ollama providers, saves those provider configs, checks `/health`, tests them, and verifies `/v1/chat` sends confirmed memory context and uses the configured provider responses.

The smoke uses a temporary browser profile and deletes it after completion.
