export type PaginatedResponse<T, ExtraMetadata extends Record<string, unknown> = Record<string, unknown>> = {
  data: T[];
  meta: {
    /**
     * The current page number.
     */
    currentPage: number;
    /**
     * The total number of pages.
     */
    totalPages: number;
    /**
     * The total number of items.
     */
    total: number;
  } & ExtraMetadata;
};

export type SnippetMeta = {
  version: number;
  id: string;
  title: string;
  type: string;
  lineCount: number;
  previewLines: number;
};

export type SnippetSection =
  | {
      meta: SnippetMeta;
      content: string;
      type: 'snippet';
    }
  | {
      content: string;
      type: 'text';
    };

export enum SupportedFabFileMimeTypes {
  // Document formats
  PDF = 'application/pdf',
  DOCX = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  PPTX = 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  XLS = 'application/vnd.ms-excel',
  XLSX = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  TXT_PLAIN = 'text/plain',
  TXT_MARKDOWN = 'text/markdown',
  TXT_MD_LEGACY = 'text/x-markdown',
  JSON = 'application/json',
  HTML = 'text/html',
  CSV = 'text/csv',
  XML = 'application/xml',

  // Image formats
  JPG = 'image/jpeg',
  PNG = 'image/png',
  WEBP = 'image/webp',
  GIF = 'image/gif',
  SVG = 'image/svg+xml',

  // Programming languages
  JS = 'application/javascript',
  JSX = 'text/jsx',
  TS = 'text/typescript',
  // eslint-disable-next-line @typescript-eslint/no-duplicate-enum-values
  TSX = 'text/typescript',
  PY = 'text/x-python',
  JAVA = 'text/x-java-source',
  CPP = 'text/x-c++src',
  CS = 'text/x-csharp',
  PHP = 'application/x-httpd-php',
  RUBY = 'application/x-ruby',
  GO = 'text/x-go',
  SWIFT = 'text/x-swift',
  KOTLIN = 'text/x-kotlin',
  RUST = 'text/x-rust',

  // Web technologies
  CSS = 'text/css',
  LESS = 'text/less',
  SASS = 'text/x-sass',
  SCSS = 'text/x-scss',

  // Data serialization
  YAML = 'application/x-yaml',
  TOML = 'application/toml',

  // Shell scripts
  SH = 'application/x-sh',
  BASH = 'application/x-bash',

  // Configuration files
  // eslint-disable-next-line @typescript-eslint/no-duplicate-enum-values
  INI = 'text/plain',
  // eslint-disable-next-line @typescript-eslint/no-duplicate-enum-values
  CONF = 'text/plain',

  // Other common formats
  // We do not support vectorizing compressed files
  // ZIP = 'application/zip',
  // TAR = 'application/x-tar',
  // GZIP = 'application/gzip',
}

/**
 * The canonical set of MIME types the ingest pipeline can actually chunk +
 * vectorize. Kept in lockstep with the `SmartChunker` switch in
 * `@bike4mind/fab-pipeline`.
 */
export const SUPPORTED_FAB_FILE_MIME_TYPES: ReadonlySet<string> = new Set<string>(
  Object.values(SupportedFabFileMimeTypes)
);

/**
 * Type guard: is a claimed MIME type one we actually support ingesting?
 *
 * Used to gate uploads so unsupported/binary files (e.g. `.exe`) are rejected
 * with a clear error instead of being stored and silently "vectorized" into 0
 * chunks. Node-free so it can run on both the client (upload UI) and server
 * (ingest endpoints).
 */
export function isSupportedFabFileMimeType(mimeType: string | null | undefined): mimeType is SupportedFabFileMimeTypes {
  return !!mimeType && SUPPORTED_FAB_FILE_MIME_TYPES.has(mimeType);
}

/**
 * Reasoning effort levels for OpenAI reasoning models (O1, O3, GPT-5 series)
 * Controls the tradeoff between response speed and reasoning depth/quality
 *
 * @see https://platform.openai.com/docs/guides/reasoning
 */
export type ReasoningEffort = 'none' | 'minimal' | 'low' | 'medium' | 'high' | 'xhigh';

/**
 * Valid reasoning effort levels for user selection
 * 'auto' means the system will automatically classify based on query complexity
 */
export type UserReasoningEffort = ReasoningEffort | 'auto';

/**
 * Labels for displaying reasoning effort options to users
 */
export const REASONING_EFFORT_LABELS: Record<UserReasoningEffort, string> = {
  auto: 'Auto (recommended)',
  none: 'None - Fastest',
  minimal: 'Minimal',
  low: 'Low',
  medium: 'Medium',
  high: 'High',
  xhigh: 'Extra High - Best Quality',
};

/**
 * Descriptions for reasoning effort options
 */
export const REASONING_EFFORT_DESCRIPTIONS: Record<UserReasoningEffort, string> = {
  auto: 'Automatically adjusts reasoning effort based on query complexity',
  none: 'No extended reasoning, fastest responses',
  minimal: 'Very light reasoning for simple queries',
  low: 'Light reasoning for straightforward tasks',
  medium: 'Balanced reasoning for most tasks',
  high: 'Deep reasoning for complex problems',
  xhigh: 'Maximum reasoning depth for highest quality (GPT-5.2 Pro/Thinking only)',
};

export const CODE_FILE_MIME_TYPES = [
  SupportedFabFileMimeTypes.TS,
  SupportedFabFileMimeTypes.JS,
  SupportedFabFileMimeTypes.CSS,
  SupportedFabFileMimeTypes.PY,
  SupportedFabFileMimeTypes.JAVA,
  SupportedFabFileMimeTypes.CPP,
  SupportedFabFileMimeTypes.CS,
  SupportedFabFileMimeTypes.PHP,
  SupportedFabFileMimeTypes.RUBY,
  SupportedFabFileMimeTypes.GO,
  SupportedFabFileMimeTypes.SWIFT,
  SupportedFabFileMimeTypes.KOTLIN,
  SupportedFabFileMimeTypes.RUST,
];
