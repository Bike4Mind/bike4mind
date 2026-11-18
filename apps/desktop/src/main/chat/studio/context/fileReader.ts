import { constants } from 'node:fs';
import { open } from 'node:fs/promises';
import { isAbsolute } from 'node:path';
import { hostRealpath, PathAccessDenied, resolveWithinRoots } from '../../tools/paths';
import { boundedText } from './collector';
import type { ContextReaders } from './types';

export function createContextFileReader(
  rootsForRequester: (sessionId: string) => Promise<readonly string[]>
): ContextReaders['readFile'] {
  return async (requester, path, maxBytes, signal) => {
    signal.throwIfAborted();
    if (!isAbsolute(path)) return { status: 'denied' };
    if (!Number.isSafeInteger(maxBytes) || maxBytes < 1 || maxBytes > 65_536)
      throw new RangeError('Invalid read limit');
    try {
      const roots = await rootsForRequester(requester);
      const checked = await resolveWithinRoots(path, roots);
      const canonicalPath = await hostRealpath(checked);
      await resolveWithinRoots(canonicalPath, roots);
      signal.throwIfAborted();
      const file = await open(canonicalPath, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
      try {
        const stat = await file.stat();
        if (!stat.isFile()) return { status: 'unavailable' };
        const buffer = Buffer.alloc(maxBytes + 1);
        let bytes = 0;
        while (bytes < buffer.length) {
          signal.throwIfAborted();
          const read = await file.read(buffer, bytes, buffer.length - bytes, bytes);
          if (read.bytesRead === 0) break;
          bytes += read.bytesRead;
        }
        await resolveWithinRoots(canonicalPath, await rootsForRequester(requester));
        signal.throwIfAborted();
        const decoder = new TextDecoder('utf-8');
        const text = boundedText(
          decoder.decode(buffer.subarray(0, Math.min(bytes, maxBytes)), { stream: bytes > maxBytes }),
          maxBytes
        );
        if (text.includes('\0')) return { status: 'unavailable' };
        return { status: 'ok', value: { canonicalPath, text, truncated: bytes > maxBytes || stat.size > bytes } };
      } finally {
        await file.close();
      }
    } catch (error) {
      signal.throwIfAborted();
      if (error instanceof PathAccessDenied) return { status: 'denied' };
      const code = (error as NodeJS.ErrnoException).code;
      if (code === 'ENOENT' || code === 'ENOTDIR') return { status: 'missing' };
      if (code === 'EACCES' || code === 'EPERM' || code === 'ELOOP') return { status: 'denied' };
      return { status: 'unavailable' };
    }
  };
}
