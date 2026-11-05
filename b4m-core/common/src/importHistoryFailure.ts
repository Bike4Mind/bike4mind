export type ImportHistoryFailureSource = 'OpenAI' | 'Claude' | 'Notebook';

export interface ImportHistoryFailure {
  reason: string;
  /** false when the uploaded file itself is the problem, so retrying the same file cannot succeed */
  retryable: boolean;
}

/** User-facing product name for an import source; the enum value 'OpenAI' is shown as ChatGPT. */
export const importSourceDisplayName = (source: ImportHistoryFailureSource): string =>
  source === 'OpenAI' ? 'ChatGPT' : source;

const exportName = (source?: ImportHistoryFailureSource) =>
  source === 'OpenAI' || source === 'Claude'
    ? `a ${importSourceDisplayName(source)} export`
    : 'a ChatGPT or Claude export';

// Keyed to the errors importHistoryService (b4m-core/services) and yauzl raise while reading the
// upload. The raw message is never echoed: it can carry temp-file paths and user ids.
const ARCHIVE_ERROR = /central directory|local file header|Unable to open archive|invalid (zip|comment|signature)/i;
// yauzl and zlib errors raised while inflating an entry of a zip that opened fine: truncated,
// encrypted or otherwise unreadable by us, so the same file fails the same way on retry.
const DAMAGED_ERROR =
  /unexpected EOF|unsupported compression method|entry is encrypted|strong encryption is not supported|file data overflows file bounds|multi-disk zip files are not supported|Unable to read conversations\.json from archive|unexpected end of file|incorrect (header|data) check|invalid (stored block lengths|block type|distance|code|literal|bit length)|too many length or distance symbols/i;
const JSON_ERROR = /Unexpected (token|end of JSON|non-whitespace)|is not valid JSON|in JSON at position/i;

const GENERIC_FAILURE: ImportHistoryFailure = {
  reason: 'Something went wrong on our side while processing this import.',
  retryable: true,
};

/** Maps a stored import-job errorMessage to user-facing wording. Shared by the inbox message and the jobs list. */
export const describeImportFailure = (
  errorMessage: string | null | undefined,
  source?: ImportHistoryFailureSource
): ImportHistoryFailure => {
  const message = errorMessage?.trim() ?? '';

  // The rules below describe the chat-history archive. Notebook imports fail for other reasons
  // (their own JSON payload, transactions), so they keep the generic retryable wording.
  if (source === 'Notebook') return { ...GENERIC_FAILURE };

  if (/conversations\.json not found in archive/.test(message)) {
    return {
      reason: `This file doesn't look like ${exportName(source)} (no conversations.json).`,
      retryable: false,
    };
  }
  // JSON first: a SyntaxError quotes a snippet of the user's conversations.json, which could
  // contain any of the archive phrases below.
  if (JSON_ERROR.test(message)) {
    return { reason: 'conversations.json in this file is not valid JSON.', retryable: false };
  }
  if (DAMAGED_ERROR.test(message)) {
    return { reason: 'This file is damaged or is not a usable export.', retryable: false };
  }
  if (ARCHIVE_ERROR.test(message)) {
    return { reason: 'This file is not a valid .zip archive.', retryable: false };
  }
  return { ...GENERIC_FAILURE };
};
