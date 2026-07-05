import type { Logger } from '@bike4mind/observability';
import type { ImageModerationService } from '@bike4mind/utils';
import { ImageModerationBlockedError, UnsupportedImageFormatError } from '@bike4mind/utils';
import type { ImageModerationIncident } from '@bike4mind/common';
import { fileTypeFromBuffer } from 'file-type';

/**
 * Bytes needed for `file-type` to reliably sniff most binary formats from their magic
 * numbers (its own guidance: some formats need up to ~4100 bytes of header).
 */
const SNIFF_BYTES = 4100;

/** Moderation status as stored on FabFile - see `IFabFileDocument.moderationStatus`. */
export type ModerationStatus = 'pending' | 'scanning' | 'clean' | 'blocked' | undefined;

/**
 * True when `status` is a terminal moderation verdict that must never be overwritten by a
 * re-scan. S3's ObjectCreated delivery is at-least-once - a redelivered event
 * re-running the scan could hit Rekognition confidence jitter right around the threshold
 * and flip a previously 'blocked' file to 'clean' (a silent un-quarantine). 'pending'
 * (mid-scan), 'scanning' (atomic-claim interim state - actively being scanned by
 * whichever invocation won the claim), and `undefined` (legacy pre-existing rows) are NOT
 * terminal - 'pending'/undefined must still be scanned; 'scanning' must NOT be re-scanned
 * (that invocation already owns it) but is distinct from a completed verdict.
 */
export function isTerminalModerationStatus(status: ModerationStatus): status is 'clean' | 'blocked' {
  return status === 'clean' || status === 'blocked';
}

export interface ModerateUploadedFileArgs {
  userId: string;
  fabFileId: string;
  mimeType: string | undefined;
  enabled: boolean;
  service: ImageModerationService;
  incidents: { record(input: ImageModerationIncident): Promise<unknown> };
  downloadBytes: () => Promise<Buffer>;
  /**
   * Ranged read of the first `length` bytes of the uploaded object. Used to
   * byte-sniff the REAL file type from magic numbers before deciding image-ness - the
   * client-declared `mimeType` below comes verbatim from the presigned-URL request body and
   * is never validated against bytes, so it cannot be trusted for a security gate. A partial
   * read is enough to sniff, which keeps the non-image fast path cheap (no full download of
   * a large legitimate PDF/video just to prove it isn't an image). Production wires this to
   * `S3Storage.downloadRange`; tests can slice an in-memory buffer.
   */
  downloadPartialBytes: (length: number) => Promise<Buffer>;
  // Injected for testability; production passes the real gate from @bike4mind/services.
  moderateImageOrThrow: (params: {
    service: ImageModerationService;
    enabled: boolean;
    incidents: { record(input: ImageModerationIncident): Promise<unknown> };
    buffer: Buffer;
    mimeType: string;
    incidentMeta: { userId: string; fabFileId: string; provider: string; model: string };
    logger: Logger;
  }) => Promise<void>;
  logger: Logger;
}

export interface ModerateUploadedFileResult {
  moderationStatus: 'clean' | 'blocked';
  /**
   * Set when byte-sniffing determined the real mime type differs from the
   * client-declared `mimeType` passed in. The caller MUST persist this onto
   * `FabFile.mimeType` so downstream consumers (e.g. `isImageServeable`) see the truth
   * instead of whatever the upload request claimed.
   */
  correctedMimeType?: string;
  /**
   * Present only when `moderationStatus === 'blocked'` because the format could not be
   * scanned at all - distinct from a confirmed explicit-content match, for
   * logging/telemetry.
   */
  blockReason?: 'unsupported_format';
}

