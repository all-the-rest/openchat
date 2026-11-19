/**
 * English catalogue and the source of the `MessageKey` union.
 *
 * The descriptors are split by feature only to keep each file small; ids stay
 * flat and stable. `lingui extract` reads this module (and the feature modules
 * it imports) into the PO catalogs under `src/locales`. Never edit the compiled
 * `messages.ts` output by hand.
 */
import { apps } from "./apps"
import { artifacts } from "./artifacts"
import { chat } from "./chat"
import { code } from "./code"
import { dictation } from "./dictation"
import { files } from "./files"
import { memory } from "./memory"
import { palette } from "./palette"
import { pwa } from "./pwa"
import { render } from "./render"
import { search } from "./search"
import { settings } from "./settings"
import { shell } from "./shell"
import { tasks } from "./tasks"

export const messages = {
  ...shell,
  ...code,
  ...search,
  ...apps,
  ...artifacts,
  ...chat,
  ...dictation,
  ...files,
  ...memory,
  ...palette,
  ...pwa,
  ...render,
  ...settings,
  ...tasks,
} as const

export type MessageKey = keyof typeof messages
export type MessageVars = Record<string, string | number>
