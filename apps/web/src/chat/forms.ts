import type {
  FormAnswer,
  FormAnswerValue,
  FormField,
  FormRequest,
} from "@openchat/contracts"
import { EVENT } from "@openchat/contracts"
import { useCallback, useEffect, useState } from "react"
import { ApiError, api } from "../api/client"
import { useEventStreamOrNull } from "../api/events"

export interface FormsValue {
  forms: FormRequest[]
  busy: boolean
  failure: boolean
  /** Forms the BFF accepted; their cards wait for `form.replied`. */
  submitted: ReadonlySet<string>
  /** Forms that closed before this answer arrived (404/409). */
  expired: ReadonlySet<string>
  reply: (formID: string, answer: FormAnswer) => Promise<boolean>
}

/** Condition `when` entries a host attaches to a field. */
export function isFormFieldVisible(field: FormField, answer: FormAnswer): boolean {
  if (field.hidden === true) return false
  const when = field.when
  if (!when || when.length === 0) return true
  return when.every((condition) => {
    const actual = answer[condition.key]
    const equal = matches(actual, condition.value)
    return condition.op === "eq" ? equal : !equal
  })
}

function matches(actual: FormAnswerValue | undefined, expected: string | number | boolean): boolean {
  if (actual === undefined) return false
  if (Array.isArray(actual)) return actual.map(String).includes(String(expected))
  if (typeof actual === typeof expected) return actual === expected
  return String(actual) === String(expected)
}

/** Defaults the host declared, for the first render of a card. */
export function initialFormAnswers(form: FormRequest): FormAnswer {
  const answer: FormAnswer = {}
  for (const field of form.fields) {
    if (field.hidden === true) continue
    if (field.type === "external") continue
    if (field.default !== undefined) answer[field.key] = field.default
  }
  return answer
}

const FIELD_TYPES = new Set(["string", "number", "integer", "boolean", "multiselect", "external"])

function readField(value: unknown): FormField | null {
  if (value === null || typeof value !== "object") return null
  const field = value as Record<string, unknown>
  if (typeof field.key !== "string") return null
  if (typeof field.type !== "string" || !FIELD_TYPES.has(field.type)) return null
  // The BFF only forwards host fields; the envelope is checked here so a
  // malformed event cannot break the whole transcript.
  return field as unknown as FormField
}

/** One `form.created` payload, or null when it does not carry a usable form. */
export function readCreatedForm(value: unknown): FormRequest | null {
  if (value === null || typeof value !== "object") return null
  const form = value as Record<string, unknown>
  if (typeof form.id !== "string" || typeof form.sessionID !== "string") return null
  if (typeof form.title !== "string" || !Array.isArray(form.fields)) return null
  const fields = form.fields.map(readField).filter((field): field is FormField => field !== null)
  if (fields.length === 0) return null
  return { id: form.id, sessionID: form.sessionID, title: form.title, fields }
}

/**
 * Open question forms of one session. Like the permission hook, the initial
 * list survives a reload, `form.created` adds a card and `form.replied` /
 * `form.cancelled` remove it. A reply the BFF rejects because the form already
 * closed marks the card expired instead of failing silently.
 */
export function useForms(sessionID: string): FormsValue {
  const [forms, setForms] = useState<FormRequest[]>([])
  const [busy, setBusy] = useState(false)
  const [failure, setFailure] = useState(false)
  const [submitted, setSubmitted] = useState<ReadonlySet<string>>(() => new Set())
  const [expired, setExpired] = useState<ReadonlySet<string>>(() => new Set())
  const stream = useEventStreamOrNull()

  useEffect(() => {
    let active = true
    setForms([])
    setFailure(false)
    setSubmitted(new Set())
    setExpired(new Set())
    void api.listForms(sessionID)
      .then((list) => {
        if (active) setForms(list)
      })
      .catch(() => {
        if (active) setForms([])
      })
    return () => {
      active = false
    }
  }, [sessionID])

  useEffect(() => {
    if (!stream) return
    return stream.subscribe((event) => {
      const data = event.data
      if (typeof data.sessionID === "string" && data.sessionID !== sessionID) return
      if (event.type === EVENT.formCreated) {
        const form = readCreatedForm(data.form)
        if (!form || form.sessionID !== sessionID) return
        setForms((current) =>
          current.some((entry) => entry.id === form.id) ? current : [...current, form],
        )
      }
      if (event.type === EVENT.formReplied || event.type === EVENT.formCancelled) {
        const formID = typeof data.id === "string" ? data.id : ""
        if (!formID) return
        setForms((current) => current.filter((entry) => entry.id !== formID))
        setSubmitted((current) => without(current, formID))
        setExpired((current) => without(current, formID))
      }
    })
  }, [stream, sessionID])

  const reply = useCallback(
    async (formID: string, answer: FormAnswer) => {
      setBusy(true)
      setFailure(false)
      try {
        await api.replyForm(sessionID, formID, answer)
        // The `form.replied` event removes the card; marking it here keeps the
        // state honest while the stream catches up.
        setSubmitted((current) => withID(current, formID))
        return true
      } catch (error) {
        if (error instanceof ApiError && (error.code === "not_found" || error.code === "conflict")) {
          setExpired((current) => withID(current, formID))
        } else {
          setFailure(true)
        }
        return false
      } finally {
        setBusy(false)
      }
    },
    [sessionID],
  )

  return { forms, busy, failure, submitted, expired, reply }
}

function withID(current: ReadonlySet<string>, id: string): ReadonlySet<string> {
  const next = new Set(current)
  next.add(id)
  return next
}

function without(current: ReadonlySet<string>, id: string): ReadonlySet<string> {
  if (!current.has(id)) return current
  const next = new Set(current)
  next.delete(id)
  return next
}
