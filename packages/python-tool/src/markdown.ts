/**
 * The Markdown subset `docx_from_text` accepts. It is deliberately tiny and
 * parses to the same block model a caller can pass directly, so both input
 * shapes go through one validator and one renderer:
 *
 *   h1-h3, paragraphs (soft line breaks become spaces), `-`/`*` bullets,
 *   fenced code and pipe tables (first row is the header, `|---|` delimiter).
 *
 * It is not a Markdown engine: no HTML, no images, no links, no nested lists,
 * no emphasis. Anything it does not recognise stays literal text.
 */

export type Block =
  | { kind: "heading"; level: 1 | 2 | 3; text: string }
  | { kind: "paragraph"; text: string }
  | { kind: "bullet"; text: string }
  | { kind: "code"; text: string }
  | { kind: "table"; rows: string[][] }

const HEADING = /^(#{1,3})[ \t]+(.*)$/
const BULLET = /^[ ]{0,3}[-*][ \t]+(.*)$/
const FENCE = /^[ ]{0,3}```/

function cellsOf(line: string): string[] {
  let body = line.trim()
  if (body.startsWith("|")) body = body.slice(1)
  if (body.endsWith("|")) body = body.slice(0, -1)
  return body.split("|").map((cell) => cell.trim())
}

function isDelimiter(line: string): boolean {
  if (!line.includes("|")) return false
  const cells = cellsOf(line)
  return cells.length > 0 && cells.every((cell) => /^:?-{3,}:?$/.test(cell))
}

function pad(cells: string[], width: number): string[] {
  const trimmed = cells.slice(0, width)
  while (trimmed.length < width) trimmed.push("")
  return trimmed
}

/** Never throws and never validates: `validate-from-text.ts` owns the limits. */
export function parseMarkdown(markdown: string): Block[] {
  const lines = markdown.replace(/\r\n?/g, "\n").split("\n")
  const blocks: Block[] = []
  let paragraph: string[] = []
  let index = 0

  const flush = (): void => {
    if (paragraph.length === 0) return
    blocks.push({ kind: "paragraph", text: paragraph.join(" ") })
    paragraph = []
  }

  while (index < lines.length) {
    const line = lines[index] ?? ""
    const trimmed = line.trim()
    if (trimmed.length === 0) {
      flush()
      index += 1
      continue
    }

    if (FENCE.test(line)) {
      flush()
      const code: string[] = []
      index += 1
      while (index < lines.length && !FENCE.test(lines[index] ?? "")) {
        code.push(lines[index] ?? "")
        index += 1
      }
      index += 1
      if (code.length > 0) blocks.push({ kind: "code", text: code.join("\n") })
      continue
    }

    const heading = HEADING.exec(line)
    if (heading && (heading[2] ?? "").trim().length > 0) {
      flush()
      blocks.push({
        kind: "heading",
        level: (heading[1] ?? "#").length as 1 | 2 | 3,
        text: (heading[2] ?? "").trim(),
      })
      index += 1
      continue
    }

    const bullet = BULLET.exec(line)
    if (bullet) {
      flush()
      blocks.push({ kind: "bullet", text: (bullet[1] ?? "").trim() })
      index += 1
      continue
    }

    if (line.includes("|") && isDelimiter(lines[index + 1] ?? "")) {
      flush()
      const rows = [cellsOf(line)]
      const width = rows[0]?.length ?? 0
      index += 2
      while (index < lines.length) {
        const candidate = lines[index] ?? ""
        if (candidate.trim().length === 0 || !candidate.includes("|")) break
        rows.push(pad(cellsOf(candidate), width))
        index += 1
      }
      blocks.push({ kind: "table", rows })
      continue
    }

    paragraph.push(trimmed)
    index += 1
  }

  flush()
  return blocks
}
