import { StrictMode } from "react"
import { createRoot } from "react-dom/client"
import { BrowserRouter } from "react-router-dom"
import App from "./App"
import { registerServiceWorker } from "./pwa/register"
import { applyInitialTheme } from "./theme/provider"
import "./styles.css"
import "./styles/highlight.css"
import "katex/dist/katex.min.css"

applyInitialTheme()
registerServiceWorker()

const container = document.getElementById("root")
if (!container) throw new Error("Missing #root element")

createRoot(container).render(
  <StrictMode>
    <BrowserRouter>
      <App />
    </BrowserRouter>
  </StrictMode>,
)
