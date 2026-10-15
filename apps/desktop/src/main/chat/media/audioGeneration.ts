import { randomUUID } from 'node:crypto';
import type { MusicGeneration, SoundEffectsRequest, TTSRequest } from '@bike4mind/common';
import type { ChatMedia, ChatToolNotice } from '@shared/chat';
import { MediaToolError, type GeneratedAudio, type MediaApiClient } from './MediaApiClient';
import type { MediaStore } from './MediaStore';

/**
 * The Audio tag of the b4m API: synthesizeSpeech and generateSoundEffect, plus generateMusic,
 * which runs on the async music-job resource instead.
 *
 * All three are credit-metered, all three can save a browsable copy to the file browser, and
 * all three land here as bytes on disk plus a ChatMedia the renderer can play. They differ in
 * how the bytes arrive: JSON base64 (or a signed URL) for speech, a raw body for sound effects,
 * and for music a job that is polled until a signed URL appears. That is the client's problem
 * for the first two, and generateMusic's for the third.
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

/** Consecutive failed job reads that end the wait; one blip must not lose a song already paid for. */
export const MUSIC_MAX_POLL_FAILURES = 3;

/** How long a rate-limited read waits before the next one. */
export const MUSIC_RATE_LIMIT_BACKOFF_MS = 15_000;

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
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
  now?: () => number;
  /** Per tool call, so a retried submit of the same call returns its job instead of a second bill. */
  idempotencyKey?: string;
}

const STOPPED_MESSAGE = 'The generation was stopped.';

/** Resolves after `ms`, or rejects as soon as the signal aborts so Stop lands immediately. */
function abortableSleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new MediaToolError(STOPPED_MESSAGE));
      return;
    }
    const onAbort = () => {
      clearTimeout(timer);
      reject(new MediaToolError(STOPPED_MESSAGE));
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

const isScanning = (job: MusicGeneration): boolean =>
  job.state === 'succeeded' && job.output?.availability === 'pending_scan';

/**
 * Create a music job and wait for the song, within a bounded poll.
 *
 * Hitting the deadline does not cancel: the job is billed and saved server-side either way, so
 * the error says where to find the song instead of throwing it away. Stop does cancel, since the
 * user asked for the work to end.
 */
export async function generateMusic(
  request: MusicJobRequest,
  deps: AudioDeps,
  options: MusicPollOptions = {}
): Promise<AudioOutcome> {
  const { signal, sleep = abortableSleep, now = Date.now, idempotencyKey = randomUUID() } = options;
  const deadline = now() + MUSIC_DEADLINE_MS;

  if (signal?.aborted) throw new MediaToolError(STOPPED_MESSAGE);
  const created = await deps.client.createMusicGeneration(
    {
      model: request.model,
      prompt: request.prompt,
      ...(request.instrumental !== undefined ? { instrumental: request.instrumental } : {}),
      ...(request.durationSeconds !== undefined ? { duration_seconds: request.durationSeconds } : {}),
    },
    idempotencyKey,
    signal
  );

  let job: MusicGeneration;
  try {
    job = await pollUntilSettled(created, deps, { signal, sleep, now, deadline });
  } catch (error) {
    if (!signal?.aborted) throw error;
    await cancelQuietly(created.id, deps);
    throw new MediaToolError(STOPPED_MESSAGE);
  }

  const { output } = job;
  if (!output) {
    throw new MediaToolError(
      'The song was generated but was not stored where this app can fetch it. Check Files on the web app.'
    );
  }
  if (output.availability !== 'ready' || !output.url) {
    throw new MediaToolError('The song was generated but its file was blocked or removed, so it cannot be played.');
  }
  const { bytes } = await deps.client.fetchGenerated(output.url, 'Downloading the generated song');
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

interface PollContext {
  signal: AbortSignal | undefined;
  sleep: (ms: number, signal?: AbortSignal) => Promise<void>;
  now: () => number;
  deadline: number;
}

/** Re-read the job until it succeeds with a settled output, ends badly, or the deadline passes. */
async function pollUntilSettled(
  created: MusicGeneration,
  deps: AudioDeps,
  { signal, sleep, now, deadline }: PollContext
): Promise<MusicGeneration> {
  let job = created;
  let consecutiveFailures = 0;
  let waitMs = MUSIC_POLL_INTERVAL_MS;

  for (;;) {
    if (job.state === 'succeeded' && !isScanning(job)) return job;
    if (job.state === 'failed' || job.state === 'blocked' || job.state === 'cancelled') {
      throw new MediaToolError(job.error?.message ?? `The music job ended as ${job.state}.`);
    }
    if (signal?.aborted) throw new MediaToolError(STOPPED_MESSAGE);
    if (now() + waitMs > deadline) {
      throw new MediaToolError(
        isScanning(job)
          ? 'The song finished and is being scanned. It will appear in Files when the scan completes.'
          : 'The song is still rendering. It is saved server-side and will appear in Files when it is done.'
      );
    }
    await sleep(waitMs, signal);
    if (signal?.aborted) throw new MediaToolError(STOPPED_MESSAGE);
    try {
      job = await deps.client.getMusicGeneration(job.id, signal);
      consecutiveFailures = 0;
      waitMs = MUSIC_POLL_INTERVAL_MS;
    } catch (error) {
      if (signal?.aborted) throw new MediaToolError(STOPPED_MESSAGE);
      consecutiveFailures += 1;
      if (consecutiveFailures >= MUSIC_MAX_POLL_FAILURES) {
        throw new MediaToolError(
          `Lost contact with the server while the song was rendering (${error instanceof Error ? error.message : String(error)}). ` +
            `The job (${created.id}) keeps running there, so the song may still land in Files.`
        );
      }
      waitMs = (error as { status?: number }).status === 429 ? MUSIC_RATE_LIMIT_BACKOFF_MS : MUSIC_POLL_INTERVAL_MS;
    }
  }
}

async function cancelQuietly(jobId: string, deps: AudioDeps): Promise<void> {
  try {
    await deps.client.cancelMusicGeneration(jobId);
  } catch {
    // Best effort: the user already stopped, and the stop message is the answer either way. A job
    // that could not be cancelled finishes server-side and lands in Files.
  }
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
