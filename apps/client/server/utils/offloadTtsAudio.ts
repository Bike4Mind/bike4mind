import { randomUUID } from 'crypto';
import { getFilesStorage } from '@server/utils/storage';

/**
 * Key prefix for transient TTS audio. Must stay in sync with the lifecycle rules
 * in infra/buckets.ts (`expire-tts-offload`) and compose.selfhost.yaml, the only
 * things that delete these objects. Skipped by
 * the object-created handlers via untrackedFabFileKey.ts (no FabFile row).
 */
export const TTS_OFFLOAD_PREFIX = 'tts-offload/';

/** Lifetime of the signed URL, in seconds. Well inside the 1-day lifecycle expiry. */
export const TTS_OFFLOAD_URL_TTL_SECONDS = 60 * 60;

/**
 * Uploads audio too large to return inline (see ttsResponseLimit.ts) and returns
 * a signed GET URL for it. Independent of the browsable FabFile copy, which a
 * caller can opt out of, so billed audio is always retrievable. Throws on a
 * storage failure.
 */
export async function offloadTtsAudio(params: { audio: Buffer; contentType: string; format: string }): Promise<string> {
  const { audio, contentType, format } = params;
  const key = `${TTS_OFFLOAD_PREFIX}${randomUUID()}.${format}`;
  const storage = getFilesStorage();
  await storage.upload(audio, key, { ContentType: contentType });
  return storage.getSignedUrl(key, 'get', { expiresIn: TTS_OFFLOAD_URL_TTL_SECONDS });
}
