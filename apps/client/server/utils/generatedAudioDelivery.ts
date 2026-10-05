import { randomUUID } from 'crypto';
import type { Response } from 'express';
import type { Logger } from '@bike4mind/observability';
import { extensionFromMimeType, type GeneratedAudioEncoding } from '@bike4mind/common';
import { getFilesStorage } from '@server/utils/storage';
import type { PersistGeneratedAudioResult } from '@server/utils/persistGeneratedAudio';
import { GENERATED_AUDIO_OFFLOAD_PREFIX } from '@server/utils/generatedAudioOffloadPrefix';

/**
 * Server half of the generated-audio wire model (common generatedAudio.ts, contract
 * contracts/audioResponses.ts): every route that returns generated audio hands its
 * bytes here, so the size ceiling, the save headers and the response shapes live
 * in one place.
 */

// API Gateway/Lambda cap a function's response payload at ~6MB, and the audio
// leaves as base64 (~+33%) either way: the proxy integration base64-wraps a raw
// binary body, and the JSON encoding carries the audio base64 itself. So the raw
// buffer must stay under ~4.5MB; we use 4MB for margin. Past this the request
// fails with an opaque CloudFront 502/504.
export const GENERATED_AUDIO_MAX_RESPONSE_BYTES = 4 * 1024 * 1024;

export const GENERATED_AUDIO_TOO_LARGE_MESSAGE =
  'Generated audio is too large to return (~4MB limit) and could not be staged for download. Retry, or request shorter output.';

export { GENERATED_AUDIO_OFFLOAD_PREFIX };

/** Lifetime of an offloaded object's signed URL, in seconds. Well inside the 1-day lifecycle expiry. */
export const GENERATED_AUDIO_OFFLOAD_URL_TTL_SECONDS = 60 * 60;

export function exceedsGeneratedAudioResponseLimit(audioBytes: number): boolean {
  return audioBytes > GENERATED_AUDIO_MAX_RESPONSE_BYTES;
}

/**
 * Uploads audio too large to return inline and returns a signed GET URL for it.
 * Independent of the browsable FabFile copy, which a caller can opt out of, so
 * billed audio is always retrievable. Throws on a storage failure.
 */
export async function offloadGeneratedAudio(audio: Buffer, contentType: string): Promise<string> {
  const key = `${GENERATED_AUDIO_OFFLOAD_PREFIX}${randomUUID()}.${extensionFromMimeType(contentType) ?? 'bin'}`;
  const storage = getFilesStorage();
  await storage.upload(audio, key, { ContentType: contentType });
  return storage.getSignedUrl(key, 'get', { expiresIn: GENERATED_AUDIO_OFFLOAD_URL_TTL_SECONDS });
}

/** The save outcome as JSON body fields (common generatedAudio.ts `generatedAudioSaveFields`). */
function saveFields(save: PersistGeneratedAudioResult | undefined) {
  if (!save) return {};
  return save.saved
    ? { saved: true, fabFileId: save.fabFileId, fileName: save.fileName, fileUrl: save.fileUrl }
    : { saved: false, saveSkippedReason: save.reason };
}

/** The save outcome as headers (contract GENERATED_AUDIO_SAVE_HEADERS), the binary encoding's only channel for it. */
function setSaveHeaders(res: Response, save: PersistGeneratedAudioResult | undefined): void {
  if (!save) return;
  res.setHeader('X-B4M-Audio-Saved', String(save.saved));
  if (!save.saved) return;
  res.setHeader('X-B4M-Audio-Fab-File-Id', save.fabFileId);
  res.setHeader('X-B4M-Audio-File-Name', save.fileName);
  if (save.fileUrl) res.setHeader('X-B4M-Audio-File-Url', save.fileUrl);
}

/**
 * Where a caller can fetch audio too large to inline: the saved copy's URL when
 * there is one, else a freshly offloaded object. Undefined only when the offload
 * itself failed.
 */
async function oversizedAudioUrl(
  audio: Buffer,
  contentType: string,
  save: PersistGeneratedAudioResult | undefined,
  logger: Logger
): Promise<string | undefined> {
  if (save?.saved && save.fileUrl) return save.fileUrl;
  try {
    return await offloadGeneratedAudio(audio, contentType);
  } catch (error) {
    logger.error('Failed to offload oversized generated audio', { error, bytes: audio.length });
    return undefined;
  }
}

/**
 * Writes the response for generated audio in the caller's `encoding`: inline bytes
 * or base64 JSON under the ceiling; above it a 303 (binary) or the `delivery: 'url'`
 * JSON variant (base64); a 413 only when the offload fails. `fields` are the
 * endpoint's own JSON fields (common extendGeneratedAudioResponseSchema) and
 * `tooLargeFields` its own 413 fields. Call it after billing and persisting - the
 * caller is owed this audio whatever happens here.
 */
export async function deliverGeneratedAudio(
  res: Response,
  params: {
    audio: Buffer;
    contentType: string;
    encoding: GeneratedAudioEncoding;
    save: PersistGeneratedAudioResult | undefined;
    fields?: Record<string, unknown>;
    tooLargeFields?: Record<string, unknown>;
    logger: Logger;
  }
): Promise<void> {
  const { audio, contentType, encoding, save, fields, tooLargeFields, logger } = params;
  setSaveHeaders(res, save);
  const jsonCommon = { contentType, ...saveFields(save), ...fields };

  if (exceedsGeneratedAudioResponseLimit(audio.length)) {
    // The URL is short-lived and the 413 is transient, so no oversized outcome may be cached.
    res.setHeader('Cache-Control', 'no-store');
    const url = await oversizedAudioUrl(audio, contentType, save, logger);
    if (!url) {
      res.status(413).json({ error: GENERATED_AUDIO_TOO_LARGE_MESSAGE, ...tooLargeFields });
      return;
    }
    if (encoding === 'base64') {
      res.json({ delivery: 'url', url, bytes: audio.length, ...jsonCommon });
      return;
    }
    res.redirect(303, url);
    return;
  }

  if (encoding === 'base64') {
    res.json({ delivery: 'inline', audio: audio.toString('base64'), ...jsonCommon });
    return;
  }
  res.setHeader('Content-Type', contentType);
  res.setHeader('Content-Length', audio.length);
  res.send(audio);
}
