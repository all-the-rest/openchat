import { render, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import type { Message } from "@openchat/contracts"
import type { ReactNode } from "react"
import { beforeEach, describe, expect, it, vi } from "vitest"
import { ChatMenu } from "../src/chat/ChatMenu"
import { CompletionProvider } from "../src/chat/completion"
import { UsagePanel } from "../src/chat/UsagePanel"
import { buildChatMarkdown } from "../src/chat/export"
import { I18nProvider } from "../src/i18n/provider"
import { ThemeProvider } from "../src/theme/provider"

const mocks = vi.hoisted(() => ({ saveBlob: vi.fn() }))

vi.mock("../src/artifacts/files", () => ({ saveBlob: mocks.saveBlob }))

beforeEach(() => {
  mocks.saveBlob.mockReset()
})

const transcript: Message[] = [
  {
    id: "msg_1",
    sessionID: "ses_1",
    role: "user",
    created: 1_700_000_000_000,
    status: "complete",
    parts: [{ type: "text", id: "part_1", text: "Hello" }],
  },
  {
    id: "msg_2",
    sessionID: "ses_1",
    role: "assistant",
    created: 1_700_000_001_000,
    status: "complete",
    parts: [{ type: "text", id: "part_2", text: "Hi there" }],
  },
]

function wrap(children: ReactNode, locale: "en" | "de" = "en") {
  return render(
    <ThemeProvider initialTheme="dark">
      <I18nProvider initialLocale={locale}>{children}</I18nProvider>
    </ThemeProvider>,
  )
}

describe("chat export menu", () => {
  it("downloads the loaded transcript as markdown under the slugified title", async () => {
    const user = userEvent.setup()
    wrap(<ChatMenu title="Quarterly Review" created={1_700_000_000_000} messages={transcript} />)

    await user.click(screen.getByRole("button", { name: "Chat actions" }))
    await user.click(screen.getByRole("menuitem", { name: "Download chat" }))

    expect(mocks.saveBlob).toHaveBeenCalledTimes(1)
    const [blob, filename] = mocks.saveBlob.mock.calls[0] as [Blob, string]
    expect(filename).toBe("quarterly-review.md")
    expect(blob.type).toBe("text/markdown;charset=utf-8")

    const expected = buildChatMarkdown({
      title: "Quarterly Review",
      created: 1_700_000_000_000,
      messages: transcript,
      labels: {
        date: "Date",
        user: "You said",
        assistant: "Assistant answer",
        system: "System note",
        tool: "Tool",
        artifact: "Artifact",
        artifactNote: "Its files are stored in this chat.",
        untitled: "Untitled",
      },
      toolStatus: () => "Done",
    })
    expect(await blob.text()).toBe(expected)
    expect(await blob.text()).toContain("# Quarterly Review\n\nDate: 2023-11-14")
    expect(screen.getByRole("status")).toHaveTextContent("Chat exported.")
  })

  it("announces a failed download without breaking the header", async () => {
    mocks.saveBlob.mockImplementationOnce(() => {
      throw new Error("blocked")
    })
    const user = userEvent.setup()
    wrap(<ChatMenu title="Broken" messages={transcript} />)

    await user.click(screen.getByRole("button", { name: "Chat actions" }))
    await user.click(screen.getByRole("menuitem", { name: "Download chat" }))

    expect(screen.getByRole("status")).toHaveTextContent("The chat could not be exported.")
  })

  it("translates the menu and the download notice", async () => {
    const user = userEvent.setup()
    wrap(<ChatMenu title="Quartalsbericht" messages={transcript} />, "de")

    await user.click(screen.getByRole("button", { name: "Chat-Aktionen" }))
    await user.click(screen.getByRole("menuitem", { name: "Chat herunterladen" }))

    expect(mocks.saveBlob).toHaveBeenCalledWith(expect.any(Blob), "quartalsbericht.md")
    expect(screen.getByRole("status")).toHaveTextContent("Chat exportiert.")
  })
})

function usageCatalogue(contextLimit?: number) {
  return {
    models: [
      {
        id: "fake/echo",
        name: "Fake Echo",
        providerID: "fake",
        providerName: "Fake Provider",
        variants: [],
        contextLimit: contextLimit ?? 0,
        capabilities: { tools: false, reasoning: false, image: false },
        status: "active" as const,
      },
    ],
    agents: [],
  }
}

function renderUsage(report: Parameters<typeof UsagePanel>[0]["report"], locale: "en" | "de" = "en", limit?: number) {
  return render(
    <ThemeProvider initialTheme="dark">
      <I18nProvider initialLocale={locale}>
        <CompletionProvider catalogue={usageCatalogue(limit)}>
          <UsagePanel report={report} />
        </CompletionProvider>
      </I18nProvider>
    </ThemeProvider>,
  )
}

describe("usage panel", () => {
  it("renders the reported counters and the model's context limit", async () => {
    const user = userEvent.setup()
    renderUsage({ input: 1200, output: 340, cached: 512 }, "en", 128_000)

    await user.click(screen.getByRole("button", { name: "Usage" }))
    expect(screen.getByRole("dialog", { name: "Token usage" })).toBeVisible()
    expect(screen.getByTestId("usage-input")).toHaveTextContent("1,200")
    expect(screen.getByTestId("usage-output")).toHaveTextContent("340")
    expect(screen.getByTestId("usage-cached")).toHaveTextContent("512")
    expect(screen.getByTestId("usage-limit")).toHaveTextContent("128,000")
    expect(screen.getByRole("progressbar")).toHaveAttribute("aria-valuenow", "1")
  })

  it("shows not reported and no numbers when the host reported nothing", async () => {
    const user = userEvent.setup()
    renderUsage(null, "en", 128_000)

    await user.click(screen.getByRole("button", { name: "Usage" }))
    expect(screen.getByTestId("usage-not-reported")).toHaveTextContent(
      "Token usage has not been reported for this chat.",
    )
    expect(screen.queryByTestId("usage-input")).toBeNull()
    expect(screen.queryByTestId("usage-limit")).toBeNull()
    expect(screen.queryByRole("progressbar")).toBeNull()
  })

  it("does not invent a context limit when the model has none", async () => {
    const user = userEvent.setup()
    renderUsage({ input: 10, output: 5 }, "en")

    await user.click(screen.getByRole("button", { name: "Usage" }))
    expect(screen.getByTestId("usage-limit")).toHaveTextContent("Not reported")
    expect(screen.queryByRole("progressbar")).toBeNull()
  })

  it("translates the trigger, panel and unknown state", async () => {
    const user = userEvent.setup()
    renderUsage(null, "de")

    await user.click(screen.getByRole("button", { name: "Token" }))
    expect(screen.getByRole("dialog", { name: "Token-Nutzung" })).toBeVisible()
    expect(screen.getByTestId("usage-not-reported")).toHaveTextContent(
      "Für diesen Chat wurde keine Token-Nutzung gemeldet.",
    )
  })
})
