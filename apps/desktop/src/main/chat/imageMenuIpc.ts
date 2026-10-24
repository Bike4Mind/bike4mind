import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import type { IpcMain, SaveDialogOptions, WebContents } from 'electron';
import type { AddAttachmentsResult, ChatImageAction, ChatImageActionResult, ChatImageRef } from '@shared/chat';
import { IPC_CHANNELS } from '@shared/ipc';
import type { AttachmentStore } from './AttachmentStore';
import { extensionForImageType, isImageMediaType, sanitizeName, type ImageMediaType } from './attachments';
import { parseMediaUrl, type MediaStore } from './media/MediaStore';
import { isValidSessionId } from './SessionStore';

const ACTIONS: ReadonlySet<string> = new Set<ChatImageAction>(['copy', 'save', 'copy-path', 'copy-markdown', 'reveal']);

const URL_MAX = 2048;
const NAME_MAX = 255;

const GONE = 'That image is no longer available.';

export interface ImageMenuDeps {
  media: Pick<MediaStore, 'locate'>;
  attachments: Pick<AttachmentStore, 'locate' | 'add'>;
  readFile(path: string): Promise<Buffer>;
  /** False when the bytes do not decode to something the clipboard can hold. */
  copyImage(bytes: Buffer): Promise<boolean>;
  copyText(text: string): Promise<void>;
  /** The chosen path, or null when the user cancelled. */
  pickSavePath(sender: WebContents, options: SaveDialogOptions): Promise<string | null>;
  copyFile(from: string, to: string): Promise<void>;
  reveal(path: string): void;
  downloadsDirectory(): string;
  now?(): Date;
}

interface ResolvedImage {
  path: string;
  mediaType: ImageMediaType;
  fileName: string;
}

const isText = (value: unknown, max: number): value is string =>
  typeof value === 'string' && value.length > 0 && value.length <= max;

/** parseMediaUrl decodes each segment, and a malformed escape (`%E0`) throws rather than failing. */
function parsesAsMedia(url: string): boolean {
  try {
    return parseMediaUrl(url) !== null;
  } catch {
    return false;
  }
}

/** Checked field by field: the ref crosses IPC from a renderer that draws model output. */
export function parseImageRef(value: unknown): ChatImageRef | null {
  if (!value || typeof value !== 'object') return null;
  const ref = value as Record<string, unknown>;
  if (ref.source === 'media') {
    if (!isText(ref.url, URL_MAX) || !parsesAsMedia(ref.url)) return null;
    const nameHint = ref.nameHint === 'screenshot' ? 'screenshot' : 'image';
    return { source: 'media', url: ref.url, nameHint };
  }
  if (ref.source === 'attachment') {
    const { sessionId, attachmentId, mediaType, name } = ref;
    if (!isText(sessionId, 64) || !isText(attachmentId, 64) || !isText(name, NAME_MAX)) return null;
    if (typeof mediaType !== 'string' || !isImageMediaType(mediaType)) return null;
    return { source: 'attachment', sessionId, attachmentId, mediaType, name };
  }
  if (ref.source === 'remote') {
    if (!isText(ref.url, URL_MAX)) return null;
    try {
      const parsed = new URL(ref.url);
      return parsed.protocol === 'https:' || parsed.protocol === 'http:'
        ? { source: 'remote', url: parsed.href }
        : null;
    } catch {
      return null;
    }
  }
  return null;
}

/** Local time, filename-safe on every platform: 2026-10-21-143005. */
function stamp(date: Date): string {
  const pad = (n: number) => String(n).padStart(2, '0');
  return (
    `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}-` +
    `${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}`
  );
}

function stemOf(name: string): string {
  const stem = sanitizeName(name)
    .replace(/\.[^.]*$/, '')
    .replace(/[\\/:*?|]/g, '-')
    .trim();
  return stem || 'image';
}

/**
 * Angle brackets keep a destination with spaces (Application Support) one link. Elsewhere a
 * backslash is CommonMark's escape character, so a destination that ends in one would escape
 * the closing paren and leave the link unclosed.
 */
export function markdownImage(destination: string): string {
  const escaped = destination
    .replaceAll('\r', '%0D')
    .replaceAll('\n', '%0A')
    .replace(/[\\<>]/g, char => `\\${char}`);
  if (/[\s()]/.test(destination)) return `![](<${escaped}>)`;
  return `![](${escaped})`;
}

