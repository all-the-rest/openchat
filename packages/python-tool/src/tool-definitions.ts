/**
 * JSON-RPC tool definitions for the python-tool MCP server. Kept in its own
 * module so `mcp.ts` stays under the 400-line ceiling. The protocol handling
 * and stdio transport live there; this file is only the tool catalogue.
 */

const RETRY = "If the tool rejects the input, fix exactly what the message names and retry at most twice."

export const DOCX_TOOL = {
  name: "docx_fill",
  title: "Create or fill a Word document",
  description: [
    "Create a DOCX from `paragraphs`, or fill an existing DOCX produced by this tool (`templateArtifactID`).",
    "`values` replaces `{{name}}` placeholders in paragraphs, tables, headers and footers.",
    "Pass exactly one of `paragraphs` and `templateArtifactID`. The result is stored as an artifact.",
    RETRY,
  ].join(" "),
  inputSchema: {
    type: "object",
    properties: {
      title: { type: "string", description: "Artifact title, at most 120 characters." },
      outputName: { type: "string", description: "Optional file name ending in .docx." },
      paragraphs: {
        type: "array",
        items: { type: "string" },
        description: "1–200 paragraphs; use {{key}} placeholders. Required without a template.",
      },
      templateArtifactID: {
        type: "string",
        description: "64-hex id of a .docx artifact produced by this tool. Required without paragraphs.",
      },
      values: {
        type: "object",
        additionalProperties: { type: "string" },
        description: "Placeholder values, at most 64 entries.",
      },
    },
    required: ["title"],
    additionalProperties: false,
  },
} as const

export const DOCX_FROM_TEXT_TOOL = {
  name: "docx_from_text",
  title: "Create a Word document from blocks or Markdown",
  description: [
    "Create a new DOCX from typed `blocks` or from a small Markdown subset (h1-h3, paragraphs,",
    "`-`/`*` bullets, fenced code, pipe tables with a header row). Pass exactly one of `blocks` and",
    "`markdown`. The page is A4 with 2 cm margins and a fixed style set; identical input produces",
    "identical bytes. The file is written into the chat folder at `chatPath`",
    "(`<sessionID>/files/<name>.docx`, relative to WORKSPACE_DIR/chats) and stored as a downloadable",
    "artifact card as well. No HTML, no images, no template. Block errors name the parsed block.",
    RETRY,
  ].join(" "),
  inputSchema: {
    type: "object",
    properties: {
      title: {
        type: "string",
        description: "Optional artifact title and document heading, at most 120 characters.",
      },
      chatPath: {
        type: "string",
        description: "Where to create the file: <sessionID>/files/<name>.docx. Never absolute.",
      },
      blocks: {
        type: "array",
        description: "1–500 blocks; 20 000 characters of text and 50×8 table cells in total.",
        items: {
          type: "object",
          properties: {
            kind: {
              type: "string",
              enum: ["heading", "paragraph", "bullet", "code", "table"],
            },
            text: { type: "string", description: "Required for every kind except table." },
            level: { type: "integer", enum: [1, 2, 3], description: "Heading level." },
            rows: {
              type: "array",
              description: "Table rows; the first row is the header. Same width in every row.",
              items: { type: "array", items: { type: "string" } },
            },
          },
          required: ["kind"],
          additionalProperties: false,
        },
      },
      markdown: {
        type: "string",
        description:
          "Markdown source, at most 20 000 characters; converted to the same blocks. No HTML.",
      },
    },
    required: ["chatPath"],
    additionalProperties: false,
  },
} as const

export const XLSX_TOOL = {
  name: "xlsx_write",
  title: "Write a spreadsheet",
  description: [
    "Write one XLSX sheet with typed cells. `rows` hold strings, numbers, booleans or null;",
    "formulas are set explicitly with `formulas` ({ \"B2\": \"SUM(B1:B1)\" }).",
    "A data cell starting with = is rejected; use the formulas map. The result is stored as an artifact.",
    RETRY,
  ].join(" "),
  inputSchema: {
    type: "object",
    properties: {
      title: { type: "string", description: "Artifact title, at most 120 characters." },
      outputName: { type: "string", description: "Optional file name ending in .xlsx." },
      sheet: { type: "string", description: "Sheet name, at most 31 characters." },
      headers: { type: "array", items: { type: "string" }, description: "1–50 column headers." },
      rows: {
        type: "array",
        items: { type: "array", items: { type: ["string", "number", "boolean", "null"] } },
        description: "At most 5000 rows; each row has exactly one cell per header.",
      },
      formulas: {
        type: "object",
        additionalProperties: { type: "string" },
        description: "Cell reference to formula, e.g. {\"D2\": \"B2*C2\"}.",
      },
    },
    required: ["title", "sheet", "headers", "rows"],
    additionalProperties: false,
  },
} as const

export const PDF_TOOL = {
  name: "pdf_from_markdown",
  title: "Create a PDF from Markdown",
  description: [
    "Render Markdown (headings, lists, paragraphs, fenced code) to a PDF with selectable text.",
    "No fonts or resources are fetched; the result is stored as an artifact.",
    RETRY,
  ].join(" "),
  inputSchema: {
    type: "object",
    properties: {
      title: { type: "string", description: "Artifact title, at most 120 characters." },
      outputName: { type: "string", description: "Optional file name ending in .pdf." },
      markdown: { type: "string", description: "Markdown source, at most 200 KiB." },
    },
    required: ["title", "markdown"],
    additionalProperties: false,
  },
} as const

