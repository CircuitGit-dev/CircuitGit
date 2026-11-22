# Web conversation manager

Open **管理** in the AI conversation bar, or **Window → AI：对话管理器…**. The manager lists conversations with their current state, model and last update time. Search by name or model; open a conversation, rename it, or create another without replacing other panels or their unsent drafts.

Deletion requires confirmation for the selected conversation. It removes the conversation from the workbench and frees one of the eight active-list slots. It is a **soft deletion**: local history, images and operation receipts are retained, and cannot be accessed through the deleted session's workbench routes. This is not a storage-erasure or simulation-cancellation operation. The default conversation remains available. A running turn, ongoing metadata/request operation or unresolved approval prevents deletion.

`POST /api/ai/sessions/delete` accepts exactly `{ "session_id": "..." }`, under the gateway's existing same-origin and CSRF guards. Success returns `{ "session_id": "...", "deleted": true, "history_retained": true }`. A repeated request for the same deleted ID returns the same result without repeating cleanup. A registry tombstone prevents its restoration after a restart. The list supplies `can_delete` and `delete_block_reason`; clients do not infer eligibility from the display name.

If a deletion response is lost, the UI retains the panel until a successful receipt or a refreshed authoritative list confirms removal. It never automatically resends the deletion. Removing one panel leaves other conversation drafts and models intact. Escape closes only the top conversation dialog, including when focus has left a disabled button.

Validation:

```sh
python3 -B tests/ai/test_sessions.py
node tests/studio/session-manager-browser.mjs
```

The browser fixture uses synthetic session metadata and no model calls. Set `PLAYWRIGHT_MODULE` to an absolute Playwright module path if it is installed outside the repository, and `EVIDENCE_DIR` to retain its report and screenshots.
