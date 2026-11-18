/**
 * The two small pages the Code host serves itself: the sign-in page behind a
 * 401 and the same page after a rejected ticket.
 *
 * These pages are not part of the app UI, so they carry fixed English text
 * rather than the app's i18n catalogue. The only interactive control leads
 * back to `APP_ORIGIN`, the app's login.
 */

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;")
}

const STYLE = `
:root { color-scheme: light dark; }
body { margin: 0; min-height: 100vh; display: grid; place-items: center;
  font: 16px/1.5 system-ui, -apple-system, "Segoe UI", sans-serif; background: #f6f6f7; color: #1c1c1e; }
main { max-width: 28rem; padding: 2rem; text-align: center; }
h1 { font-size: 1.25rem; margin: 0 0 .5rem; }
p { margin: 0 0 1.25rem; color: #55555c; }
a { display: inline-block; padding: .55rem 1rem; border-radius: .5rem;
  background: #1c1c1e; color: #fff; text-decoration: none; }
@media (prefers-color-scheme: dark) {
  body { background: #161618; color: #f2f2f5; }
  p { color: #a1a1aa; }
  a { background: #f2f2f5; color: #161618; }
}
`

/**
 * The page links to the app login when standalone and, when framed, tells the
 * app that the Code host has no session. The message goes to `APP_ORIGIN`
 * explicitly; `"*"` would hand the state to any embedding page.
 */
export function signInPage(appOrigin: string, reason?: string): string {
  const href = `${appOrigin}/login`
  const message = reason ?? "Sign in to Open Code."
  const script = `(function () {
  if (window.parent === window) return;
  window.parent.postMessage(
    { type: "openchat:code-state", state: "unauthenticated" },
    ${JSON.stringify(appOrigin)}
  );
})();`
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="referrer" content="no-referrer">
<title>Sign in to Open Code</title>
<style>${STYLE}</style>
</head>
<body>
<main>
<h1>Sign in to Open Code</h1>
<p>${escapeHtml(message)}</p>
<a href="${escapeHtml(href)}" target="_top">Sign in to OpenChat</a>
</main>
<script>${script}</script>
</body>
</html>
`
}

/**
 * Whether a 401 should answer with the page. Explicit JSON (`/api/*` or an
 * `Accept: application/json`) always gets JSON; a browser navigation gets the
 * page. `/api/*` is checked first because the SPA's fetches often send a
 * wildcard accept header.
 */
export function wantsHtml(request: Request): boolean {
  let path = "/"
  try {
    path = new URL(request.url).pathname
  } catch {
    path = "/"
  }
  if (path === "/api" || path.startsWith("/api/")) return false
  const accept = request.headers.get("accept")?.toLowerCase() ?? ""
  if (accept.includes("text/html")) return true
  return request.headers.get("sec-fetch-mode")?.toLowerCase() === "navigate"
}
