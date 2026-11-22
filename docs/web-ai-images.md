# Web chat image input

The web AI composer supports file selection, pasted screenshots, removable thumbnails, text with images, and image-only messages. Enter submits; Shift+Enter and IME composition retain their existing behavior. Draft attachments belong to one web session and survive hiding its panel.

Choose **选图** beside the input, or paste a screenshot into the text box. A **待发送图片** tray shows every selected thumbnail, its filename and the total count; paste feedback confirms how many were added. Each thumbnail has its own remove button. Composer controls wrap within narrow docks so the input and send button remain accessible. After a page reload, select the saved conversation's tab to view its images and replies.

PNG and JPEG are accepted by the backend. The browser also accepts WebP and converts it to PNG/JPEG. It can resize or re-encode large images before submission and labels converted previews. The first version permits at most four images, a combined decoded upload size of 1 MiB, and 4096 pixels per side. The existing 2 MiB total HTTP request limit still applies.

`POST /api/ai/turn` accepts optional `images: [{name, mime_type, data_url}]`. The backend validates image format/container, dimensions and size, stores bytes under the session's private runtime directory, and sends separate native `localImage` inputs to Codex app-server. Image data is not appended to the text prompt or normal event/receipt history. Browser-provided filesystem paths and external URLs are rejected.

The selected/default model must explicitly report image support. Unknown capability or a text-only model requires the user to select a suitable model or remove the attachments. No model or provider is silently substituted. Source identity checks and manual approval gates remain in effect.

Message history stores image descriptors. `GET /api/ai/image?session_id=...&image_id=...` retrieves one image only when it belongs to the retained history of that session. Thumbnail restoration does not resume execution or automatically resend old pixels after a backend restart; reattach the image when the new model thread needs it.

Until the server confirms the same turn key, the composer keeps the text and images. After an uncertain delivery, “核对发送结果” reads the same session's history instead of posting another turn. Suspended requests remain suspended.

An image model-catalog failure before reserving the turn returns `image_preflight_rejected`. A same-session history check can then unlock the retained draft if no receipt exists and the session is idle or complete. Later thread/turn failures retain their original classification. A confirmed successful receipt restores the completed status and any saved reply instead of leaving a stale failure badge.

Offline checks:

```sh
python3 -B tests/ai/test_images.py
node --test tests/ai/images.test.mjs tests/ai/panel-images.test.mjs
```

The browser fixture uses Chrome and real Canvas with an intercepted synthetic gateway:

```sh
EVIDENCE_DIR=/tmp/ic-image-browser node tests/ai/images-browser.mjs
```

It covers image-only Enter submission, paste/remove, model capability rejection, lost-response reconciliation, WebP conversion, and 400px/260px layouts. Pass `--playwright-module /absolute/path/to/playwright/index.mjs` when Playwright is installed outside the repository.

On November 16, 2026, the local Studio frontend and backend were updated and a real image turn through the configured provider correctly answered a visual counting question. The prompt and image filename did not contain the expected count. This is distinct from the offline and intercepted-browser checks; those alone do not establish real image inference.

Protocol reference: [Codex app-server input items](https://learn.chatgpt.com/docs/app-server).
