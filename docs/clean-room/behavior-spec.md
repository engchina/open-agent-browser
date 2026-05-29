# Clean-Room Behavior Spec

## Product Intent

Open Agent Browser is a Chromium-based browser experience where a local agent can understand the active page, plan browser actions, and ask for human approval before risky actions.

## MVP Behaviors

- A side panel accepts user tasks in natural language.
- The new tab page shows the local agent status, provider mode, resolved local endpoint, and launch actions for the side panel and options page.
- A task entered on the new tab page is transferred to the side panel as a one-time draft; it is not auto-submitted.
- Browser context menus can create one-time side panel drafts for the current page, a selected text range, or a link target. These drafts are not auto-submitted.
- The browser address bar can expose an agent keyword that creates a one-time side panel draft from the entered task or URL. It is not auto-submitted.
- Browser keyboard commands can open the side panel or create a current-page summary draft. Draft commands are not auto-submitted.
- The side panel shows whether the loopback agent server is reachable and which redacted provider mode is active.
- The extension captures a sanitized page snapshot from the active tab.
- Snapshot elements include replayable CSS selectors so later approved tool calls can target the same page controls.
- Hidden, inert, or aria-hidden controls are omitted from actionable snapshot elements.
- Snapshot captures page structure such as headings and small HTML table summaries so the agent can reason over page outline and tabular content without relying only on flattened text.
- The extension publishes the latest sanitized page snapshot to the local server so the public snapshot API can return real page context.
- The local agent server receives the sanitized snapshot, treats it as untrusted context, and returns a small task plan plus any approval requests.
- If a provider is configured, the server asks the provider for a page-aware response. If no provider is configured, it returns a deterministic local snapshot summary.
- If a provider proposes browser tool calls, the server treats those proposals as untrusted data, validates them against the shared tool schema, removes duplicates, and applies the same approval rules before the extension can execute anything.
- Provider-supplied approval reasons are treated as untrusted notes; they may be shown as provider notes but must not replace the local safety reason for a reviewed browser action.
- Confirmed local memories are available to chat planning and provider prompts as bounded user preference context.
- A task run tracks plan steps and browser tool results so the UI can show execution progress.
- The local server exposes a WebSocket event stream for task and audit updates.
- The local server rejects ordinary browser origins for HTTP and WebSocket APIs by default.
- The side panel consumes the local event stream to keep task history, audit history, and the active plan current.
- The side panel history view can open task details, show step/result/output state, delete task history records, and resume safe pending steps.
- Task history displays the original user request as the task title; agent responses remain chat output.
- A task can return a continuation message after tool results are reported, such as deterministic JSON extracted from structured page snapshots, page text, or extracted links.
- Completed task observations can create local artifacts so extracted links, extracted text, sanitized snapshots, screenshot metadata, and agent output can be reviewed, copied, downloaded, or deleted later.
- After a task step reports a tool result, a configured provider may receive a bounded, sanitized task observation and propose a continuation message or additional browser tool calls.
- Provider-proposed task steps must carry local provenance: initial chat-time proposals are marked as provider-plan steps, and tool-result continuations are marked as provider-continuation steps.
- Provider continuation must stop once the local server reaches its configured provider-generated step budget, even if the provider could keep proposing more safe steps.
- The user can cancel a pending, running, or blocked task from the side panel; cancellation marks unfinished steps canceled, revokes outstanding approval tokens for that task, and prevents later tool results from advancing that task.
- The user can stop all currently active tasks from the side panel History view; this bulk stop cancels pending, running, and blocked tasks, revokes outstanding approval tokens for those task plans, and leaves completed, failed, or already canceled tasks unchanged.
- Safe read-only tools may be executed directly after schema validation.
- The side panel may automatically execute currently pending safe read-only steps after a plan is created.
- The side panel may continue executing newly appended safe read-only follow-up steps, with a bounded automatic step limit to prevent runaway loops.
- After a user approves a high-risk step, newly unblocked safe follow-up steps may run automatically.
- Risky tools require explicit user approval before execution.
- Approval UI must show a reviewable, redacted summary of the action, including the risk level, destination URL, selector, typed text preview, or key where applicable.
- Approval risk labels distinguish ordinary reviewed clicks from sensitive actions such as submit, send, download, login, payment, purchase, delete, and account-changing flows.
- Navigation approval summaries include the current page URL when available, the destination URL, and whether the action leaves the current origin.
- Cross-origin navigation is treated as high risk when current-page context is available.
- Planned click approvals should include known target text, label, and selector from the sanitized snapshot when available, so the user can review the actual page control before approving.
- When a user asks to click a named page control, the local planner may select a visible matching control from the sanitized snapshot and must keep that click behind the approval-token flow.
- Risky approval requests can be explicitly rejected; a valid rejection consumes the approval token, records local audit metadata, and marks the related task step failed when task context is provided.
- Rejection requests that reference a mismatched tool call, incomplete task context, or a step outside the referenced task must fail before consuming the approval token or writing rejection audit metadata.
- Form tasks can plan separate guarded actions for name fields, email fields, and final submit controls.
- Browser-control tasks can plan safe scroll and visible/full-page screenshot steps plus guarded key-press steps from user intent.
- Browser-control tasks can list open tabs in the current window, activate a tab only when the requested tab ID is explicit, and open or close tabs only after human approval.
- Local memory writes are pending by default and only persist after confirmation.
- A side panel memory view lets the user request, confirm, review, and delete local memories.
- Provider configuration supports disabled mode, OpenAI-compatible endpoints, and Ollama.
- Provider configurations can be tested with a short connectivity prompt before or after saving.
- No telemetry leaves the machine by default.
- Chromium fork work uses an external checkout whose `.gclient` repository and checkout origin are checked against the configured Chromium source repository before owned patches are trusted.
- Once an owned Chromium build exists in the external checkout output directory, the development browser launcher should prefer that build over installed system browsers unless the developer explicitly sets `OAB_BROWSER_EXECUTABLE`.