/**
 * The image context menu's channels.
 *
 * Every ref is resolved through the store that wrote the file, never taken as a path: a media
 * URL through MediaStore.locate, an attachment through AttachmentStore.locate. A ref either
 * store refuses resolves to nothing, so no renderer input can point an action at another file.
 */
export function registerImageMenuIpc(ipc: Pick<IpcMain, 'handle'>, deps: ImageMenuDeps): void {
  const now = () => deps.now?.() ?? new Date();

  const resolve = async (ref: ChatImageRef): Promise<ResolvedImage | null> => {
    if (ref.source === 'media') {
      const parsed = parseMediaUrl(ref.url);
      const file = parsed && (await deps.media.locate(parsed.sessionId, parsed.name));
      if (!file || !isImageMediaType(file.mimeType)) return null;
      return {
        path: file.path,
        mediaType: file.mimeType,
        fileName: `${ref.nameHint ?? 'image'}-${stamp(now())}.${extensionForImageType(file.mimeType)}`,
      };
    }
    if (ref.source === 'attachment') {
      const path = await deps.attachments.locate(ref.sessionId, ref.attachmentId);
      if (!path || !isImageMediaType(ref.mediaType)) return null;
      return {
        path,
        mediaType: ref.mediaType,
        fileName: `${stemOf(ref.name)}.${extensionForImageType(ref.mediaType)}`,
      };
    }
    return null;
  };

  const act = async (
    sender: WebContents,
    ref: ChatImageRef,
    action: ChatImageAction
  ): Promise<ChatImageActionResult> => {
    if (ref.source === 'remote') {
      if (action !== 'copy-markdown') return { ok: false, error: 'That image is not saved on this computer.' };
      await deps.copyText(markdownImage(ref.url));
      return { ok: true, done: true };
    }

    const image = await resolve(ref);
    if (!image) return { ok: false, error: GONE };

    switch (action) {
      case 'copy': {
        if (!(await deps.copyImage(await deps.readFile(image.path)))) {
          return { ok: false, error: 'This image format cannot be copied. Save it instead.' };
        }
        return { ok: true, done: true };
      }
      case 'save': {
        const extension = extensionForImageType(image.mediaType);
        const target = await deps.pickSavePath(sender, {
          defaultPath: join(deps.downloadsDirectory(), image.fileName),
          filters: [{ name: 'Image', extensions: [extension] }],
        });
        if (!target) return { ok: true, done: false };
        await deps.copyFile(image.path, target);
        return { ok: true, done: true };
      }
      case 'copy-path':
        await deps.copyText(image.path);
        return { ok: true, done: true };
      case 'copy-markdown':
        await deps.copyText(markdownImage(pathToFileURL(image.path).href));
        return { ok: true, done: true };
      case 'reveal':
        deps.reveal(image.path);
        return { ok: true, done: true };
    }
  };

  ipc.handle(
    IPC_CHANNELS.chatImageAction,
    async (event, value: unknown, action: unknown): Promise<ChatImageActionResult> => {
      const ref = parseImageRef(value);
      if (!ref || typeof action !== 'string' || !ACTIONS.has(action)) return { ok: false, error: GONE };
      try {
        return await act(event.sender, ref, action as ChatImageAction);
      } catch (error) {
        return { ok: false, error: error instanceof Error ? error.message : String(error) };
      }
    }
  );

  ipc.handle(
    IPC_CHANNELS.chatAttachImage,
    async (_event, sessionId: unknown, value: unknown): Promise<AddAttachmentsResult> => {
      const gone: AddAttachmentsResult = { attachments: [], rejected: [{ name: 'image', reason: GONE }] };
      if (typeof sessionId !== 'string' || !isValidSessionId(sessionId)) return gone;
      try {
        const ref = parseImageRef(value);
        const image = ref && (await resolve(ref));
        if (!image) return gone;
        const data = await deps.readFile(image.path);
        return await deps.attachments.add(sessionId, [
          { source: 'bytes', name: image.fileName, mediaType: image.mediaType, data },
        ]);
      } catch {
        // The file can vanish between locate and read, or the write can fail; either way the
        // renderer already knows how to show a rejected batch, so answer with one.
        return { attachments: [], rejected: [{ name: 'image', reason: 'That image could not be attached.' }] };
      }
    }
  );
}
