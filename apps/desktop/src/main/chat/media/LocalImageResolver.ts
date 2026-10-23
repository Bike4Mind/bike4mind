import { constants } from 'node:fs';
import { open } from 'node:fs/promises';
import { isAbsolute } from 'node:path';
import type { ChatLocalImageResult } from '@shared/chat';
import { imageMediaTypeForName, type ImageMediaType } from '../attachments';
import { isWithin, physicalTarget, resolveWithinRoots } from '../tools/paths';
import { protectionFor } from '../tools/sandbox';
import { MAX_MEDIA_BYTES, type MediaStore } from './MediaStore';

const UNAVAILABLE: ChatLocalImageResult = { ok: false, error: 'unavailable' };

export interface LocalImageResolverDeps {
  media: Pick<MediaStore, 'findIdempotent' | 'saveIdempotent'>;
  rootsForSession(sessionId: string): Promise<readonly string[] | null>;
  protectedPaths?: readonly string[];
  decode(bytes: Buffer): boolean;
}

export class LocalImageResolver {
  constructor(private readonly deps: LocalImageResolverDeps) {}

  async resolve(sessionId: string, requested: string): Promise<ChatLocalImageResult> {
    if (!isAbsolute(requested) || requested.split(/[\\/]+/).includes('..')) return UNAVAILABLE;
    const mediaType = imageMediaTypeForName(requested);
    if (!mediaType) return UNAVAILABLE;
    const cached = await this.deps.media.findIdempotent(sessionId, requested, mediaType).catch(() => null);
    if (cached) return { ok: true, url: cached.url, mimeType: cached.mimeType };

    try {
      const roots = await this.deps.rootsForSession(sessionId);
      if (!roots) return UNAVAILABLE;
      const path = await resolveWithinRoots(requested, roots);
      const real = await physicalTarget(path);
      if (
        (this.deps.protectedPaths ?? []).some(guarded => isWithin(guarded, path) || isWithin(guarded, real)) ||
        protectionFor([path, real], 'read')
      ) {
        return UNAVAILABLE;
      }
      const handle = await open(real, constants.O_RDONLY | constants.O_NOFOLLOW);
      const { info, bytes } = await (async () => {
        try {
          const info = await handle.stat();
          if (!info.isFile() || info.size === 0 || info.size > MAX_MEDIA_BYTES) return { info, bytes: Buffer.alloc(0) };
          const buffer = Buffer.alloc(info.size + 1);
          const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
          return { info, bytes: buffer.subarray(0, bytesRead) };
        } finally {
          await handle.close();
        }
      })();
      if (bytes.length !== info.size || bytes.length > MAX_MEDIA_BYTES) {
        return UNAVAILABLE;
      }
      if (!matchesType(bytes, mediaType) || !this.deps.decode(bytes)) return UNAVAILABLE;
      const saved = await this.deps.media.saveIdempotent(sessionId, requested, bytes, mediaType);
      return { ok: true, url: saved.url, mimeType: saved.mimeType };
    } catch {
      return UNAVAILABLE;
    }
  }
}

function matchesType(bytes: Buffer, mediaType: ImageMediaType): boolean {
  if (mediaType === 'image/png') return bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
  if (mediaType === 'image/jpeg') {
    return bytes[0] === 0xff && bytes[1] === 0xd8 && bytes.at(-2) === 0xff && bytes.at(-1) === 0xd9;
  }
  if (mediaType === 'image/gif') {
    const header = bytes.subarray(0, 6).toString('ascii');
    return header === 'GIF87a' || header === 'GIF89a';
  }
  return bytes.subarray(0, 4).toString('ascii') === 'RIFF' && bytes.subarray(8, 12).toString('ascii') === 'WEBP';
}