## Browser Tool Set

- `navigate`: open a URL in the current tab. Requires approval.
- `click`: click a selector in the current tab. Requires approval.
- `type`: type into an input or textarea. Requires approval.
- `press`: send a key event to the active element. Requires approval.
- `scroll`: scroll the page. Safe.
- `extractText`: read text from the page or selector. Safe.
- `extractLinks`: read links from the page or selector. Safe.
- `screenshot`: capture the visible tab or, when `fullPage=true`, stitch a full-page screenshot from local scroll captures. Safe for local use, but downstream sharing must be user-controlled.
- `getPageSnapshot`: capture sanitized text, links, and interactive elements. Safe. `includeLinks=false` omits link lists and anchor elements; `includeInputs=false` omits input/select/textarea elements.
- `listTabs`: list open tabs in the current browser window by default. Safe. Returned tab data is limited to tab ID, window ID, index, title, URL, and active state.
- `activateTab`: focus an existing tab by explicit tab ID. Safe because it does not mutate remote page state, but it must be schema-validated by the local server before execution.
- `openTab`: open a URL in a new browser tab. Requires approval.
- `closeTab`: close an existing browser tab by explicit tab ID. Requires approval.
- `downloadUrl`: download an explicit URL through the browser downloads API. Requires approval.

## Approval Rules

Approval is required for actions that can:

- submit forms,
- reveal or type personal data,
- leave the current site,
- trigger downloads,
- send messages,
- delete or purchase,
- change authentication state.

Approval tokens are single-use, are bound to the reviewed tool name, tab, and validated arguments, and expire after a short local TTL or when consumed by the local server.
Rejected approval tokens cannot be reused to execute the original browser action.
Mismatched approval tokens cannot be used to execute a different browser action.
Approval tokens associated with a canceled task are revoked before the task cancellation response is returned.
Expired approval tokens are pruned from the local pending approval registry and cannot be used for execution or rejection.
Approval detail summaries must redact password, token, secret, API key, card, CVV, and similar values before display.
For `click`, `type`, and `press`, a reviewed action may include `expectedUrl`. When present, the extension checks the tab URL immediately before execution and fails the tool if the page changed after approval.

