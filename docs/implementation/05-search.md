# 05 — Multi-source search (V2, FR-44)

**Status:** 2026-11-17. `GET /api/search` groups results by source and never
queries a source the caller did not ask for; `/search?scope=all` is the page on
top of it. This document covers the wire contract, the sources and the UI
behaviour.

## Contract

```
GET /api/search?q=<query>&sources=chats,workspace,web,apps&limit=20
```

| Parameter | Rules |
| --- | --- |
| `q` | required, trimmed, 1–200 characters; longer or blank is `400 invalid_request` |
| `sources` | optional, comma-separated, default all four; an unknown name is `400` |
| `limit` | optional, integer 1–50, default 20; applied per source |

```json
{
  "query": "alpha",
  "available": ["chats", "workspace", "web"],
  "groups": [
    { "source": "chats", "state": "ok", "total": 1, "hits": [ ... ] },
    { "source": "web", "state": "disabled", "total": 0, "hits": [] }
  ]
}
```

- `groups` follows the requested order; only requested sources appear.
- `available` is what the deployment can query, independent of the request; the
  UI renders its toggles from it.
- `state`: `ok` (queried, hits may be empty), `failed` (could not be queried —
  a provider/probe error or an upstream failure; the other groups are
  unaffected) or `disabled` (not configured on the host, so nothing was sent).
  `failed` is checked before `available`, so a failing probe is never reported
  as a silent empty group.
- `total` is the number of hits in this response, never more than `limit`; it is
  not the number of matches in the source (there is no cursor).
- A hit carries the fields its source defines: `sessionID`/`messageID` for
  chats, `path` for workspace files, `url`/`provider`/`published` for web,
  `app`/`appKind`/`status` for apps.
- **Live chat hits are title hits only.** `session.list({ search })` searches
  session titles; it returns neither a matching message nor a snippet. The fake
  backend additionally emits message-level hits so the UI's message deep links
  can be built and tested before the host exposes message search.
- Hits are deduped by id within a group (a provider may repeat a URL) and
  clamped to `limit` regardless of what the upstream returns.

The route sits behind the session/Basic auth and the same-origin guard like
every other `/api` route; there is no new upstream port and no new secret.

## Sources

The BFF holds no provider keys. Every source is the Code host's own surface,
reached through `@opencode/client` (`apps/server/src/search.ts` and
`packages/opencode/src/live-search.ts`).

| Source | Client call | Available when |
| --- | --- | --- |
| `chats` | `session.list({ search, directory, limit })` | always |
| `workspace` | `file.find({ location: { directory }, query, limit })` | always |
| `web` | `websearch.providers()` then `websearch.query({ query })` | the host has at least one provider |
| `apps` | `mcp.list()` + `skill.list()` | always |

- **Web is configured on the host** (`websearch` in `opencode.json`: Exa,
  Firecrawl, a custom provider). The BFF never receives a provider key, and a
  deployment without providers returns `disabled` without a query. Establishing
  availability costs one `websearch.providers()` read per query — a
  configuration read, not a search, and no user data leaves the BFF. Only a
  requested `web` source triggers `websearch.query()`.
- **Apps** are MCP servers plus skills. `@opencode/client@2.3.0` has no
  method that lists the tools of a server, so a server is one hit with its
  status (`connected`, `pending`, `needs_auth`, …); skills are hits with
  `appKind: "skill"`. `apps` is reported as available on every deployment: an
  empty list and "not configured" are only separable by asking the host on every
  request, and unlike web that probe would buy nothing (there is no provider to
  protect), so the group stays switchable and an empty host yields `ok` with no
  hits.
- Calls run only for requested sources (the availability probe above is the
  one exception). A failure is isolated: a dead web provider does not hide chat
  hits, and a failing `mcp.list()` still returns skills because the two lists
  settle independently. Both app lists are scoped to `WORKSPACE_DIR`.
- A probe failure is not silently a "disabled" source: if `web` was requested
  and `websearch.providers()` cannot be reached, `web` is reported as `failed`.

## Fake backend

`FakeBackend.search` (`packages/opencode/src/fake-search.ts`) searches the
in-memory sessions and a fixed workspace/web/app fixture. It exists so the UI
and the route can be tested without a provider; the ids are deterministic and
the result order follows the store. Two options model the interesting states:
`disabledSources` (a group that is never queried) and `failingSources` (a group
that reports `failed`).

## Tests

- `packages/opencode/test/search.test.ts` covers fake title/message hits,
  workspace/web/app fields, source filtering, the per-source cap, disabled and
  failing sources, and the live mapping against a stub client (provider probe,
  no-provider deployment, provider failure with a request-independent
  `available`, one app list failing, duplicate sources, the web cap and wiring
  through `LiveBackend`).
- `apps/server/test/search.test.ts` covers auth before validation (with an
  invalid request), every `400` (missing/blank/long `q`, unknown source, empty
  list, bad `limit`), a query of exactly 200 characters, the default limit,
  duplicate/whitespace sources, dedupe by id, default grouping, requested
  order, `disabled`, `failed` and the `limit` cap.
