import type { ModelInfo, ProviderInfo } from "@openchat/contracts"
import { render, screen, waitFor } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import type { ReactNode } from "react"
import { beforeEach, describe, expect, it, vi } from "vitest"
import { CompletionProvider } from "../src/chat/completion"
import { SessionsProvider, useSessions } from "../src/chat/sessions"
import { I18nProvider } from "../src/i18n/provider"
import { FirstRunGate } from "../src/onboarding/FirstRunGate"
import { OAuthFlow } from "../src/onboarding/OAuthFlow"

const MODEL: ModelInfo = { id: "fake/echo", name: "Fake Echo", providerID: "fake" }

const KEY_METHOD = {
  id: "api-key",
  type: "key" as const,
  label: "API key",
  form: [
    {
      key: "key",
      title: "API key",
      required: true,
      type: "string" as const,
      secret: true,
      minLength: 8,
    },
    {
      key: "region",
      title: "Region",
      required: true,
      type: "string" as const,
      secret: false,
      options: [
        { value: "eu", label: "Europe" },
        { value: "us", label: "United States" },
      ],
      defaultValue: "eu",
    },
  ],
}

const OAUTH_METHOD = {
  id: "browser",
  type: "oauth" as const,
  label: "Sign in with a browser",
  form: [],
}

const PROVIDERS: ProviderInfo[] = [
  {
    id: "fake-cloud",
    name: "Fake Cloud",
    connected: false,
    methods: [KEY_METHOD, OAUTH_METHOD],
    connections: [],
  },
]

const OAUTH_PROVIDERS: ProviderInfo[] = [
  {
    id: "fake-cloud",
    name: "Fake Cloud",
    connected: false,
    methods: [OAUTH_METHOD],
    connections: [],
  },
]

const mocks = vi.hoisted(() => ({
  models: vi.fn(async (): Promise<ModelInfo[]> => []),
  agents: vi.fn(async () => []),
  providers: vi.fn(async (): Promise<ProviderInfo[]> => []),
  connectProviderKey: vi.fn(async () => ({ ok: true })),
  providerStatus: vi.fn(async (): Promise<{ models: ModelInfo[] }> => ({ models: [] })),
  startProviderOAuth: vi.fn(async () => ({
    attempt: {
      id: "attempt-1",
      url: "https://example.invalid/auth",
      instructions: null,
      code: null,
      needsCode: false,
      expires: 60_000,
    },
  })),
  providerOAuthStatus: vi.fn(async () => ({ status: "pending" })),
  completeProviderOAuth: vi.fn(async () => undefined),
  cancelProviderOAuth: vi.fn(async () => undefined),
  listSessions: vi.fn(async () => []),
  createSession: vi.fn(async () => ({
    id: "ses_1",
    title: "",
    directory: "/workspace",
    created: 1,
    updated: 1,
  })),
}))

vi.mock("../src/api/client", () => ({ api: mocks }))

function wrap(children: ReactNode, models: ModelInfo[] = []) {
  return render(
    <I18nProvider initialLocale="en">
      <CompletionProvider catalogue={{ models, agents: [] }}>{children}</CompletionProvider>
    </I18nProvider>,
  )
}

function gate() {
  return (
    <FirstRunGate>
      <span data-testid="composer-stub">composer</span>
    </FirstRunGate>
  )
}

beforeEach(() => {
  window.localStorage.clear()
  mocks.providers.mockResolvedValue(PROVIDERS)
  mocks.providerStatus.mockResolvedValue({ models: [] })
  mocks.connectProviderKey.mockResolvedValue({ ok: true })
  mocks.providerOAuthStatus.mockResolvedValue({ status: "pending" })
  mocks.startProviderOAuth.mockResolvedValue({
    attempt: {
      id: "attempt-1",
      url: "https://example.invalid/auth",
      instructions: null,
      code: null,
      needsCode: false,
      expires: 60_000,
    },
  })
})

describe("first-run gate", () => {
  it("shows the card only while the model catalogue is empty", async () => {
    const empty = wrap(gate())
    expect(await screen.findByTestId("first-run-card")).toBeInTheDocument()
    expect(screen.queryByTestId("composer-stub")).not.toBeInTheDocument()
    empty.unmount()

    wrap(gate(), [MODEL])
    expect(screen.getByTestId("composer-stub")).toBeInTheDocument()
    expect(screen.queryByTestId("first-run-card")).not.toBeInTheDocument()
  })
})