## Provider Rules

- `GET /health` reports local server status plus redacted provider state for UI status indicators.
- Disabled mode must not contact any model provider.
- Ollama mode uses a local HTTP endpoint and must not require API credentials.
- Saved provider settings are local to the SQLite database unless environment variables override them.
- Provider tests use the submitted config for one connectivity prompt and must not save that config.
- Provider config read APIs must redact OpenAI-compatible API keys.
- Provider-proposed tool plans may only use the public browser tool names and validated argument schemas.
- Provider-proposed high-risk actions must produce local approval requests before execution, exactly like locally planned high-risk actions.
- Provider-proposed approval reasons must not weaken or replace local safety wording; the local server is responsible for the primary approval reason shown to the user.
- Provider continuation after tool results must use persisted/summarized task observations; raw screenshot data and sensitive page content must not be forwarded beyond the selected context boundaries.
- Provider continuation steps must be capped by `OAB_MAX_PROVIDER_CONTINUATION_STEPS`, defaulting to a small local budget when unset or invalid.

## Browser Entry Rules

- New tab and context-menu drafts are short-lived extension-local records.
- A draft may pre-fill the side panel task composer, but it must not send the task automatically.
- Context-menu draft creation may include the current page URL, selected text, or link URL needed to make the draft useful.
- Selected text included in a draft must be bounded before it is written to extension storage.
- Address-bar draft creation may include the current page URL and bounded user-entered text before writing to extension storage.
- Keyboard command draft creation may include the current page URL before writing to extension storage.

## Memory Rules

- Memory write requests create pending records only.
- Confirmed memory records are persisted to local SQLite.
- Unconfirmed pending writes remain process-local and are cleared by server restart.
- Confirmed memory records can be deleted by memory ID.
- Memory request and confirmation events are written to the local audit log without storing the content in the audit payload.
- Memory deletion events are written to the local audit log without storing the content in the audit payload.
- Chat plan audit events record memory counts only; they must not duplicate confirmed memory content.

## Snapshot Rules

- Page snapshots are sanitized by the extension and sanitized again by the server.
- Snapshot sanitization preserves non-secret field hints such as field names, accessible labels, placeholders, input type, role, and autocomplete where useful for page understanding.
- Snapshot sanitization redacts captured input values and secret-like attribute names or values before the snapshot is stored or sent to a provider.
- Snapshot sanitization redacts common sensitive text patterns, including email addresses, bearer tokens, OpenAI-style API keys, and likely payment card numbers, from snapshot text, labels, headings, links, and table cells before storage or provider use.
- Snapshot sanitization removes URL credentials and redacts sensitive query parameter values in page URLs and captured links.
- Snapshot capture options must be honored before sanitization so callers can intentionally omit links or input controls from a captured snapshot.
- Snapshot capture should derive accessible labels from `aria-label`, `aria-labelledby`, associated `<label>` elements, wrapping labels, titles, alt text, and placeholders when available.
- Snapshot capture should include a bounded heading outline and bounded HTML table summaries with captions, headers, rows, and replayable table selectors.
- Snapshot selector generation should prefer stable IDs or unique names, then fall back to parent-scoped `nth-of-type` paths rather than global element indexes.
- Actionable snapshot elements should include only visible controls; hidden or inert controls must not be suggested as click/type targets.
- Published snapshots are stored locally by the agent server, keyed by tab ID when available.
- `GET /v1/page/snapshot` returns the latest published snapshot, or the snapshot for a requested tab.
- `DELETE /v1/page/snapshot` clears local published snapshots globally or for a requested tab and records only metadata about the clear operation.
- Snapshot audit events must use metadata only and must not duplicate page text or DOM content.

## Task Run Rules

