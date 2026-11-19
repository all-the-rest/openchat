import { z } from "zod"

/**
 * One interactive form the host asks the user to fill in (FR-16). The shape
 * mirrors `Form.Fields` of the pinned `@opencode/client`: a field is a tagged
 * record, and `external` fields point at a page instead of asking for a value.
 */

export interface FormFieldOption {
  value: string
  label: string
  description?: string
}

/** Conditional visibility the host attaches to a field. */
export interface FormFieldCondition {
  key: string
  op: "eq" | "neq"
  value: string | number | boolean
}

interface FormFieldBase {
  key: string
  title?: string
  description?: string
  required?: boolean
  hidden?: boolean
  when?: FormFieldCondition[]
}

/** A free-text field; `options` turns it into a select and `custom` allows text. */
export interface FormTextField extends FormFieldBase {
  type: "string"
  format?: "email" | "uri" | "date" | "date-time"
  minLength?: number
  maxLength?: number
  pattern?: string
  placeholder?: string
  default?: string
  options?: FormFieldOption[]
  custom?: boolean
}

/** `integer` is the host's whole-number variant of the numeric field. */
export interface FormNumberField extends FormFieldBase {
  type: "number" | "integer"
  minimum?: number
  maximum?: number
  default?: number
}

export interface FormBooleanField extends FormFieldBase {
  type: "boolean"
  default?: boolean
}

export interface FormMultiselectField extends FormFieldBase {
  type: "multiselect"
  options: FormFieldOption[]
  minItems?: number
  maxItems?: number
  custom?: boolean
  default?: string[]
}

/** An external step: the host answers it elsewhere, the card only links there. */
export interface FormExternalField extends FormFieldBase {
  type: "external"
  url: string
}

export type FormField =
  | FormTextField
  | FormNumberField
  | FormBooleanField
  | FormMultiselectField
  | FormExternalField

/** The values `Form.Answer` accepts, keyed by field key. */
export type FormAnswerValue = string | number | boolean | string[]
export type FormAnswer = Record<string, FormAnswerValue>

export interface FormRequest {
  id: string
  sessionID: string
  title: string
  fields: FormField[]
}

export interface FormsResponse {
  forms: FormRequest[]
}

export const formAnswerValueSchema = z.union([
  z.string(),
  z.number(),
  z.boolean(),
  z.array(z.string()),
])

/** One reply body: every answered field key with its value. */
export const formReplyRequestSchema = z.object({
  answer: z.record(z.string(), formAnswerValueSchema),
})