describe("provider key form", () => {
  it("sends the key once, clears it and refreshes the catalogue", async () => {
    mocks.providerStatus.mockResolvedValueOnce({ models: [MODEL] })
    const user = userEvent.setup()
    wrap(gate())

    await screen.findByTestId("first-run-card")
    await user.type(screen.getByTestId("provider-key-input"), "test-api-key-123")
    await user.selectOptions(screen.getByTestId("provider-field-region"), "us")
    await user.click(screen.getByTestId("provider-connect-submit"))

    await waitFor(() =>
      expect(mocks.connectProviderKey).toHaveBeenCalledWith("fake-cloud", {
        methodID: "api-key",
        key: "test-api-key-123",
        answer: { region: "us" },
      }),
    )
    expect(mocks.providerStatus).toHaveBeenCalledTimes(1)
    await waitFor(() => expect(screen.getByTestId("composer-stub")).toBeInTheDocument())
    expect(screen.queryByTestId("first-run-card")).not.toBeInTheDocument()
  })

  it("keeps the non-secret form and shows the error after a rejected value", async () => {
    mocks.connectProviderKey.mockRejectedValueOnce(
      Object.assign(new Error('The provider field "key" is out of range'), {
        status: 400,
        code: "provider_form_invalid",
      }),
    )
    const user = userEvent.setup()
    wrap(gate())

    await screen.findByTestId("first-run-card")
    const key = screen.getByTestId("provider-key-input")
    await user.type(key, "short")
    await user.selectOptions(screen.getByTestId("provider-field-region"), "us")
    await user.click(screen.getByTestId("provider-connect-submit"))

    expect(await screen.findByTestId("first-run-error")).toHaveTextContent(
      "These provider details were rejected",
    )
    // The secret is not retained; the rest of the form is.
    expect(key).toHaveValue("")
    expect(screen.getByTestId("provider-field-region")).toHaveValue("us")
    expect(key).toHaveAttribute("aria-invalid", "true")
    expect(screen.getByTestId("first-run-card")).toBeInTheDocument()
  })
})

describe("provider oauth flow", () => {
  function oauthHarness(onConnected: () => Promise<void>) {
    return render(
      <I18nProvider initialLocale="en">
        <OAuthFlow
          providerID="fake-cloud"
          method={OAUTH_METHOD}
          pollMs={20}
          onConnected={onConnected}
        />
      </I18nProvider>,
    )
  }

  it("starts the attempt, shows the link and completes on a poll", async () => {
    mocks.providerOAuthStatus
      .mockResolvedValueOnce({ status: "pending" })
      .mockResolvedValueOnce({ status: "complete" })
    const onConnected = vi.fn(async () => undefined)
    const user = userEvent.setup()
    oauthHarness(onConnected)

    await user.click(screen.getByTestId("oauth-start"))
    expect(await screen.findByTestId("oauth-link")).toHaveAttribute(
      "href",
      "https://example.invalid/auth",
    )
    await waitFor(() => expect(onConnected).toHaveBeenCalledTimes(1))
    expect(await screen.findByText("Signed in.")).toBeInTheDocument()
  })

  it("can submit a pasted code when the host asks for one", async () => {
    mocks.startProviderOAuth.mockResolvedValueOnce({
      attempt: {
        id: "attempt-2",
        url: "https://example.invalid/auth",
        instructions: null,
        code: null,
        needsCode: true,
        expires: 60_000,
      },
    })
    const onConnected = vi.fn(async () => undefined)
    const user = userEvent.setup()
    oauthHarness(onConnected)

    await user.click(screen.getByTestId("oauth-start"))
    await user.type(await screen.findByTestId("oauth-code-input"), "abc-123")
    await user.click(screen.getByTestId("oauth-complete"))

    await waitFor(() =>
      expect(mocks.completeProviderOAuth).toHaveBeenCalledWith("fake-cloud", "attempt-2", "abc-123"),
    )
    await waitFor(() => expect(onConnected).toHaveBeenCalledTimes(1))
  })

  it("cancels the attempt and returns to the start form", async () => {
    const onConnected = vi.fn(async () => undefined)
    const user = userEvent.setup()
    oauthHarness(onConnected)

    await user.click(screen.getByTestId("oauth-start"))
    await screen.findByTestId("oauth-cancel")
    await user.click(screen.getByTestId("oauth-cancel"))

    expect(mocks.cancelProviderOAuth).toHaveBeenCalledWith("fake-cloud", "attempt-1")
    expect(await screen.findByTestId("oauth-start")).toBeInTheDocument()
    expect(screen.queryByTestId("oauth-link")).not.toBeInTheDocument()
    expect(onConnected).not.toHaveBeenCalled()
  })

  it("is the selected method on the card when the host offers only oauth", async () => {
    mocks.providers.mockResolvedValue(OAUTH_PROVIDERS)
    const user = userEvent.setup()
    wrap(gate())
    await screen.findByTestId("first-run-card")
    await user.click(screen.getByTestId("provider-method-fake-cloud-browser"))
    expect(screen.getByTestId("oauth-start")).toBeInTheDocument()
  })
})

describe("default model on a new session", () => {
  function CreateProbe() {
    const sessions = useSessions()
    return (
      <button type="button" data-testid="create-session" onClick={() => void sessions.create()}>
        create
      </button>
    )
  }

  it("passes the browser choice to session creation", async () => {
    const user = userEvent.setup()
    render(
      <I18nProvider initialLocale="en">
        <CompletionProvider
          catalogue={{ models: [MODEL], agents: [{ id: "build", name: "Build" }] }}
          initial={{ model: "fake/echo", agent: "build" }}
        >
          <SessionsProvider>
            <CreateProbe />
          </SessionsProvider>
        </CompletionProvider>
      </I18nProvider>,
    )

    await user.click(screen.getByTestId("create-session"))
    await waitFor(() =>
      expect(mocks.createSession).toHaveBeenCalledWith({
        model: "fake/echo",
        agent: "build",
      }),
    )
  })
})
