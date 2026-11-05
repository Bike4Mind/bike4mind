export type ImportHistoryFailureSource = 'OpenAI' | 'Claude' | 'Notebook';

export interface ImportHistoryFailure {
  reason: string;
  /** false when the uploaded file itself is the problem, so retrying the same file cannot succeed */
  retryable: boolean;
}

const exportName = (source?: ImportHistoryFailureSource) =>
  source === 'OpenAI' ? 'a ChatGPT export' : source === 'Claude' ? 'a Claude export' : 'a ChatGPT or Claude export';

// Keyed to the errors importHistoryService (b4m-core/services) and yauzl raise while reading the
// upload. The raw message is never echoed: it can carry temp-file paths and user ids.
const ARCHIVE_ERROR = /central directory|local file header|Unable to open archive|invalid (zip|comment|signature)/i;
const JSON_ERROR = /Unexpected (token|end of JSON|non-whitespace)|is not valid JSON|in JSON at position/i;

/** Maps a stored import-job errorMessage to user-facing wording. Shared by the inbox message and the jobs list. */
export const describeImportFailure = (
  errorMessage: string | null | undefined,
  source?: ImportHistoryFailureSource
): ImportHistoryFailure => {
  const message = errorMessage?.trim() ?? '';

  if (/conversations\.json not found in archive/.test(message)) {
    return {
      reason: `This file doesn't look like ${exportName(source)} (no conversations.json).`,
      retryable: false,
    };
  }
  if (/Unable to read conversations\.json from archive/.test(message)) {
    return { reason: 'This archive is damaged and conversations.json could not be read.', retryable: false };
  }
  if (ARCHIVE_ERROR.test(message)) {
    return { reason: 'This file is not a valid .zip archive.', retryable: false };
  }
  if (JSON_ERROR.test(message)) {
    return { reason: 'conversations.json in this file is not valid JSON.', retryable: false };
  }
  return { reason: 'Something went wrong on our side while processing this import.', retryable: true };
};
