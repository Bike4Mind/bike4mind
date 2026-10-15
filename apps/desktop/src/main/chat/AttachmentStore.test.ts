import { mkdtemp, readdir, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { AttachmentStore } from './AttachmentStore';
import { TEXT_BYTE_CAP } from './attachments';

const SESSION = 'session-one';
const logger = { debug: () => undefined, warn: () => undefined };

let base: string;
let scratch: string;
let store: AttachmentStore;

beforeEach(async () => {
  const root = await mkdtemp(join(tmpdir(), 'b4m-attachments-'));
  base = join(root, 'attachments');
  scratch = join(root, 'files');
  await mkdtemp(join(tmpdir(), 'unused-'));
  const { mkdir } = await import('node:fs/promises');
  await mkdir(scratch, { recursive: true });
  store = new AttachmentStore(base, logger);
});

afterEach(async () => {
  const { rm } = await import('node:fs/promises');
  await rm(base, { recursive: true, force: true });
});

describe('AttachmentStore.add', () => {
  it('stores a text file from disk and describes it', async () => {
    const path = join(scratch, 'notes.txt');
    await writeFile(path, 'hello\nworld\n', 'utf8');

    const result = await store.add(SESSION, [{ source: 'path', path }]);

    expect(result.rejected).toEqual([]);
    expect(result.attachments).toHaveLength(1);
    const [attachment] = result.attachments;
    expect(attachment).toMatchObject({ kind: 'text', name: 'notes.txt', mediaType: 'text/plain', sourceBytes: 12 });
    expect((await store.read(SESSION, attachment.id))?.toString('utf8')).toBe('hello\nworld\n');
  });

  // The point of the path route: a 50MB log must not be pulled into main to be thrown away.
  it('reads only the cap from a file far larger than it', async () => {
    const path = join(scratch, 'big.log');
    const line = 'x'.repeat(99) + '\n';
    await writeFile(path, line.repeat(3000), 'utf8');

    const [attachment] = (await store.add(SESSION, [{ source: 'path', path }])).attachments;

    expect(attachment.truncated).toBe(true);
    expect(attachment.sourceBytes).toBe(300_000);
    expect(attachment.byteSize).toBeLessThan(TEXT_BYTE_CAP + 500);
    const stored = (await store.read(SESSION, attachment.id))?.toString('utf8') ?? '';
    expect(stored).toContain('truncated');
  });

  it('stores pasted image bytes under the media type the clipboard gave', async () => {
    const result = await store.add(SESSION, [
      { source: 'bytes', name: 'pasted.png', mediaType: 'image/png', data: new Uint8Array([1, 2, 3, 4]) },
    ]);

    expect(result.attachments[0]).toMatchObject({ kind: 'image', mediaType: 'image/png', byteSize: 4 });
  });

  it('keeps the good files and reports the rest', async () => {
    const good = join(scratch, 'ok.txt');
    const bad = join(scratch, 'bad.dat');
    await writeFile(good, 'fine', 'utf8');
    await writeFile(bad, Buffer.from([0x00, 0x01, 0x02]));

    const result = await store.add(SESSION, [
      { source: 'path', path: good },
      { source: 'path', path: bad },
    ]);

    expect(result.attachments).toHaveLength(1);
    expect(result.rejected).toEqual([{ name: 'bad.dat', reason: expect.stringContaining('binary') }]);
  });

  it('reports a missing file instead of throwing', async () => {
    const result = await store.add(SESSION, [{ source: 'path', path: join(scratch, 'nope.txt') }]);
    expect(result.attachments).toEqual([]);
    expect(result.rejected).toHaveLength(1);
  });

  it('caps how many attachments one turn can take', async () => {
    const inputs = Array.from({ length: 12 }, (_, index) => ({
      source: 'bytes' as const,
      name: `f${index}.txt`,
      data: new Uint8Array([0x61]),
    }));

    const result = await store.add(SESSION, inputs);

    expect(result.attachments).toHaveLength(10);
    expect(result.rejected.at(-1)?.reason).toContain('10 attachments');
  });
});

describe('AttachmentStore lifecycle', () => {
  it('returns null for an attachment that is gone', async () => {
    expect(await store.read(SESSION, 'missing-id')).toBeNull();
  });

  it('refuses an id that would escape the session directory', async () => {
    await expect(store.read(SESSION, '../../../etc/passwd')).rejects.toThrow(/invalid attachment id/);
    await expect(store.read('../elsewhere', 'abc')).rejects.toThrow(/invalid session id/);
  });

  it('discards one attachment', async () => {
    const [attachment] = (await store.add(SESSION, [{ source: 'bytes', name: 'a.txt', data: new Uint8Array([0x61]) }]))
      .attachments;

    await store.discard(SESSION, attachment.id);

    expect(await store.read(SESSION, attachment.id)).toBeNull();
  });

  it('deletes everything a conversation owns', async () => {
    await store.add(SESSION, [{ source: 'bytes', name: 'a.txt', data: new Uint8Array([0x61]) }]);
    await store.deleteSession(SESSION);
    await expect(readdir(join(base, SESSION))).rejects.toThrow();
  });

  // An attachment added to the composer and then removed is unreachable once a turn is sent.
  it('prunes files no message references', async () => {
    const kept = (await store.add(SESSION, [{ source: 'bytes', name: 'a.txt', data: new Uint8Array([0x61]) }]))
      .attachments[0];
    const dropped = (await store.add(SESSION, [{ source: 'bytes', name: 'b.txt', data: new Uint8Array([0x62]) }]))
      .attachments[0];

    await store.prune(SESSION, new Set([kept.id]));

    expect(await store.read(SESSION, kept.id)).not.toBeNull();
    expect(await store.read(SESSION, dropped.id)).toBeNull();
  });

  it('pruning a session with no attachments is a no-op', async () => {
    await expect(store.prune('never-used', new Set())).resolves.toBeUndefined();
  });

  it('refuses a folder with advice that names the other feature', async () => {
    const result = await store.add(SESSION, [{ source: 'path', path: scratch }]);
    expect(result.rejected[0].reason).toContain('folder');
  });
});

describe('AttachmentStore image handling', () => {
  it('passes an oversized image to the injected shrinker', async () => {
    const shrunk = Buffer.alloc(64, 0x41);
    const shrinking = new AttachmentStore(base, logger, () => ({ bytes: shrunk, mediaType: 'image/jpeg' }));
    const path = join(scratch, 'shot.png');
    await writeFile(path, Buffer.alloc(8 * 1024 * 1024, 0x41));

    const [attachment] = (await shrinking.add(SESSION, [{ source: 'path', path }])).attachments;

    expect(attachment.mediaType).toBe('image/jpeg');
    expect(attachment.byteSize).toBe(64);
    expect(attachment.sourceBytes).toBe(8 * 1024 * 1024);
    expect((await readFile(join(base, SESSION, attachment.id))).length).toBe(64);
  });
});
