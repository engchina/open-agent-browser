# Threat Model

## Assets

- User credentials and form data.
- Active page content.
- Browser session state.
- Local memory database.
- Provider API keys.

## Primary Risks

- A model or prompt attempts to submit a form without user intent.
- A malicious page poisons page text to influence the agent.
- Sensitive input values are captured in snapshots.
- A tool call navigates to a phishing or unexpected domain.
- Memory persists sensitive data without consent.
- An ordinary website attempts to call the loopback API or WebSocket event stream through the browser.

## MVP Mitigations

- High-risk tools require single-use approval tokens that are bound to the reviewed tool name, tab, and validated arguments.
- Approval tokens expire after a short local TTL, limiting stale approval reuse when a review card is left open.
- Navigation approvals include the current page URL when available and classify cross-origin navigation as high risk.
- Page-changing approvals for click, type, and key-press tools can include the expected page URL; the extension refuses execution if the tab has navigated before the reviewed action runs.
- Direct downloads require approval before the extension invokes Chrome's downloads API.
- Canceling a task revokes outstanding approval tokens tied to that task plan, so stale approval UI cannot later authorize a canceled browser action.
- Page snapshot sanitization redacts sensitive attributes and truncates large text.
- The extension executes browser actions only after server-side schema validation.
- The loopback API rejects ordinary browser origins by default and only echoes CORS for extension origins or explicit development allowlist entries.
- The WebSocket event stream applies the same Origin policy during upgrade.
- Memory writes are pending until confirmed.
- Provider credentials are redacted from health responses.
- Browser source and patches are managed separately from third-party AGPL code.
