import { readFile, stat } from 'node:fs/promises';
import { basename, extname } from 'node:path';
import { isWithin, PathAccessDenied, realpathNearest, resolveWithinRoots } from '../tools/paths';
import { credentialPaths } from '../tools/sandbox';
import type { ToolContext } from '../tools/types';
import { MediaToolError, type MediaApiClient } from './MediaApiClient';
import type { MediaStore } from './MediaStore';

/** What the video providers accept as a first frame. */
const INPUT_IMAGE_TYPES: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
};

/** Larger than any first frame needs; a bigger file is almost certainly the wrong one. */
export const MAX_INPUT_IMAGE_BYTES = 20 * 1024 * 1024;

/** A fresh upload is scanned before any endpoint will use it; this usually takes seconds. */
const SCAN_POLL_MS = 2_000;
const SCAN_DEADLINE_MS = 90_000;

export interface VideoInputImage {
  kind: 'generated' | 'file';
  /** What the approval card and the upload call it. */
  name: string;
  path: string;
  mimeType: string;
  size: number;
}

/**
 * The image an image-to-video request starts from, resolved and checked BEFORE the user is asked
 * to approve: the card names the file, and a path outside the shared folders is refused here.
 *
 * Two sources. `inputGeneratedImage` is an image generate_image produced in this conversation,
 * named by the id that tool reported; it resolves only inside this conversation's own media
 * folder, so an id from another conversation finds nothing. `inputImagePath` is a file the user
 * shared, under the same roots as the file tools plus the protected paths the write tools honour:
 * this file leaves the machine, so the token vault and ~/.ssh are refused whatever was granted.
 */
export async function resolveInputImage(
  generatedId: string | undefined,
  requestedPath: string | undefined,
  context: ToolContext,
  store: MediaStore
): Promise<VideoInputImage | undefined> {
  if (generatedId && requestedPath) {
    throw new Error('Pass inputGeneratedImage or inputImagePath, not both.');
  }
  if (generatedId) {
    const located = context.sessionId ? await store.locate(context.sessionId, generatedId) : null;
    if (!located || !Object.values(INPUT_IMAGE_TYPES).includes(located.mimeType)) {
      throw new Error(
        `"${generatedId}" is not an image generated in this conversation. Use an id generate_image reported here.`
      );
    }
    return { kind: 'generated', name: generatedId, path: located.path, mimeType: located.mimeType, size: located.size };
  }
  if (!requestedPath) return undefined;

  const path = await resolveWithinRoots(requestedPath, context.roots, context.workingDirectory);
  const real = await realpathNearest(path);
  for (const guarded of [...(context.protectedPaths ?? []), ...credentialPaths()]) {
    if (isWithin(guarded, real) || isWithin(guarded, path)) {
      throw new PathAccessDenied(
        requestedPath,
        `Refused: ${requestedPath} is a protected location and cannot be uploaded.`
      );
    }
  }
  const mimeType = INPUT_IMAGE_TYPES[extname(path).toLowerCase()];
  if (!mimeType) throw new Error(`${requestedPath} is not a PNG, JPEG or WebP image.`);
  const info = await stat(path);
  if (!info.isFile()) throw new Error(`${requestedPath} is not a file.`);
  if (info.size > MAX_INPUT_IMAGE_BYTES) {
    throw new Error(
      `${requestedPath} is ${Math.round(info.size / 1024 / 1024)}MB; an input image may be at most 20MB.`
    );
  }
  return { kind: 'file', name: basename(path), path, mimeType, size: info.size };
}

/**
 * Upload the image as one of the user's files and wait for the server's scan to clear it.
 *
 * Uploaded even when it is a generated image: the public video API takes only a file id, and
 * the generated-image key the web chat passes is not part of it.
 */
export async function uploadInputImage(
  image: VideoInputImage,
  client: MediaApiClient,
  signal: AbortSignal,
  progress: (text: string) => void
): Promise<string> {
  progress('Uploading the input image...');
  const bytes = await readFile(image.path);
  const upload = await client.uploadFile(image.name, image.mimeType, bytes);

  progress('Waiting for the server to check the input image...');
  const startedAt = Date.now();
  for (;;) {
    const file = await client.getFile(upload.id);
    if (file.moderation_status === 'clean' || file.moderation_status === null) return upload.id;
    if (file.moderation_status === 'blocked') {
      throw new MediaToolError('The server refused the input image after scanning it. Nothing was charged.');
    }
    if (Date.now() - startedAt > SCAN_DEADLINE_MS) {
      throw new MediaToolError(
        'The input image was uploaded but the server had not finished checking it after 90s, so no video was ' +
          'started and nothing was charged. Try again in a minute.'
      );
    }
    await sleep(SCAN_POLL_MS, signal);
  }
}

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) {
      reject(new MediaToolError('The generation was stopped.'));
      return;
    }
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
