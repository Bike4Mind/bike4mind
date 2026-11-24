import { randomUUID } from 'node:crypto';
import type { PublicImageJob } from '@bike4mind/common';
import type { ChatMedia } from '@shared/chat';
import { MediaToolError, type MediaApiClient } from './MediaApiClient';
import type { MediaStore } from './MediaStore';

/** First gap between polls. Nothing finishes faster than this, so a tighter first poll is waste. */
const FIRST_DELAY_MS = 1_000;

/** Gaps grow by this factor, so a slow model is not polled 180 times. */
const BACKOFF = 1.4;

const MAX_DELAY_MS = 5_000;

/** Consecutive failed reads that end the poll. */
const MAX_POLL_FAILURES = 2;

/** How long a rate-limited read waits when the server sends no Retry-After of its own. */
const RATE_LIMIT_BACKOFF_MS = 30_000;

/**
 * Give up here. Generation normally lands in 10-40s; past three minutes the job is wedged or
 * the worker is down, and waiting longer only holds the turn open. The job id is reported so
 * the user can find the result if it does eventually land.
 */
const DEADLINE_MS = 180_000;

export interface ImageGenerationRequest {
  prompt: string;
  model: string;
  size?: string;
}

export interface ImageGenerationOutcome {
  media: ChatMedia[];
}

interface ReadyImage {
  url: string;
  fileId: string | null;
}

export interface ImageGenerationDeps {
  client: MediaApiClient;
  store: MediaStore;
  /** Local conversation id, which is the media folder these bytes land in. */
  sessionId: string;
  signal: AbortSignal;
  progress(text: string): void;
}

/** Terminal states that carry no image. `succeeded` is the only terminal state that does. */
const FAILED_STATES = new Set<PublicImageJob['state']>(['failed', 'blocked', 'cancelled']);

/**
 * Create an image job and wait it out.
 *
 * The route is asynchronous: the POST returns a job and a worker does the work, so this polls
 * `GET /api/v1/image-jobs/{id}` on a widening interval and reports elapsed time as it goes. The
 * image is saved to the user's Files server-side; this downloads the signed URL for the local copy.
 */
export async function generateImage(
  request: ImageGenerationRequest,
  deps: ImageGenerationDeps
): Promise<ImageGenerationOutcome> {
  const { client, store, sessionId, signal, progress } = deps;

  progress('Queuing the generation...');
  const jobs = await client.createImageJob(
    {
      model: request.model,
      mode: 'generate',
      prompt: request.prompt,
      count: 1,
      ...(request.size ? { size: request.size } : {}),
    },
    randomUUID()
  );
  const created = jobs[0];
  if (!created) throw new MediaToolError('The server accepted the request but returned no job to follow.');

  const { url, fileId } = await pollForOutput(created.id, deps);

  progress('Downloading the image...');
  throwIfAborted(signal);
  const { bytes, contentType } = await client.fetchGenerated(url);
  const stored = await store.save(sessionId, bytes, contentType || contentTypeFromName(url));

  return {
    media: [
      {
        kind: 'image',
        url: stored.url,
        mimeType: stored.mimeType,
        byteLength: stored.byteLength,
        caption: request.prompt,
        ...(fileId ? { fabFileId: fileId } : {}),
      },
    ],
  };
}

/**
 * Poll until the job yields a download URL, fails, or the deadline passes. Stopping mid-poll
 * cancels the job best-effort. A job that is already running refuses the cancel and finishes
 * (and bills) server-side, so the image still lands in Files.
 *
 * A read that fails is retried rather than fatal: the job is running server-side regardless of
 * whether one poll got through, and a blip on second 12 of a 40-second generation should not
 * lose an image the user has already paid for. Consecutive failures do end it, because at that
 * point the more likely explanation is that the session went away. A 429 is not a failure: it is
 * this poll reading too fast, so it waits out the window the server names and is still bounded
 * by the deadline.
 */
async function pollForOutput(jobId: string, deps: ImageGenerationDeps): Promise<ReadyImage> {
  const { client, signal, progress } = deps;
  const startedAt = Date.now();
  let delay = FIRST_DELAY_MS;
  let consecutiveFailures = 0;
  let scanning = false;

  try {
    for (;;) {
      throwIfAborted(signal);
      if (Date.now() - startedAt > DEADLINE_MS) {
        throw new MediaToolError(
          (scanning
            ? `The image finished but was still being scanned after ${Math.round(DEADLINE_MS / 1000)}s. `
            : `The image was still generating after ${Math.round(DEADLINE_MS / 1000)}s and was given up on. `) +
            `It may still land in your Files under job ${jobId}.`
        );
      }

      await sleep(delay, signal);
      delay = Math.min(Math.round(delay * BACKOFF), MAX_DELAY_MS);

      let job: PublicImageJob;
      try {
        job = await client.getImageJob(jobId, signal);
        consecutiveFailures = 0;
      } catch (error) {
        throwIfAborted(signal);
        if (error instanceof MediaToolError && error.status === 429) {
          delay = Math.max(error.retryAfterMs ?? RATE_LIMIT_BACKOFF_MS, delay);
          continue;
        }
        consecutiveFailures += 1;
        if (consecutiveFailures >= MAX_POLL_FAILURES) {
          throw new MediaToolError(
            `Lost contact with the server while the image was generating (${error instanceof Error ? error.message : String(error)}). ` +
              `The job (${jobId}) keeps running there, so the image may still land in Files.`
          );
        }
        continue;
      }

      if (FAILED_STATES.has(job.state)) {
        throw new MediaToolError(job.error?.message || `The image generation ${job.state} on the server.`);
      }

      if (job.state === 'succeeded') {
        const { output } = job;
        if (!output) {
          throw new MediaToolError(
            'The image was generated but was not stored where this app can fetch it. Check Files on the web app.'
          );
        }
        if (output.availability === 'unavailable') {
          throw new MediaToolError('The image was generated but the file is not available to download.');
        }
        if (output.availability === 'ready' && output.url) return { url: output.url, fileId: output.file_id };
        scanning = output.availability === 'pending_scan';
      }

      progress(`Generating... ${Math.round((Date.now() - startedAt) / 1000)}s`);
    }
  } catch (error) {
    if (signal.aborted) await cancelAfterAbort(client, jobId);
    throw error;
  }
}

/**
 * A 409 means the job already started and will finish server-side, which the docblock above expects.
 * Anything else (auth, network, 5xx) leaves a job running that the user stopped, so it is logged.
 */
async function cancelAfterAbort(client: MediaApiClient, jobId: string): Promise<void> {
  try {
    await client.cancelImageJob(jobId);
  } catch (error) {
    if (error instanceof MediaToolError && error.status === 409) return;
    console.warn(`Could not cancel image job ${jobId} after the user stopped it: ${String(error)}`);
  }
}

/** Last-resort Content-Type when the download response carried none. */
function contentTypeFromName(url: string): string {
  const extension = url.split('?')[0].split('.').pop()?.toLowerCase() ?? '';
  if (extension === 'jpg' || extension === 'jpeg') return 'image/jpeg';
  if (extension === 'webp') return 'image/webp';
  if (extension === 'gif') return 'image/gif';
  return 'image/png';
}

function throwIfAborted(signal: AbortSignal): void {
  if (signal.aborted) throw new MediaToolError('The generation was stopped.');
}

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(new MediaToolError('The generation was stopped.'));
    };
    signal.addEventListener('abort', onAbort, { once: true });
  });
}
