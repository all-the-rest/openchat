import { expect, test } from "@playwright/test"
import { STT_MODEL_TOTAL_BYTES, STT_MODEL_VERSION } from "@openchat/contracts"
import { guardExternalRequests, login, startChat } from "./helpers"
import { LOCAL_STT_BFF_PORT, LOCAL_STT_WEB_PORT } from "./local-stt-fixture"

/** Must match the fake worker below; no real weights or network are involved. */
const LOCAL_TRANSCRIPT = "Diktat lokal im Browser."

test.describe("on-device dictation", () => {
  test.use({ baseURL: `http://localhost:${LOCAL_STT_WEB_PORT}` })

  test("records locally with no server STT and no request leaving the origin", async ({ page }) => {
    // Injected test hook: only the speech worker is replaced, in this browser
    // context. There is no production hook that bypasses the model.
    await page.addInitScript(
      ({ version, bytes }) => {
        localStorage.setItem(
          "openchat.stt.consent",
          JSON.stringify({ version, decision: "accepted", totalBytes: bytes }),
        )
        const RealWorker = window.Worker
        function stubWorker(url: string | URL, options?: WorkerOptions): Worker {
          if (!String(url).includes("local-worker")) return new RealWorker(url, options)
          const stub = {
            onmessage: null as ((event: MessageEvent) => void) | null,
            postMessage(message: { type: string }): void {
              if (message.type === "load") {
                window.setTimeout(() => {
                  stub.onmessage?.({ data: { type: "ready", device: "wasm" } } as MessageEvent)
                }, 0)
                return
              }
              if (message.type !== "transcribe") return
              window.setTimeout(() => {
                stub.onmessage?.({
                  data: { type: "result", text: "Diktat lokal im Browser.", durationMs: 10 },
                } as MessageEvent)
              }, 30)
            },
            terminate(): void {
              stub.onmessage = null
            },
          }
          return stub as unknown as Worker
        }
        ;(window as unknown as { Worker: typeof Worker }).Worker = stubWorker as unknown as typeof Worker
      },
      { version: STT_MODEL_VERSION, bytes: STT_MODEL_TOTAL_BYTES },
    )

    const external = guardExternalRequests(page)
    const modelRequests: string[] = []
    const transcribeRequests: string[] = []
    page.on("request", (request) => {
      const url = new URL(request.url())
      if (url.port === String(LOCAL_STT_BFF_PORT) && url.pathname.startsWith("/models/")) {
        modelRequests.push(url.pathname)
      }
      if (url.pathname === "/api/transcribe") transcribeRequests.push(request.method())
    })

    await page.goto("/")
    await login(page)
    await startChat(page)
    const composer = page.getByTestId("composer")
    const mic = page.getByTestId("dictation")

    await expect(mic).toBeVisible()
    await expect(page.getByTestId("dictation-path")).toContainText("on this device")
    await expect(page.getByTestId("dictation-consent")).toBeHidden()

    await composer.fill("Notiz: ")
    await composer.press("End")
    await mic.click()
    await expect(page.getByTestId("dictation-pill")).toBeVisible()
    await page.getByTestId("dictation-stop").click()

    await expect(composer).toHaveValue(`Notiz: ${LOCAL_TRANSCRIPT}`)
    await expect(page.getByTestId("dictation-busy")).toBeHidden()
    expect(transcribeRequests).toEqual([])
    expect(modelRequests).toEqual([])
    expect(external).toEqual([])
  })
})