- `POST /v1/chat` creates a local task run.
- `POST /v1/chat` applies the requested context policy on the server side before planning, even when the extension has already trimmed the snapshot.
- `visible-text` context policy must remove links, element metadata, heading outlines, and table summaries before publishing or provider use.
- `POST /v1/tools/execute` accepts public tool requests without an internal call ID; the server creates that ID before audit and approval processing.
- Read-only pending tool steps can be run from the side panel.
- Browser-side execution results are reported back to the server.
- Browser-side execution results must match the planned task step ID, tool call ID, and tool name before they can update task state or task history.
- Browser-side execution results must be terminal execution outcomes: `completed`, `error`, or `rejected`. Server-side `queued` and `requires_approval` states cannot be reported as browser execution results.
- High-risk tool calls must not be executed by the extension until the server returns `queued` after a valid approval token.
- Provider-proposed browser tool calls are added to task plans only after server-side validation; invalid or unknown provider proposals are ignored.
- Provider-proposed follow-up tool calls after a completed tool result are appended to the same task run and returned with any newly required approval requests.
- Provider-generated follow-up steps are not an unlimited autonomous loop; when the configured continuation step budget is reached, the server persists a stop message as task output and does not call the provider again.
- If the user rejects a high-risk tool call, the extension must not execute the browser action and the server records a rejected tool result for the task.
- Name/email form filling and submit clicks are modeled as separate high-risk tool calls, so submit can be reviewed independently after field values are prepared.
- Pure submit or click requests must not invent default form typing; the planner should create only the reviewed click when no field value was requested.
- Type tool execution must update modern controlled input fields by using the page's native input/textarea value setter and dispatching input/change events after approval.
- Click/type execution must refuse hidden, inert, disabled, or non-editable targets even when a selector is provided directly by a provider or user.
- Scroll and screenshot tool calls are local safe actions and can run without approval after schema validation.
- Tab listing and explicit tab activation are local safe actions and can run without approval after schema validation.
- New tab creation and tab closing require approval because they can leave the current site, trigger authentication/download flows, or discard local page state.
- Direct URL downloads require approval because they write to local disk and can expose private URLs in browser download history.
- Raw screenshot image data must not be persisted in task history; persisted task results keep only redacted screenshot metadata such as MIME type and byte length.
- Press tool calls are high-risk because keys such as Enter can submit forms or trigger page shortcuts, so they require approval.
- Safe follow-up steps that depend on a completed high-risk step may start as blocked and become pending after the high-risk step succeeds.
- If a user asks to navigate before extracting page data, extraction steps must remain blocked until the navigation step completes.
- A task becomes `completed` when every step is completed.
- A task becomes `blocked` when any step requires approval.
- A task becomes `failed` when any step returns an execution error or rejection.
- A task becomes `canceled` when the user explicitly stops it; canceled tasks reject later browser tool result reports.
- Bulk task stop applies the same cancellation rules to every active task and records only task IDs, counts, reason, and revoked approval count in audit metadata.
- A deleted task is removed from local task history along with stored tool results, task output, and derived artifacts.
- Task deletion must revoke outstanding approval tokens for that task plan and reject later browser tool result reports for that task.
- Task deletion audit events must store metadata only and must not duplicate task text, tool results, artifact content, page text, or provider output.
- For link extraction tasks, completed `extractLinks` results are converted into a JSON continuation and persisted as task output.
- For pricing extraction tasks, completed `getPageSnapshot` results are parsed from structured tables first, then text fallback, converted into a JSON continuation, and persisted as task output.
- For tab listing tasks, completed `listTabs` results are converted into a JSON continuation and persisted as task output.
- Terminal browser tool results may create task artifacts. Artifact content is available from the local task artifact API and side panel History detail; artifact audit events must store metadata only and must not duplicate page-derived artifact content.
- Agent output artifacts are stored as JSON when the output parses as JSON, otherwise as plain text.
- Artifact deletion removes one local derived output by task ID and artifact ID. Deletion audit events must store artifact metadata only and must not duplicate artifact content.

## Realtime Event Rules

- `GET /v1/events` with a WebSocket upgrade streams local task and audit metadata events.
- A new WebSocket connection receives a `hello` event.
- Task events include task run state only.
- Audit events use the same payload boundaries as the persisted audit log; memory content and page snapshot text must not be duplicated into metadata-only audit events.
- The WebSocket API is loopback-local and does not contact external services.
- WebSocket upgrades must pass the same Origin policy as HTTP requests.
