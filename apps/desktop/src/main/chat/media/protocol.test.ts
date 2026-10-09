import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { MediaStore } from './MediaStore';
import { parseRange, serveMedia } from './protocol';

vi.mock('electron', () => ({ protocol: { handle: vi.fn(), registerSchemesAsPrivileged: vi.fn() } }));

const SESSION = 'f1a2b3c4-0000-4000-8000-000000000001';

describe('parseRange', () => {
  it('reads the forms a media element sends', () => {
    expect(parseRange('bytes=0-', 100)).toEqual({ start: 0, end: 99 });
    expect(parseRange('bytes=10-19', 100)).toEqual({ start: 10, end: 19 });
    expect(parseRange('bytes=90-500', 100)).toEqual({ start: 90, end: 99 });
    expect(parseRange('bytes=-10', 100)).toEqual({ start: 90, end: 99 });
  });

  it('answers the whole file for no range or one it does not handle, and refuses one past the end', () => {
    expect(parseRange(null, 100)).toBeNull();
    expect(parseRange('bytes=0-1,5-6', 100)).toBeNull();
    expect(parseRange('bytes=100-', 100)).toBe('unsatisfiable');
    expect(parseRange('bytes=-0', 100)).toBe('unsatisfiable');
  });
});

describe('serveMedia', () => {
  it('serves a clip in ranges, so the player can seek', async () => {
    const media = new MediaStore(await mkdtemp(join(tmpdir(), 'b4m-protocol-')));
    const saved = await media.save(SESSION, Buffer.from('0123456789'), 'video/mp4');

    const whole = await serveMedia(media, new Request(saved.url));
    expect(whole.status).toBe(200);
    expect(whole.headers.get('accept-ranges')).toBe('bytes');
    expect(await whole.text()).toBe('0123456789');

    const part = await serveMedia(media, new Request(saved.url, { headers: { Range: 'bytes=2-5' } }));
    expect(part.status).toBe(206);
    expect(part.headers.get('content-range')).toBe('bytes 2-5/10');
    expect(part.headers.get('content-length')).toBe('4');
    expect(await part.text()).toBe('2345');
  });

  it('404s anything the store did not name', async () => {
    const media = new MediaStore(await mkdtemp(join(tmpdir(), 'b4m-protocol-')));
    expect((await serveMedia(media, new Request(`b4m-media://media/${SESSION}/video-jobs.json`))).status).toBe(404);
  });
});
