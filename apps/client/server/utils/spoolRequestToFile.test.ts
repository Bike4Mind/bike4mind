import { describe, expect, it } from 'vitest';
import { existsSync, readFileSync } from 'fs';
import { UploadTooLargeError, spoolRequestToFile } from './spoolRequestToFile';

/** basename() passes a literal ".." through unchanged (it is only two dots, not a separator). */
const parentOf = (spooledPath: string): string => spooledPath.replace(/\/\.\.$/, '');

/** A request body as the route sees it: an async iterable of Buffers. */
const bodyOf = (...chunks: string[]): AsyncIterable<Buffer> => ({
  async *[Symbol.asyncIterator]() {
    for (const c of chunks) yield Buffer.from(c);
  },
});

describe('spoolRequestToFile', () => {
  it('writes the whole body to a temp file and reports its size', async () => {
    const spooled = await spoolRequestToFile(bodyOf('hello ', 'world'), 1024);
    try {
      expect(readFileSync(spooled.path, 'utf8')).toBe('hello world');
      expect(spooled.bytes).toBe(11);
    } finally {
      await spooled.cleanup();
    }
  });

  it('rejects a body that exceeds the cap, reporting the cap', async () => {
    // The point of spooling: never hold the whole upload in memory, and stop the moment the
    // cap is passed rather than after the client has finished sending.
    await expect(spoolRequestToFile(bodyOf('12345', '67890'), 6)).rejects.toBeInstanceOf(UploadTooLargeError);
  });

  it('leaves no temp file behind when it aborts over the cap', async () => {
    let leaked: string | undefined;
    try {
      await spoolRequestToFile(bodyOf('12345', '67890'), 6, { onPath: p => (leaked = p) });
    } catch {
      /* expected */
    }
    expect(leaked, 'test needs the path to check for a leak').toBeDefined();
    expect(existsSync(leaked!)).toBe(false);
  });

  it('keeps a traversing filename inside the temp directory', async () => {
    // Today's callers pass literals, so this is defence in depth for the next one.
    const spooled = await spoolRequestToFile(bodyOf('x'), 1024, { filename: '../../escaped.zip' });
    try {
      expect(spooled.path.endsWith('/escaped.zip')).toBe(true);
      expect(spooled.path).not.toContain('..');
    } finally {
      await spooled.cleanup();
    }
  });

  it('rejects a filename of exactly ".." instead of writing outside the temp directory', async () => {
    // basename('..') returns '..' unchanged, unlike '../../escaped.zip' above, so the resulting
    // path points at the temp directory's parent rather than a file inside it.
    let attemptedPath: string | undefined;
    await expect(
      spoolRequestToFile(bodyOf('x'), 1024, { filename: '..', onPath: p => (attemptedPath = p) })
    ).rejects.toThrow();
    expect(attemptedPath, 'test needs the path to check for a leak').toBeDefined();
    expect(existsSync(parentOf(attemptedPath!))).toBe(false);
  });

  it('cleanup removes the file and is safe to call twice', async () => {
    const spooled = await spoolRequestToFile(bodyOf('data'), 1024);
    await spooled.cleanup();
    expect(existsSync(spooled.path)).toBe(false);
    await expect(spooled.cleanup()).resolves.toBeUndefined();
  });
});
