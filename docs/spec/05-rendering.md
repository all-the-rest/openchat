# 05 — Rendering

## Principle

The transcript is a list of typed parts. Each part has exactly one renderer.
Unknown parts render as a safe fallback, never as raw HTML.

```
Message
├── UserPart(text, attachments)
├── AssistantPart
│   ├── TextPart        → Markdown
│   ├── ReasoningPart   → collapsible block
│   ├── ToolPart        → tool card
│   └── ErrorPart       → error card
├── SystemPart          → notice
├── CompactionPart      → boundary notice
└── FormPart            → interactive card
```

## Text renderer

- CommonMark + GFM: tables, task lists, strikethrough, autolinks, footnotes.
- Raw HTML is disabled by default. If enabled, sanitize with an allowlist.
- Links open in a new tab with `rel="noopener noreferrer"`.
- Code blocks: language label, copy, wrap toggle, optional line numbers
  (OBS-016: header row with language icon, language name and two icon actions;
  code 12 px mono, 20 px line height, light gray surface).
- Inline code: monospace, no wrapping inside words.
- Math: `$…$` and `$$…$$` via KaTeX; invalid TeX falls back to text.
  Observed: inline `$…$` renders; a `\[ … \]` block stays raw text (OBS-016), so
  support both block forms rather than guessing which one a model emits.
- Diagrams: fenced `mermaid` blocks render a diagram block with its own actions
  (options, expand, copy), not a code block (OBS-016). Errors show the source.
- Tables: 14 px cells, 20 px line height, 8 px vertical padding, header weight
  600, horizontal rules only, no zebra striping (OBS-016).
- Images: markdown images are proxied or loaded from allowed origins only.
- Citations: `[n]` chips resolve to the source list of the same message.

Preserve the model's list structure rather than repairing it: in the reference
an empty trailing numbered item still renders its number (OBS-016). Repairing
would hide a model mistake the owner may want to see.

## Tool card

Fields:

- tool name and icon
- status: queued, running, waiting for permission, done, error
- duration
- input summary (collapsed)
- output summary (collapsed, with a "show full" action)
- error text
- link to the artifact/file if produced

Rules:

- Streaming input is shown as it arrives, but collapsed by default.
- Large outputs are truncated with an explicit expand action.
- Secrets and environment values are redacted by the backend; the UI never
  displays raw credentials.

## Reasoning block

- Collapsed by default after completion; expanded while streaming.
- Label clearly as model reasoning, not as an answer.
- Persisted if the backend provides it; otherwise session-only.

## Permission card

- Shows the requested action, resource, and the rule that triggered it.
- Actions: allow once, always allow, deny.
- "Always allow" writes a rule; show the exact rule before saving.
- The run stays paused until a decision.

## Form card

- Renders string, number, integer, boolean, select, multiselect and score
  fields.
- Validates before submit; shows field-level errors.
- Submits `session.form.reply`.
- A settled form becomes read-only.

## Artifacts

- Artifact metadata: title, provider, entry, URL, session, time.
- Open in the right rail on desktop, full-screen sheet on mobile.
- The preview runs on a separate origin (`/artifact/:id`) in a sandboxed
  iframe:

```html
<iframe
  sandbox="allow-scripts allow-forms allow-modals allow-popups"
  referrerpolicy="no-referrer"
  src="https://artifacts.example.com/artifact/…"
/>
```

- Never include `allow-same-origin` together with `allow-scripts`.
- The artifact host must not send cookies and must set a restrictive CSP.
- Downloads are explicit; no automatic navigation.
- Version history is optional; at minimum, show the current version and a
  download action.

## Files and images

- File card: icon by type, name, size, preview/download.
- Image: thumbnail, dimensions, alt text, lightbox with zoom and download.
- PDF: embedded viewer if allowed, otherwise a download card.
- Generated images: grid with prompt metadata and download.

## Message actions

Observed (OBS-017):

- Assistant turn: copy, rate, read aloud, share, more.
- User turn: copy, share prompt, edit.
- A circular "scroll to bottom" button appears when the thread is scrolled up.
- A long stream does not steal scroll position; the affordance is explicit.

Our implementation:

- Actions are icon buttons with accessible names and tooltips.
- Copy writes plain text (Markdown source on demand) and announces success.
- Edit opens the composer prefilled and creates a branch on submit.
- Rate and read-aloud only appear when a backend/model supports them.

## Streaming

- Append deltas without re-rendering the whole thread.
- Keep scroll position stable unless the user is at the bottom.
- Show a "jump to latest" control when scrolled up.
- Do not animate every token; use a subtle cursor.
- Announce completion once, not per token.

## Safety

- Sanitize all Markdown output.
- Disallow `javascript:` and `data:` links except for images with an image MIME
  type.
- Escape code blocks.
- Artifact HTML never runs on the app origin.
- Treat all model/tool output as untrusted content.
