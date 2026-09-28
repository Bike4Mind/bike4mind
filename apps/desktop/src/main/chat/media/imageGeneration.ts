import { GENERATED_IMAGE_EXTENSION_RE } from '@bike4mind/common';
import type { ChatMedia } from '@shared/chat';
import { isTerminalQuest, MediaToolError, type MediaApiClient, type QuestPoll } from './MediaApiClient';
import type { MediaStore } from './MediaStore';

/** First gap between polls. Nothing finishes faster than this, so a tighter first poll is waste. */
const FIRST_DELAY_MS = 1_000;

/** Gaps grow by this factor, so a slow model is not polled 180 times. */
const BACKOFF = 1.4;

const MAX_DELAY_MS = 5_000;

/**
 * Give up here. Generation normally lands in 10-40s; past three minutes the job is wedged or
 * the worker is down, and waiting longer only holds the turn open. The quest id is reported so
 * the user can find the result in the web app if it does eventually land.
 */
const DEADLINE_MS = 180_000;

export interface ImageGenerationRequest {
  prompt: string;
  model: string;
  size?: string;
  /** Notebook to file this under; absent on the first generation of a conversation. */
  remoteSessionId?: string;
  /** Names the notebook the server creates when `remoteSessionId` is absent. */
  notebookName: string;
}

export interface ImageGenerationOutcome {
  media: ChatMedia[];
  /** The notebook the server used. Worth persisting so the next generation reuses it. */
  remoteSessionId?: string;
  /** Generated-file names the deployment exposed no URL for; see `resolveImageUrls`. */
  unreachable: string[];
}

export interface ImageGenerationDeps {
  client: MediaApiClient;
  store: MediaStore;
  /** Local conversation id, which is the media folder these bytes land in. */
  sessionId: string;
  /** Base for generated-file URLs, from serverConfig. Relative on self-host, absolute on a CDN. */
  cdnUrl: string;
  signal: AbortSignal;
  progress(text: string): void;
}

/**
 * Queue an image generation and wait it out.
 *
 * The route is asynchronous: the POST returns a quest and a worker does the work, so this polls
 * `GET /api/quests/{id}` on a widening interval and reports elapsed time as it goes. A quest
 * that fails comes back as `type: 'error'` with HTTP 200, which is why the status alone is not
 * enough to tell success from failure.
 */
export async function generateImage(
  request: ImageGenerationRequest,
  deps: ImageGenerationDeps
): Promise<ImageGenerationOutcome> {
  const { client, store, sessionId, cdnUrl, signal, progress } = deps;

  progress('Queuing the generation...');
  const queued = await client.generateImage({
    prompt: request.prompt,
    model: request.model,
    ...(request.size ? { size: request.size } : {}),
    ...(request.remoteSessionId ? { sessionId: request.remoteSessionId } : { sessionName: request.notebookName }),
  });

  const quest = await pollQuest(queued.questId, deps);
  const remoteSessionId = quest.sessionId ?? queued.remoteSessionId;

  const { urls, unreachable } = resolveImageUrls(quest, cdnUrl);
  if (urls.length === 0) {
    throw new MediaToolError(
      unreachable.length > 0
        ? `The image was generated (${unreachable.join(', ')}) but this server exposes no URL to download it from.`
        : 'The generation finished without producing an image.'
    );
  }

  progress(urls.length > 1 ? `Downloading ${urls.length} images...` : 'Downloading the image...');

  const media: ChatMedia[] = [];
  for (const url of urls) {
    throwIfAborted(signal);
    const { bytes, contentType } = await client.fetchGenerated(url);
    const stored = await store.save(sessionId, bytes, contentType || contentTypeFromName(url));
    media.push({
      kind: 'image',
      url: stored.url,
      mimeType: stored.mimeType,
      byteLength: stored.byteLength,
      caption: request.prompt,
    });
  }

  return { media, remoteSessionId, unreachable };
}

/**
 * Poll until the quest settles, or the deadline passes.
 *
 * A read that fails is retried rather than fatal: the job is running server-side regardless of
 * whether one poll got through, and a blip on second 12 of a 40-second generation should not
 * lose an image the user has already paid for. Two consecutive failures do end it, because at
 * that point the more likely explanation is that the session went away.
 */
async function pollQuest(questId: string, deps: ImageGenerationDeps): Promise<QuestPoll> {
  const { client, signal, progress } = deps;
  const startedAt = Date.now();
  let delay = FIRST_DELAY_MS;
  let consecutiveFailures = 0;

  for (;;) {
    throwIfAborted(signal);
    const elapsed = Date.now() - startedAt;
    if (elapsed > DEADLINE_MS) {
      throw new MediaToolError(
        `The image was still generating after ${Math.round(DEADLINE_MS / 1000)}s and was given up on. ` +
          `It may still land in the web app under job ${questId}.`
      );
    }

    await sleep(delay, signal);
    delay = Math.min(Math.round(delay * BACKOFF), MAX_DELAY_MS);

    let quest: QuestPoll;
    try {
      quest = await client.getQuest(questId);
      consecutiveFailures = 0;
    } catch (error) {
      consecutiveFailures += 1;
      if (consecutiveFailures >= 2) throw error;
      continue;
    }

    if (quest.type === 'error') {
      throw new MediaToolError(
        quest.reply || 'The image generation failed on the server.',
        quest.errorCode === 'insufficient_credits'
          ? { kind: 'insufficient-credits', text: quest.reply || 'Not enough credits to generate that image.' }
          : undefined
      );
    }

    if (isTerminalQuest(quest)) return quest;

    progress(`Generating... ${Math.round((Date.now() - startedAt) / 1000)}s`);
  }
}

/**
 * Where to download each generated image from.
 *
 * `files` is the server's own resolution and is preferred. It is empty when the deployment has
 * no CDN base configured in the environment the API route reads, in which case the same base
 * from serverConfig (which the client already fetched for the completions endpoint) still
 * resolves the bare names on `images`. Names that neither path can place are reported rather
 * than dropped, so a generation that succeeded is never presented as if nothing happened.
 */
export function resolveImageUrls(quest: QuestPoll, cdnUrl: string): { urls: string[]; unreachable: string[] } {
  const fromFiles = (quest.files ?? []).filter(file => file.isImage && file.url).map(file => file.url);
  if (fromFiles.length > 0) return { urls: fromFiles, unreachable: [] };

  const names = (quest.images ?? []).filter(name => GENERATED_IMAGE_EXTENSION_RE.test(name));
  const base = cdnUrl.replace(/\/+$/, '');
  if (!base) return { urls: [], unreachable: names };

  return { urls: names.map(name => `${base}/generated/${name}`), unreachable: [] };
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