- `apps/web/test/search-page.test.tsx` covers the first query, URL write-back
  and clearing, the 200-character cap, per-source toggles, the unavailable
  source, the "last source" guard, the web-until-Enter rule, a late response
  being discarded, an empty `available` (never widened, no repeat query), a
  failed group with hits, arrow-key navigation, retry, prompt and both empty
  states. `apps/web/test/transcript.test.tsx` covers the deep-link scroll,
  focus and highlight, the no-re-scroll rule while streaming and an unknown
  id. `apps/web/test/sidebar-search.test.tsx` pins the sidebar entry inside the
  navigation landmark and its explicit `?scope=all` target. The page tests also
  pin chat-only for a bare `/search`, that availability can narrow without a
  repeat query, and that arrow navigation reaches a non-actionable row. `apps/web/e2e/search.spec.ts` runs the same flow in a
  browser: grouped results, web only after Enter, the toggle removing the
  citation, the URL write-back, and a chat hit jumping to the highlighted
  message.

## The `/search` page

`/search?scope=all&q=…` (`apps/web/src/search/`) renders the response as one
group per requested source.

- **URL is the state.** The input is derived from `q`: typing writes the URL
  with `replace`, clearing removes `q`, and `scope` is kept. A bare `/search`
  is the chat-only surface (spec 02); `?scope=all` is the multi-source one, and
  the sidebar links there. A result page therefore reloads and can be shared,
  and an address-bar edit or a Back navigation is picked up.
- **Debounced queries.** 250 ms after the last keystroke the page calls
  `/api/search`; a newer query or source change aborts the in-flight request
  and a late answer is discarded by the abort check, so an older response can
  never overwrite a newer one. A blank query never sends anything.
- **Web is explicit.** `chats`, `workspace` and `apps` follow the debounce, but
  `web` is only queried for a committed query: the one in the URL at load, or
  the one confirmed with Enter. Editing the text drops `web` from the request
  until Enter is pressed, and a hint says so. A half-typed phrase therefore
  never reaches a third-party provider.
- **Toggles.** One checkbox per source, rendered from `available`. A source the
  host cannot query is disabled and labelled "not configured". The selection is
  the user's: availability filters the *request*, never the choice, so a
  `disabled` answer cannot silently widen it to other sources. The last
  requestable source cannot be switched off, because an empty selection would
  query nothing. Toggling keeps the canonical source order, so groups never
  reorder. The first request may still include a source the deployment lacks,
  because availability is only known from the response.
- **Groups.** Each group shows its label and either its count or its state
  (`Search failed`, `Not configured` with a one-line hint) plus its hits. A
  failed or disabled group never hides the others. When every group is `ok`
  with no hits, the groups collapse into the single "No results" line instead
  of four empty headings.
- **Hits.** A chat hit is a link to `/c/:sessionId` or, with a message id, to
  `/c/:sessionId/:messageId`; ids are percent-encoded. Web hits open the
  citation in a new tab (announced as such) and show provider plus hostname;
  workspace and app hits are informational (no file viewer yet, #11; no tool
  run, #15) and show path and app kind plus status, with the known host
  statuses translated. Non-actionable hits are not tab stops.
- **Keyboard.** `ArrowDown` in the search field jumps to the first result;
  `ArrowDown`/`ArrowUp` move through the result links. The field is capped at
  the contract's 200 characters, so a paste cannot provoke a `400`.
- **Chat deep link.** Every message renders `id="message-<id>"`, including
  system messages. The chat page takes `:messageId`, scrolls that message to
  the centre **once**, moves focus to it (`tabIndex={-1}`) and marks it with a
  ring, so a keyboard or screen-reader user arrives at what they followed and a
  streaming session does not pull the view back on every event. Live chat hits
  are title-only, so in a real deployment the link comes from the URL.
- **Empty and error states.** No query shows a prompt; zero hits shows "No
  results for …"; a query with no requestable source says so; a failed request
  shows an alert with a retry button.

## Not covered

- **Workspace file viewer.** `file.find` returns `path` and `type` only; the
  `/code` surface and a file view are separate slices (#11), so a workspace hit
  carries no open action yet.
- **MCP tools.** No tool-listing API in the pinned client; the apps group stops
  at server + skill level.
- **Ranking and cross-source dedupe.** Each source returns its own order and
  the route concatenates by group; only duplicates within one group are
  removed. There is no cross-source score or merged list.
- **Caching and pagination.** A query is repeated on every request; there is no
  cursor per group, matching the client API.
- **Search throttle.** `/api/search` has no per-address bucket, unlike
  `prompt`; the 250 ms debounce is client-side only, so a scripted caller can
  spend provider quota with web enabled. A throttle is a follow-up if the
  single-owner deployment ever needs one.
- **Repeated parameters.** `?q=a&q=b` and `?sources=a&sources=b` use the first
  value; a blank `?limit=` is a `400`, while an absent one means 20.
