import { createApp } from "./app"
import { loadEnv } from "./env"
import { createNodeServer } from "./node"

const config = loadEnv()
const app = createApp({ config })

createNodeServer(app).listen(config.PORT, config.HOST, () => {
  console.log(`[openchat] code host listening on http://${config.HOST}:${config.PORT}`)
})
