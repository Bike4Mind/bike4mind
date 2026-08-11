import { SupportedFabFileMimeTypes } from '@bike4mind/common';
import type { SlackEventData } from './SlackEvent';

export type SlackAttachment = NonNullable<SlackEventData['files']>[number];

/** A Slack attachment carrying every field an ingest path needs to download and store it. */
export type CompleteSlackAttachment = SlackAttachment & {
  name: string;
  mimetype: string;
  url_private_download: string;
  size: number;
};

export const SLACK_MAX_FILE_SIZE_BYTES = 50 * 1024 * 1024;
export const SLACK_MAX_IMAGE_SIZE_BYTES = 10 * 1024 * 1024;

/**
 * What Slack intake accepts. Deliberately NARROWER than the web wizard's full
 * `SupportedFabFileMimeTypes` (no CSV, no PPTX): Slack attachments arrive from arbitrary channel
 * members with no confirmation step, so the surface stays restricted until a type is asked for.
 *
 * Shared by the plain-attachment path (`CommandHandler.processSlackFiles`) and the data-lake
 * ingest so the two cannot drift - a type one accepts and the other rejects would make the same
 * attachment succeed or fail purely on which command carried it.
 */
export const SUPPORTED_SLACK_FILE_MIME_TYPES: readonly string[] = [
  SupportedFabFileMimeTypes.PDF,
  SupportedFabFileMimeTypes.DOCX,
  SupportedFabFileMimeTypes.XLS,
  SupportedFabFileMimeTypes.XLSX,
  SupportedFabFileMimeTypes.TXT_PLAIN,
  SupportedFabFileMimeTypes.TXT_MARKDOWN,
  SupportedFabFileMimeTypes.TXT_MD_LEGACY,

  SupportedFabFileMimeTypes.PNG,
  SupportedFabFileMimeTypes.JPG,
  SupportedFabFileMimeTypes.WEBP,
  SupportedFabFileMimeTypes.GIF,
];

/**
 * `incomplete` is a Slack infrastructure artifact (pending/deleted file objects arrive with
 * required fields missing), not a user-chosen file - which is why the plain attachment path
 * drops it without telling anyone. The data-lake path still surfaces it, because there silence
 * would read as "my file was added".
 */
export type SlackFileRejectionReason = 'incomplete' | 'unsupported_type' | 'too_large';

export type SlackFileValidation =
  { ok: true; file: CompleteSlackAttachment } | { ok: false; reason: SlackFileRejectionReason; message: string };

/**
 * Validate one Slack attachment for ingest. On success the returned `file` is narrowed so callers
 * get the required fields without re-guarding. `message` is a bare sentence with no emoji or
 * trailing disposition ("Skipping.") so each caller frames it in its own voice.
 */
export function validateSlackFileForIngest(file: SlackAttachment): SlackFileValidation {
  if (!file.mimetype || !file.name || !file.url_private_download || file.size === undefined) {
    return {
      ok: false,
      reason: 'incomplete',
      message: `File "${file.name ?? file.id}" is missing data Slack did not send.`,
    };
  }

  if (!SUPPORTED_SLACK_FILE_MIME_TYPES.includes(file.mimetype)) {
    return {
      ok: false,
      reason: 'unsupported_type',
      message: `File "${file.name}" has unsupported type ${file.mimetype}.`,
    };
  }

  const maxSize = file.mimetype.startsWith('image/') ? SLACK_MAX_IMAGE_SIZE_BYTES : SLACK_MAX_FILE_SIZE_BYTES;
  if (file.size > maxSize) {
    const sizeMB = (file.size / (1024 * 1024)).toFixed(1);
    const maxMB = (maxSize / (1024 * 1024)).toFixed(0);
    return {
      ok: false,
      reason: 'too_large',
      // Wording is load-bearing: processSlackFiles has surfaced this exact sentence to Slack
      // users since before the validator was extracted. Keep it byte-identical.
      message: `File "${file.name}" (${sizeMB}MB) exceeds ${maxMB}MB limit.`,
    };
  }

  return { ok: true, file: file as CompleteSlackAttachment };
}