export const READ_TOOL = {
  name: "read_document",
  title: "Read a document as Markdown",
  description: [
    "Extract Markdown from a DOCX, XLSX, PPTX, PDF or text artifact produced by this tool set.",
    "Conversion uses the bundled markitdown converter; no model or font is downloaded.",
    "The preview is returned in the result and the full text is stored as a .md artifact.",
    RETRY,
  ].join(" "),
  inputSchema: {
    type: "object",
    properties: {
      title: { type: "string", description: "Optional title for the extracted Markdown artifact." },
      sourceArtifactID: {
        type: "string",
        description: "64-hex id of a document artifact produced by this tool set.",
      },
    },
    required: ["sourceArtifactID"],
    additionalProperties: false,
  },
} as const

export const DOCUMENTS_FILL_TOOL = {
  name: "documents_fill",
  title: "Fill an uploaded Word template and export a PDF",
  description: [
    "Fill a .docx/.dotx template that was uploaded into a chat, then write the filled DOCX and",
    "its LibreOffice PDF back into the same chat's files folder. `templatePath` is relative:",
    "`<sessionID>/files/<name>.docx|.dotx` under WORKSPACE_DIR/chats. Never pass an absolute path.",
    "`values` may hold scalars and lists/maps for `{% for %}` loops. Macro-enabled files are rejected.",
    "Both file names are returned; each file is also stored as a downloadable artifact card.",
    RETRY,
  ].join(" "),
  inputSchema: {
    type: "object",
    properties: {
      templatePath: { type: "string", description: "Relative path <sessionID>/files/<name>.docx|.dotx" },
      values: { type: "object", description: "Placeholder values; at most 64 keys." },
      name: { type: "string", description: "Optional base name for the two outputs." },
    },
    required: ["templatePath", "values"],
    additionalProperties: false,
  },
} as const

export const DOCUMENTS_CONVERT_TOOL = {
  name: "documents_convert",
  title: "Export a chat DOCX as PDF",
  description: [
    "Convert a .docx in a chat's files folder to PDF with LibreOffice and write the PDF back",
    "into that folder. `templatePath` is `<sessionID>/files/<name>.docx` relative to WORKSPACE_DIR/chats.",
    "Never pass an absolute path. The PDF name is returned and stored as a downloadable card.",
    RETRY,
  ].join(" "),
  inputSchema: {
    type: "object",
    properties: {
      templatePath: { type: "string", description: "Relative path <sessionID>/files/<name>.docx" },
      name: { type: "string", description: "Optional base name for the PDF." },
    },
    required: ["templatePath"],
    additionalProperties: false,
  },
} as const

export const ARCHIVE_LIST_TOOL = {
  name: "archive_list",
  title: "List the contents of a ZIP file",
  description: [
    "List the entries of a plain `.zip` uploaded to this chat: name, uncompressed size,",
    "compressed size and directory flag, plus totals. `zipPath` is",
    "`<sessionID>/files/<name>.zip` relative to WORKSPACE_DIR/chats; never an absolute path.",
    "Caps: 500 entries, depth 10, 200 MiB total uncompressed. Encrypted entries and unsafe",
    "names are refused. DOCX, XLSX and PPTX are ZIP containers but are read with",
    "`read_document`; the archive tools are for plain `.zip` only, and `.tar.gz` is not supported.",
    RETRY,
  ].join(" "),
  inputSchema: {
    type: "object",
    properties: {
      zipPath: { type: "string", description: "Relative path <sessionID>/files/<name>.zip" },
    },
    required: ["zipPath"],
    additionalProperties: false,
  },
} as const

export const ARCHIVE_EXTRACT_TOOL = {
  name: "archive_extract",
  title: "Extract a ZIP into this chat's files",
  description: [
    "Extract a plain `.zip` into `files/<directory>/` in the same chat; `zipPath` is",
    "`<sessionID>/files/<name>.zip` relative to WORKSPACE_DIR/chats. Nothing is overwritten:",
    "an existing target is refused with `already_exists` and leaves no partial output.",
    "Symlinks, device entries, absolute names, `..` segments and Windows drive prefixes are",
    "rejected. Caps: 500 entries, depth 10, 200 MiB uncompressed, 20 MiB per file, the chat's",
    "quota, and a 100:1 compression-ratio bomb guard over both declared and written bytes.",
    "DOCX, XLSX and PPTX are read with `read_document`; `.tar.gz` is not supported.",
    RETRY,
  ].join(" "),
  inputSchema: {
    type: "object",
    properties: {
      zipPath: { type: "string", description: "Relative path <sessionID>/files/<name>.zip" },
      directory: {
        type: "string",
        description: "New subdirectory under files/, 1-64 characters of letters, digits, dot, dash or underscore.",
      },
    },
    required: ["zipPath", "directory"],
    additionalProperties: false,
  },
} as const

export const TOOLS = [
  DOCX_TOOL,
  DOCX_FROM_TEXT_TOOL,
  XLSX_TOOL,
  PDF_TOOL,
  READ_TOOL,
  DOCUMENTS_FILL_TOOL,
  DOCUMENTS_CONVERT_TOOL,
  ARCHIVE_LIST_TOOL,
  ARCHIVE_EXTRACT_TOOL,
] as const
