import { SupportedFabFileMimeTypes } from '@bike4mind/common';
import { getFileExtension, getMimeTypeByExtension } from '@bike4mind/utils';
import type { SlackEventData } from './SlackEvent';

export type SlackAttachment = NonNullable<SlackEventData['files']>[number];

/**
 * A Slack attachment carrying every field an ingest path needs to download and store it.
 * `mimetype` stays whatever Slack sent (possibly absent) - it is never validated or read past
 * this point; type resolution is fully extension-based (see `resolvedMimeType`).
 */
export type CompleteSlackAttachment = SlackAttachment & {
  name: string;
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
  | { ok: true; file: CompleteSlackAttachment; resolvedMimeType: string }
  | { ok: false; reason: SlackFileRejectionReason; message: string };

/**
 * Validate one Slack attachment for ingest. On success the returned `file` is narrowed so callers
 * get the required fields without re-guarding. `message` is a bare sentence with no emoji or
 * trailing disposition ("Skipping.") so each caller frames it in its own voice.
 */
export function validateSlackFileForIngest(file: SlackAttachment): SlackFileValidation {
  // `file.mimetype` is not checked here - nothing below reads it, type resolution is fully
  // extension-based (see resolvedMimeType). Requiring it would silently drop a well-formed
  // attachment whose client-reported mimetype happens to be empty.
  if (!file.name || !file.url_private_download || file.size === undefined) {
    return {
      ok: false,
      reason: 'incomplete',
      message: `File "${file.name ?? file.id}" is missing data Slack did not send.`,
    };
  }

  // Gate on the extension's OWN mimetype, not `file.mimetype` - that field is whatever the
  // Slack client reported, and Slack labels most plain-text files `text/plain` regardless of
  // extension, so a `.sh`/`.srt`/`.yaml` file claiming `text/plain` used to sail through. The
  // resolved value also decides the size cap below, so a claimed `image/png` on a non-image
  // file no longer gets the looser cap either.
  const ext = getFileExtension(file.name);
  // `path.extname` grabs a tail off ANY dot in the name, even one that isn't extension-shaped -
  // a date ("2026.09.07") or a version ("v1.2") resolves to "07" or "2", which looks like it has
  // an extension when the name actually has none. Checking the shape FIRST (rather than just
  // "did path.extname find a dot") is what keeps those genuinely extension-less names on the
  // same plain-text fallback as LICENSE/Dockerfile, instead of being judged against an extension
  // that was never really there.
  // Not a length/character-class check - a real extension can be longer than 8 chars
  // (`properties`) or contain digits anywhere but the front (`7z` doesn't apply here since
  // it's not on the allow-list, but a longer one like `properties` is a real, if unsupported,
  // extension and must still be REFUSED, not silently coerced to plain text). Excluding only
  // a digit-led tail is what keeps a date/version fragment ("07", "2") extension-less without
  // also exempting a merely-long unsupported extension.
  const looksLikeExtension = ext !== '' && !/^[0-9]/.test(ext);
  // A trailing dot ("payload.") also fails `looksLikeExtension`, but it's malformed rather than
  // extension-less, so it stays refused below instead of being coerced to plain text.
  const hasNoExtension = !looksLikeExtension && !file.name.endsWith('.');
  const resolvedMimeType = hasNoExtension ? SupportedFabFileMimeTypes.TXT_PLAIN : getMimeTypeByExtension(ext);
  if (!resolvedMimeType || !SUPPORTED_SLACK_FILE_MIME_TYPES.includes(resolvedMimeType)) {
    // Name what actually decided the rejection - the resolved (extension-based) type, or the
    // raw extension if it looks like one - never `file.mimetype` (only the client's claim, which
    // can name a type that IS on the allow-list) and never a bare digit fragment `path.extname`
    // can grab out of a date or version suffix, which reads as gibberish rather than a type.
    const reportedType = resolvedMimeType || (looksLikeExtension ? ext : '');
    return {
      ok: false,
      reason: 'unsupported_type',
      message: reportedType
        ? `File "${file.name}" has unsupported type ${reportedType}.`
        : `File "${file.name}" has no recognized file type.`,
    };
  }

  const maxSize = resolvedMimeType.startsWith('image/') ? SLACK_MAX_IMAGE_SIZE_BYTES : SLACK_MAX_FILE_SIZE_BYTES;
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

  return { ok: true, file: file as CompleteSlackAttachment, resolvedMimeType };
}
