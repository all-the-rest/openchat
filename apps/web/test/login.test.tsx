import { render, screen, waitFor } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { MemoryRouter, Route, Routes } from "react-router-dom"
import { beforeEach, describe, expect, it, vi } from "vitest"
import { ApiError } from "../src/api/client"
import { I18nProvider } from "../src/i18n/provider"
import { LoginPage } from "../src/pages/LoginPage"
import { ThemeProvider } from "../src/theme/provider"

const auth = vi.hoisted(() => ({ signIn: vi.fn() }))

vi.mock("../src/auth/provider", () => ({
  useAuth: () => ({
    status: "unauthenticated",
    user: null,
    signIn: auth.signIn,
    signOut: vi.fn(),
    retry: vi.fn(),
  }),
}))

function renderLogin(state?: unknown) {
  return render(
    <ThemeProvider initialTheme="dark">
      <I18nProvider initialLocale="en">
        <MemoryRouter initialEntries={[{ pathname: "/login", state }]}>
          <Routes>
            <Route path="/login" element={<LoginPage />} />
            <Route path="/" element={<p>landing page</p>} />
            <Route path="/settings" element={<p>settings page</p>} />
          </Routes>
        </MemoryRouter>
      </I18nProvider>
    </ThemeProvider>,
  )
}

async function signIn(user: ReturnType<typeof userEvent.setup>) {
  await user.type(screen.getByTestId("login-user"), "owner")
  await user.type(screen.getByTestId("login-password"), "secret")
  await user.click(screen.getByTestId("login-submit"))
  await waitFor(() => expect(auth.signIn).toHaveBeenCalledWith("owner", "secret"))
}

beforeEach(() => {
  auth.signIn.mockReset()
})

describe("login form", () => {
  it("focuses the username field and sends both credentials", async () => {
    const user = userEvent.setup()
    auth.signIn.mockResolvedValue(undefined)

    renderLogin()
    expect(screen.getByTestId("login-user")).toHaveFocus()
    expect(screen.getByTestId("login-user")).toHaveAttribute("autocomplete", "username")
    expect(screen.getByTestId("login-password")).toHaveAttribute(
      "autocomplete",
      "current-password",
    )

    await signIn(user)
  })

  it("keeps the submit button disabled until both fields are filled", async () => {
    const user = userEvent.setup()
    renderLogin()

    const submit = screen.getByTestId("login-submit")
    expect(submit).toBeDisabled()

    await user.type(screen.getByTestId("login-user"), "owner")
    expect(submit).toBeDisabled()

    await user.type(screen.getByTestId("login-password"), "secret")
    expect(submit).toBeEnabled()
  })
})

describe("login error codes", () => {
  it.each([
    ["invalid_credentials", new ApiError(400, "Invalid credentials", "invalid_credentials")],
    ["invalid_password", new ApiError(401, "Invalid password", "invalid_password")],
  ])("shows the wrong-credentials message for %s", async (_code, failure) => {
    const user = userEvent.setup()
    auth.signIn.mockRejectedValue(failure)

    renderLogin()
    await user.type(screen.getByTestId("login-user"), "owner")
    await user.type(screen.getByTestId("login-password"), "secret")
    await user.click(screen.getByTestId("login-submit"))

    await waitFor(() => expect(auth.signIn).toHaveBeenCalledWith("owner", "secret"))
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Wrong username or password. Try again.",
    )
  })
})

describe("login redirect", () => {
  it("returns to the requested route after signing in", async () => {
    const user = userEvent.setup()
    auth.signIn.mockResolvedValue(undefined)

    renderLogin({ from: "/settings" })
    await signIn(user)

    expect(await screen.findByText("settings page")).toBeInTheDocument()
  })

  it.each([
    ["a protocol-relative path", { from: "//evil.example" }],
    ["a non-string value", { from: 42 }],
    ["an absent state", undefined],
  ])("falls back to the landing page for %s", async (_label, state) => {
    const user = userEvent.setup()
    auth.signIn.mockResolvedValue(undefined)

    renderLogin(state)
    await signIn(user)

    expect(await screen.findByText("landing page")).toBeInTheDocument()
    expect(screen.queryByText("settings page")).toBeNull()
  })
})
