import { randomUUID } from 'node:crypto';
import type { SoundEffectsRequest, TTSRequest } from '@bike4mind/common';
import type { ChatMedia, ChatToolNotice } from '@shared/chat';
import { MediaToolError, type GeneratedAudio, type MediaApiClient } from './MediaApiClient';
import type { MediaStore } from './MediaStore';

/**
 * The Audio tag of the b4m API: synthesizeSpeech and generateSoundEffect, plus generateMusic,
 * which runs on the async music-job resource instead.
 *
 * All three are credit-metered, all three can save a browsable copy to the file browser, and
 * all three land here as bytes on disk plus a ChatMedia the renderer can play. They differ only
 * in how the bytes arrive (JSON base64 for speech, a raw body for the other two), which is the
 * client's problem rather than this module's.
 */

export interface AudioOutcome {
  media: ChatMedia;
  /** Set when a provider other than the requested one produced the audio. */
  notice?: ChatToolNotice;
  /** The browsable copy the server kept, when it kept one. */
  fabFileId?: string;
}

export interface AudioDeps {
  client: MediaApiClient;
  store: MediaStore;
  /** Local conversation id, which is the media folder these bytes land in. */
  sessionId: string;
}

/**
 * Synthesize speech from text.
 *
 * The provider substitution is lifted out of the response into a notice: the endpoint quietly
 * stands another vendor in when the requested one has no usable key, which means a different
 * voice than the one asked for. Leaving that in the tool's result text would leave the user
 * wondering why what they hear does not match what they chose.
 */
export async function synthesizeSpeech(request: Omit<TTSRequest, 'encoding'>, deps: AudioDeps): Promise<AudioOutcome> {
  const response = await deps.client.synthesizeSpeech(request);
  // Audio over the server's response ceiling comes back as a signed storage URL instead of inline.
  const audio =
    response.delivery === 'url'
      ? (await deps.client.fetchGenerated(response.url)).bytes
      : Buffer.from(response.audio, 'base64');
  const stored = await deps.store.save(deps.sessionId, audio, response.contentType);

  const substituted = !!response.fallbackFrom && !!response.provider && response.fallbackFrom !== response.provider;

  return {
    media: {
      kind: 'audio',
      url: stored.url,
      mimeType: stored.mimeType,
      byteLength: stored.byteLength,
      caption: request.text,
      ...(response.fabFileId ? { fabFileId: response.fabFileId } : {}),
    },
    ...(substituted
      ? {
          notice: {
            kind: 'provider-substituted' as const,
            text:
              `${response.fallbackFrom} has no usable key on this server, so ${response.provider} generated ` +
              'this instead. The voice will not be the one that was asked for.',
          },
        }
      : {}),
    ...(response.fabFileId ? { fabFileId: response.fabFileId } : {}),
  };
}

export async function generateSoundEffect(request: SoundEffectsRequest, deps: AudioDeps): Promise<AudioOutcome> {
  return storeAudio(await deps.client.generateSoundEffect(request), request.text, deps);
}

/** How often a running music job is re-read. */
export const MUSIC_POLL_INTERVAL_MS = 3000;

/** Longest a tool call waits on one song; a slower job keeps rendering and still lands in Files. */
export const MUSIC_DEADLINE_MS = 10 * 60 * 1000;

export interface MusicJobRequest {
  /** A model id from the server's music-model list. */
  model: string;
  prompt: string;
  instrumental?: boolean;
  /** Whole seconds; the model's default when omitted. */
  durationSeconds?: number;
}

/** Timing and cancellation seams, so tests never wait in real time. */
export interface MusicPollOptions {
  signal?: AbortSignal;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
}

const realSleep = (ms: number): Promise<void> => new Promise(resolve => setTimeout(resolve, ms));

/**
 * Create a music job and wait for the song, within a bounded poll.
 *
 * Hitting the deadline does not cancel: the job is billed and saved server-side either way, so
 * the error says where to find the song instead of throwing it away.
 */
export async function generateMusic(
  request: MusicJobRequest,
  deps: AudioDeps,
  options: MusicPollOptions = {}
): Promise<AudioOutcome> {
  const { signal, sleep = realSleep, now = Date.now } = options;
  const deadline = now() + MUSIC_DEADLINE_MS;
  const stopped = () => new MediaToolError('The generation was stopped.');

  if (signal?.aborted) throw stopped();
  let job = await deps.client.createMusicGeneration(
    {
      model: request.model,
      prompt: request.prompt,
      ...(request.instrumental !== undefined ? { instrumental: request.instrumental } : {}),
      ...(request.durationSeconds !== undefined ? { duration_seconds: request.durationSeconds } : {}),
    },
    randomUUID()
  );

  for (;;) {
    if (job.state === 'succeeded' && job.output?.availability !== 'pending_scan') break;
    if (job.state === 'failed' || job.state === 'blocked' || job.state === 'cancelled') {
      throw new MediaToolError(job.error?.message ?? `The music job ended as ${job.state}.`);
    }
    if (signal?.aborted) throw stopped();
    if (now() + MUSIC_POLL_INTERVAL_MS > deadline) {
      throw new MediaToolError(
        'The song is still rendering. It is saved server-side and will appear in Files when it is done.'
      );
    }
    await sleep(MUSIC_POLL_INTERVAL_MS);
    if (signal?.aborted) throw stopped();
    job = await deps.client.getMusicGeneration(job.id, signal);
  }

  const { output } = job;
  if (!output || output.availability !== 'ready' || !output.url) {
    throw new MediaToolError('The song was generated but its file is unavailable (blocked or deleted).');
  }
  const { bytes } = await deps.client.fetchGenerated(output.url);
  const stored = await deps.store.save(deps.sessionId, bytes, output.content_type);
  return {
    media: {
      kind: 'audio',
      url: stored.url,
      mimeType: stored.mimeType,
      byteLength: stored.byteLength,
      caption: request.prompt,
      ...(output.file_id ? { fabFileId: output.file_id } : {}),
    },
    ...(output.file_id ? { fabFileId: output.file_id } : {}),
  };
}

async function storeAudio(generated: GeneratedAudio, caption: string, deps: AudioDeps): Promise<AudioOutcome> {
  const stored = await deps.store.save(deps.sessionId, generated.audio, generated.contentType);
  return {
    media: {
      kind: 'audio',
      url: stored.url,
      mimeType: stored.mimeType,
      byteLength: stored.byteLength,
      caption,
      ...(generated.fabFileId ? { fabFileId: generated.fabFileId } : {}),
    },
    ...(generated.fabFileId ? { fabFileId: generated.fabFileId } : {}),
  };
}
