/** The composer's file picker and one chip per pending/attached upload. */
import { useRef, type ChangeEvent } from "react"
import type { MessageKey } from "../i18n"
import { useI18n, useT } from "../i18n/provider"
import { PaperclipIcon } from "../components/icons"
import { formatChatFileSize } from "./files"
import type { Attachment } from "./useAttachments"

const ACCEPT =
  ".txt,.md,.csv,.json,.log,.png,.jpg,.jpeg,.gif,.webp,.pdf,.docx,.xlsx,.pptx,.zip,image/*,application/pdf"

export function AttachmentPicker({ onPick }: { onPick(files: readonly File[]): void }) {
  const t = useT()
  const input = useRef<HTMLInputElement>(null)

  const handleChange = (event: ChangeEvent<HTMLInputElement>) => {
    onPick(Array.from(event.target.files ?? []))
    event.target.value = ""
  }

  return (
    <>
      <button
        type="button"
        data-testid="attach-button"
        onClick={() => input.current?.click()}
        aria-label={t("composer.attach")}
        title={t("composer.attach")}
        className="btn btn-ghost btn-sm btn-circle shrink-0"
      >
        <PaperclipIcon className="size-5" />
      </button>
      <input
        ref={input}
        type="file"
        multiple
        accept={ACCEPT}
        data-testid="attachment-input"
        aria-label={t("composer.attach")}
        className="hidden"
        onChange={handleChange}
      />
    </>
  )
}

function errorKey(code: string | undefined): MessageKey {
  switch (code) {
    case "unsupported_media_type":
      return "composer.attachmentTypeError"
    case "payload_too_large":
      return "composer.attachmentTooLarge"
    case "quota_exceeded":
      return "composer.attachmentQuotaError"
    default:
      return "composer.attachmentFailed"
  }
}

interface ChipListProps {
  attachments: readonly Attachment[]
  onRemove(id: number): void
}

export function AttachmentChipList({ attachments, onRemove }: ChipListProps) {
  const t = useT()
  const { locale } = useI18n()

  return (
    <ul
      data-testid="attachment-list"
      aria-label={t("composer.attachmentsLabel")}
      className="flex flex-wrap gap-1.5 pb-2"
    >
      {attachments.map((item) => (
        <li
          key={item.id}
          data-testid="attachment-chip"
          data-status={item.status}
          aria-busy={item.status === "uploading"}
          className={`badge gap-1.5 py-1 ${
            item.status === "error" ? "badge-error" : "badge-ghost"
          }`}
        >
          <span data-testid="attachment-name" className="max-w-48 truncate" title={item.name}>
            {item.name}
          </span>
          <span data-testid="attachment-size" className="text-xs opacity-70">
            {formatChatFileSize(item.size, locale)}
          </span>
          {item.status === "uploading" ? (
            <span data-testid="attachment-uploading" className="text-xs">
              {t("composer.attachmentUploading")}
            </span>
          ) : null}
          {item.status === "error" ? (
            <span data-testid="attachment-error" className="text-xs">
              {t(errorKey(item.errorCode))}
            </span>
          ) : null}
          <button
            type="button"
            data-testid="attachment-remove"
            onClick={() => onRemove(item.id)}
            aria-label={t("composer.attachmentRemove", { name: item.name })}
            className="btn btn-ghost btn-xs px-1"
          >
            ×
          </button>
        </li>
      ))}
    </ul>
  )
}
