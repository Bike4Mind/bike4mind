import { mkdtemp, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { describe, expect, it } from 'vitest';
import { MAX_MEDIA_BYTES, MediaStore, parseMediaUrl } from './MediaStore';

async function store(): Promise<{ store: MediaStore; base: string }> {
  const base = await mkdtemp(join(tmpdir(), 'b4m-media-'));
  return { store: new MediaStore(base), base };
}

const SESSION = 'f1a2b3c4-0000-4000-8000-000000000001';

describe('MediaStore', () => {
  it('round-trips bytes through a url the renderer can load', async () => {
    const { store: media } = await store();
    const saved = await media.save(SESSION, Buffer.from('fake-png'), 'image/png');

    expect(saved.url).toMatch(/^b4m-media:\/\/media\/f1a2b3c4-0000-4000-8000-000000000001\/[0-9a-f-]+\.png$/);
    expect(saved.byteLength).toBe(8);

    const parsed = parseMediaUrl(saved.url);
    expect(parsed).toEqual({ sessionId: SESSION, name: saved.name });

    const read = await media.read(parsed!.sessionId, parsed!.name);
    expect(read?.bytes.toString()).toBe('fake-png');
    expect(read?.mimeType).toBe('image/png');
  });

  it('reads a Content-Type back from the stored extension rather than guessing', async () => {
    const { store: media } = await store();
    // audio/mp3 is a legitimate spelling the server may send; it must read back canonically.
    const saved = await media.save(SESSION, Buffer.from('id3'), 'audio/mp3; charset=binary');
    expect(saved.mimeType).toBe('audio/mpeg');
    expect((await media.read(SESSION, saved.name))?.mimeType).toBe('audio/mpeg');
  });

  it('refuses a type it cannot serve rather than writing a file with a guessed extension', async () => {
    const { store: media } = await store();
    await expect(media.save(SESSION, Buffer.from('MZ'), 'application/octet-stream')).rejects.toThrow(/Cannot display/);
    await expect(media.save(SESSION, Buffer.alloc(0), 'image/png')).rejects.toThrow(/empty/);
    await expect(media.save(SESSION, Buffer.alloc(MAX_MEDIA_BYTES + 1), 'image/png')).rejects.toThrow(/too large/);
  });

  // The protocol handler hands these straight through from a URL, so the store is the boundary
  // that has to refuse them - not the caller.
  it('resolves nothing but the names it generated', async () => {
    const { store: media } = await store();
    await media.save(SESSION, Buffer.from('x'), 'image/png');

    expect(await media.read(SESSION, '../../auth-vault.json')).toBeNull();
    expect(await media.read('..', 'f1a2b3c4-0000-4000-8000-000000000001.png')).toBeNull();
    expect(await media.read(SESSION, 'notauuid.png')).toBeNull();
    expect(await media.read(SESSION, 'f1a2b3c4-0000-4000-8000-000000000099.png')).toBeNull();
  });

  it('rejects a url of another scheme or shape', () => {
    expect(parseMediaUrl('file:///etc/passwd')).toBeNull();
    expect(parseMediaUrl('b4m-media://elsewhere/a/b')).toBeNull();
    expect(parseMediaUrl('b4m-media://media/only-one-segment')).toBeNull();
    expect(parseMediaUrl('not a url')).toBeNull();
  });

  it('drops a conversation whole folder when it is deleted', async () => {
    const { store: media, base } = await store();
    await media.save(SESSION, Buffer.from('x'), 'image/png');
    expect(await readdir(base)).toEqual([SESSION]);

    await media.forgetSession(SESSION);
    expect(await readdir(base)).toEqual([]);
    // Idempotent: deleting a conversation that generated nothing must not throw.
    await expect(media.forgetSession(SESSION)).resolves.toBeUndefined();
  });
});

describe('MediaStore.saveStream', () => {
  it('streams a clip to disk and serves it back from the same folder', async () => {
    const { store: media } = await store();
    const saved = await media.saveStream(
      SESSION,
      Readable.from([Buffer.from('ftyp'), Buffer.from('mdat')]),
      'video/mp4',
      1024
    );

    expect(saved).toMatchObject({ mimeType: 'video/mp4', byteLength: 8 });
    expect(saved.url).toMatch(/\.mp4$/);
    expect(await media.locate(SESSION, saved.name)).toMatchObject({ size: 8, mimeType: 'video/mp4' });
  });

  it('refuses a clip over the cap and leaves no partial file behind', async () => {
    const { store: media, base } = await store();
    await expect(
      media.saveStream(SESSION, Readable.from([Buffer.alloc(600), Buffer.alloc(600)]), 'video/mp4', 1024)
    ).rejects.toThrow(/too large/);
    expect(await readdir(join(base, SESSION))).toEqual([]);
  });

  it('refuses a type it would not serve', async () => {
    const { store: media } = await store();
    await expect(media.saveStream(SESSION, Readable.from(['x']), 'text/html', 1024)).rejects.toThrow(/Cannot display/);
  });

  it('locates only names it generated', async () => {
    const { store: media } = await store();
    expect(await media.locate(SESSION, 'video-jobs.json')).toBeNull();
    expect(await media.locate(SESSION, '../other/x.mp4')).toBeNull();
  });
});
