import { describe, expect, it } from 'vitest';
import { existsSync, readFileSync } from 'fs';
import { UploadTooLargeError, spoolRequestToFile } from './spoolRequestToFile';

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

  it('cleanup removes the file and is safe to call twice', async () => {
    const spooled = await spoolRequestToFile(bodyOf('data'), 1024);
    await spooled.cleanup();
    expect(existsSync(spooled.path)).toBe(false);
    await expect(spooled.cleanup()).resolves.toBeUndefined();
  });
});
