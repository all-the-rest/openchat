import type { SearchResponse } from "@openchat/contracts"
import { render } from "@testing-library/react"
import type { ReactNode } from "react"
import { MemoryRouter, Route, Routes, useLocation } from "react-router-dom"
import { I18nProvider } from "../src/i18n/provider"
import { SearchPage } from "../src/search/SearchPage"
import { ThemeProvider } from "../src/theme/provider"

/** A complete response with one hit per interesting state. */

export function response(overrides: Partial<SearchResponse> = {}): SearchResponse {
  return {
    query: "alpha",
    available: ["chats", "workspace", "apps"],
    groups: [
      {
        source: "chats",
        state: "ok",
        total: 2,
        hits: [
          { source: "chats", id: "chat-ses_1", title: "Alpha chat", sessionID: "ses_1" },
          {
            source: "chats",
            id: "message-msg_1",
            title: "Alpha chat",
            snippet: "We talked about alpha yesterday.",
            sessionID: "ses_1",
            messageID: "msg_1",
          },
        ],
      },
      {
        source: "workspace",
        state: "ok",
        total: 1,
        hits: [
          {
            source: "workspace",
            id: "file-src/alpha.ts",
            title: "src/alpha.ts",
            path: "src/alpha.ts",
          },
        ],
      },
      { source: "web", state: "disabled", total: 0, hits: [] },
      { source: "apps", state: "failed", total: 0, hits: [] },
    ],
    ...overrides,
  }
}

function LocationProbe() {
  const location = useLocation()
  return <output data-testid="location">{location.search}</output>
}

/** Renders the page on its real route inside the app providers. */
export function renderSearch(entry = "/search?scope=all", extra?: ReactNode) {
  return render(
    <ThemeProvider initialTheme="dark">
      <I18nProvider initialLocale="en">
        <MemoryRouter initialEntries={[entry]}>
          <LocationProbe />
          {extra}
          <Routes>
            <Route path="/search" element={<SearchPage />} />
            <Route path="/c/:sessionId/:messageId" element={<p>chat target</p>} />
          </Routes>
        </MemoryRouter>
      </I18nProvider>
    </ThemeProvider>,
  )
}

/** A promise the test resolves itself, for ordering responses. */
export function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((done) => {
    resolve = done
  })
  return { promise, resolve }
}
