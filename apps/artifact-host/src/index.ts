import { createApp } from "./app"
import { loadEnv } from "./env"
import { createNodeServer } from "./http"

const config = loadEnv()
const app = createApp({ config })

createNodeServer(app).listen(config.PORT, config.HOST, () => {
  // Never log the key or a signed URL; the bind address is all an operator needs.
  console.log(`[openchat] artifact host listening on ${config.HOST}:${config.PORT}`)
})
