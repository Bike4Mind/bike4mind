export type ImportHistoryFailureKind = 'not_an_export' | 'not_a_zip' | 'damaged_export' | 'unknown';

export interface ImportHistoryFailureReason {
  kind: ImportHistoryFailureKind;
  /** User-safe sentence: what went wrong and what to do next. Never carries the raw error. */
  message: string;
  /** False when the stored upload itself is unusable, so retrying the same file cannot succeed. */
  retryable: boolean;
}

const REASONS: Record<ImportHistoryFailureKind, ImportHistoryFailureReason> = {
  not_an_export: {
    kind: 'not_an_export',
    message: "This file isn't a ChatGPT or Claude export. Upload the zip you downloaded from ChatGPT or Claude.",
    retryable: false,
  },
  not_a_zip: {
    kind: 'not_a_zip',
    message: "This file isn't a zip archive. Upload the export zip as downloaded, without unpacking it.",
    retryable: false,
  },
  damaged_export: {
    kind: 'damaged_export',
    message: 'The export file is damaged. Download a fresh export and upload it again.',
    retryable: false,
  },
  unknown: {
    kind: 'unknown',
    message: 'Something went wrong during the import. Retry it, or contact support if it keeps failing.',
    retryable: true,
  },
};

// Patterns match the raw errorMessage stored on the import job. Sources: extractFileFromZip in
// b4m-core/services/src/importHistoryService (and the yauzl/zlib errors it passes through) and
// the JSON.parse of conversations.json there. Keep in sync when those messages change.
const MATCHERS: Array<[RegExp, ImportHistoryFailureKind]> = [
  [/conversations\.json not found in archive/i, 'not_an_export'],
  [
    /end of central directory record signature not found|unable to open archive|invalid (central directory file header|local file header|comment length)/i,
    'not_a_zip',
  ],
  [
    /JSON at position|is not valid JSON|unexpected end of JSON input|unable to read .* from archive|invalid (stored block|distance|block type|code)|incorrect header check|unexpected end of file|too many length or distance symbols/i,
    'damaged_export',
  ],
];

/** Maps a raw import-job error message to a user-safe reason. Unrecognized errors get a generic fallback. */
export const describeImportHistoryFailure = (errorMessage?: string | null): ImportHistoryFailureReason => {
  if (errorMessage) {
    for (const [pattern, kind] of MATCHERS) {
      if (pattern.test(errorMessage)) return REASONS[kind];
    }
  }
  return REASONS.unknown;
};