/**
 * Decide the moderationStatus for a freshly-uploaded file. Non-images and
 * disabled moderation -> 'clean' (never held). Images -> download + scan; a CONFIRMED block ->
 * 'blocked' (the object is left in S3 for §2258A preservation; the caller must not serve it;
 * the incident was already recorded by `moderateImageOrThrow`'s gate).
 *
 * Image-ness is decided from byte-sniffed magic numbers, not the caller-supplied `mimeType`
 * (anti-spoof) - see `downloadPartialBytes` above.
 *
 * Any OTHER error (detector unavailable, transient Rekognition 5xx/throttle, download
 * failure) is rethrown rather than mapped to 'blocked' - turning a transient failure into a
 * permanent false-block would strand a benign image behind scary policy copy with no
 * recovery path. The caller (objectCreated's S3 event handler) lets the throw propagate so
 * S3 retries the whole handler; the file stays `moderationStatus: 'pending'` (held,
 * fail-closed, recoverable) until either a retry succeeds or retries exhaust.
 *
 * The one deliberate exception is an unsupported format (`UnsupportedImageFormatError`):
 * a format neither Rekognition nor jimp can process is a deterministic, not transient,
 * outcome, so it resolves to a terminal 'blocked' instead of an endless retryable throw.
 */
export async function moderateUploadedFile(args: ModerateUploadedFileArgs): Promise<ModerateUploadedFileResult> {
  const {
    userId,
    fabFileId,
    mimeType,
    enabled,
    service,
    incidents,
    downloadBytes,
    downloadPartialBytes,
    moderateImageOrThrow,
    logger,
  } = args;

  if (!enabled) return { moderationStatus: 'clean' };

  // Anti-spoof: sniff the real type from magic numbers rather than trusting
  // the declared mimeType. `file-type` returns undefined for formats with no reliable magic
  // numbers (plain text, csv, json, svg-as-xml, ...) - fall back to the declared mimeType in
  // that case since we have no independent signal to correct it with.
  const sniffSource = await downloadPartialBytes(SNIFF_BYTES);
  const sniffed = await fileTypeFromBuffer(sniffSource);
  const effectiveMimeType = sniffed?.mime ?? mimeType;
  const correctedMimeType = sniffed?.mime && sniffed.mime !== mimeType ? sniffed.mime : undefined;

  if (!effectiveMimeType || !effectiveMimeType.startsWith('image/')) {
    return { moderationStatus: 'clean', correctedMimeType };
  }

  try {
    const buffer = await downloadBytes();
    await moderateImageOrThrow({
      service,
      enabled,
      incidents,
      buffer,
      mimeType: effectiveMimeType,
      incidentMeta: { userId, fabFileId, provider: 'upload', model: 'upload' },
      logger,
    });
    return { moderationStatus: 'clean', correctedMimeType };
  } catch (err) {
    if (err instanceof ImageModerationBlockedError) {
      // Confirmed block - incident already recorded by moderateImageOrThrow. Permanent.
      logger.warn(`[Q2b] uploaded image ${fabFileId} blocked: ${err.message}`);
      return { moderationStatus: 'blocked', correctedMimeType };
    }
    if (err instanceof UnsupportedImageFormatError) {
      // Neither Rekognition nor jimp can process this format (e.g. HEIC, SVG).
      // Fail closed: an image we structurally cannot scan must not be served. This is a
      // deterministic terminal outcome - unlike the transient case below, it does NOT
      // rethrow, because rethrowing here would let S3 redeliver the same undecodable bytes
      // forever, leaving the file stuck 'pending' ("Scanning...") indefinitely. UX tradeoff:
      // the uploader must re-upload as JPEG/PNG to get a real scan and be served.
      logger.warn(`[Q2b] uploaded image ${fabFileId} unsupported_format, blocking (fail-closed): ${err.message}`);
      return { moderationStatus: 'blocked', correctedMimeType, blockReason: 'unsupported_format' };
    }
    // Not a confirmed block or unsupported format (e.g. detector unavailable, throttling,
    // download failure) - rethrow so the S3 event retries instead of permanently
    // false-blocking a benign image.
    logger.warn(`[Q2b] uploaded image ${fabFileId} scan failed transiently, will retry: ${(err as Error).message}`);
    throw err;
  }
}
