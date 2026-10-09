import { randomUUID } from 'node:crypto';
import type { CreateVideoGenerationBody, VideoGeneration } from '@bike4mind/common';
import type { ChatMedia } from '@shared/chat';
import { MediaToolError, type MediaApiClient } from './MediaApiClient';
import type { MediaStore } from './MediaStore';

const FIRST_DELAY_MS = 2_000;
const BACKOFF = 1.4;
const MAX_DELAY_MS = 10_000;
const DEADLINE_MS = 20 * 60_000;
const TERMINAL_STATES = new Set(['succeeded', 'failed', 'blocked', 'cancelled']);

export interface VideoGenerationDeps {
  client: MediaApiClient;
  store: MediaStore;
  sessionId: string;
  signal: AbortSignal;
  progress(text: string): void;
}

export async function generateVideo(
  request: CreateVideoGenerationBody,
  deps: VideoGenerationDeps
): Promise<{ job: VideoGeneration; media: ChatMedia }> {
  deps.progress('Queuing the video generation...');
  const queued = await deps.client.generateVideo(request, randomUUID());
  const job = await pollVideo(queued, deps);
  const output = job.output?.availability === 'ready' && job.output.url ? job.output : null;
  const outputUrl = output?.url;
  if (!output || !outputUrl) {
    throw new MediaToolError(
      job.output?.availability === 'unavailable'
        ? 'The video was generated but is not available to download.'
        : 'The video finished without a downloadable result.'
    );
  }

  deps.progress('Downloading the video...');
  throwIfAborted(deps.signal);
  const fetched = await deps.client.fetchGenerated(outputUrl);
  const stored = await deps.store.save(deps.sessionId, fetched.bytes, fetched.contentType || output.content_type);
  return {
    job,
    media: {
      kind: 'video',
      url: stored.url,
      mimeType: stored.mimeType,
      byteLength: stored.byteLength,
      caption: request.prompt,
      ...(output.file_id ? { fabFileId: output.file_id } : {}),
    },
  };
}

async function pollVideo(initial: VideoGeneration, deps: VideoGenerationDeps): Promise<VideoGeneration> {
  const startedAt = Date.now();
  let delay = FIRST_DELAY_MS;
  let job = initial;
  let consecutiveFailures = 0;

  for (;;) {
    if (TERMINAL_STATES.has(job.state)) {
      if (job.state !== 'succeeded') {
        throw new MediaToolError(job.error?.message || `Video generation ended as ${job.state}.`);
      }
      if (job.output?.availability !== 'pending_scan') return job;
    }
    if (Date.now() - startedAt > DEADLINE_MS) {
      throw new MediaToolError(
        `The video was still generating after ${Math.round(DEADLINE_MS / 60_000)} minutes. ` +
          `It may still finish in the web app under job ${job.id}.`
      );
    }

    await sleep(delay, deps.signal);
    delay = Math.min(Math.round(delay * BACKOFF), MAX_DELAY_MS);
    try {
      job = await deps.client.getVideoGeneration(job.id);
      consecutiveFailures = 0;
    } catch (error) {
      consecutiveFailures += 1;
      if (consecutiveFailures >= 2) throw error;
      continue;
    }
    const elapsed = Math.round((Date.now() - startedAt) / 1000);
    const percent = job.progress === null ? '' : `, ${Math.round(job.progress * 100)}%`;
    deps.progress(`Generating video... ${elapsed}s${percent}`);
  }
}

function throwIfAborted(signal: AbortSignal): void {
  if (signal.aborted) throw new MediaToolError('The video generation was stopped.');
}

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(new MediaToolError('The video generation was stopped.'));
    };
    signal.addEventListener('abort', onAbort, { once: true });
  });
}
