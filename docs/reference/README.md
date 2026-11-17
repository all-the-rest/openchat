# Reference Material

Redacted excerpts that the observer needs for traceability. Everything here is
**read-only input** and invisible to the `builder`.

## Rules

- No raw screenshots, DOM dumps, HAR files or network captures. Those live in
  `references/raw/` (gitignored).
- No code, CSS, HTML fragments, icons, fonts or logos.
- No personal data: no chat titles, message content, e-mail addresses, cookies
  or tokens.
- Prefer measurements to excerpts. If an excerpt is unavoidable, keep the
  smallest fragment that answers a question and cite the observation ID that
  produced it.
- Every entry states what question it answers and which specification section
  depends on it.

## Structure

```
reference/
  README.md          this file
  <topic>.md         redacted excerpt + observation IDs + affected spec section
```

Deletion test: if an entry could be replaced by a sentence in
`docs/spec/**`, it belongs in the specification, not here.
