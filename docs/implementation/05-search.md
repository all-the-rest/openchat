# 05 — Multi-source search (V2, FR-44)

**Status:** 2026-11-17. Backend slice of search: `GET /api/search` groups
results by source and never queries a source the caller did not ask for. The
`/search` page is the next slice; this document describes the wire contract it
builds on.

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
- **The `/search` page.** Toggles, keyboard navigation, chat jump and citation
  rendering belong to the UI slice; this slice owns the contract and the BFF.
