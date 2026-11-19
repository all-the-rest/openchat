import { EVENT } from "@openchat/contracts"
import type { FormAnswer, FormField, FormRequest } from "@openchat/contracts"
import { BackendError } from "./errors"

type Emit = (
  type: string,
  sessionID: string,
  data: Record<string, unknown>,
  durable: boolean,
) => unknown

/** A small, realistic field set: text, select, confirm and a multi-choice. */
const SEED_FIELDS: FormField[] = [
  {
    key: "summary",
    type: "string",
    title: "What should the answer cover?",
    required: true,
    placeholder: "For example: the three largest costs",
  },
  {
    key: "tone",
    type: "string",
    title: "Tone",
    options: [
      { value: "brief", label: "Brief" },
      { value: "detailed", label: "Detailed" },
    ],
    default: "brief",
  },
  {
    key: "confirm",
    type: "boolean",
    title: "Share the result with the team",
  },
]

/**
 * Open forms of the fake host, mirroring `session.form`. `seed` is the
 * fake-mode control that opens one; a reply removes it and emits the same
 * `form.replied` envelope the live adapter produces.
 */
export class FakeForms {
  private readonly bySession = new Map<string, Map<string, FormRequest>>()
  private count = 0

  constructor(private readonly emit: Emit) {}

  list(sessionID: string): FormRequest[] {
    return [...(this.bySession.get(sessionID)?.values() ?? [])].map(cloneForm)
  }

  seed(sessionID: string, fields: FormField[] = SEED_FIELDS): FormRequest {
    this.count += 1
    const form: FormRequest = {
      id: `frm_${this.count}`,
      sessionID,
      title: "A few questions before I continue",
      fields: cloneFields(fields),
    }
    const forms = this.bySession.get(sessionID) ?? new Map<string, FormRequest>()
    forms.set(form.id, form)
    this.bySession.set(sessionID, forms)
    this.emit(EVENT.formCreated, sessionID, { sessionID, form: cloneForm(form) }, true)
    return cloneForm(form)
  }

  reply(sessionID: string, formID: string, answer: FormAnswer): void {
    const forms = this.bySession.get(sessionID)
    const form = forms?.get(formID)
    if (!form || !forms) {
      throw new BackendError("not_found", `Unknown form: ${formID}`)
    }
    forms.delete(formID)
    if (forms.size === 0) this.bySession.delete(sessionID)
    this.emit(EVENT.formReplied, sessionID, { sessionID, id: formID, answer }, true)
  }

  /** Drops a session's forms when the chat is deleted. */
  forget(sessionID: string): void {
    this.bySession.delete(sessionID)
  }
}

function cloneFields(fields: readonly FormField[]): FormField[] {
  return fields.map((field) => ({ ...field }))
}

function cloneForm(form: FormRequest): FormRequest {
  return { ...form, fields: cloneFields(form.fields) }
}
