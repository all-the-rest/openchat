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

function renderLogin() {
  return render(
    <ThemeProvider initialTheme="dark">
      <I18nProvider initialLocale="en">
        <MemoryRouter initialEntries={["/login"]}>
          <Routes>
            <Route path="/login" element={<LoginPage />} />
          </Routes>
        </MemoryRouter>
      </I18nProvider>
    </ThemeProvider>,
  )
}

beforeEach(() => {
  auth.signIn.mockReset()
})

describe("login error codes", () => {
  it.each([
    ["invalid_credentials", new ApiError(400, "Invalid credentials", "invalid_credentials")],
    ["invalid_password", new ApiError(401, "Invalid password", "invalid_password")],
  ])("shows the wrong-password message for %s", async (_code, failure) => {
    const user = userEvent.setup()
    auth.signIn.mockRejectedValue(failure)

    renderLogin()
    await user.type(screen.getByTestId("login-password"), "secret")
    await user.click(screen.getByTestId("login-submit"))

    await waitFor(() => expect(auth.signIn).toHaveBeenCalledWith("secret"))
    expect(await screen.findByRole("alert")).toHaveTextContent("Wrong password. Try again.")
  })
})
