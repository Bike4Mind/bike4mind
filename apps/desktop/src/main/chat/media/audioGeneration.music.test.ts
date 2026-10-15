import type { MusicGeneration } from '@bike4mind/common';
import { describe, expect, it, vi } from 'vitest';
import { MUSIC_DEADLINE_MS, MUSIC_POLL_INTERVAL_MS, generateMusic, type AudioDeps } from './audioGeneration';
import { MediaToolError, type MediaApiClient } from './MediaApiClient';
import type { MediaStore } from './MediaStore';

function job(overrides: Partial<MusicGeneration> = {}): MusicGeneration {
  return {
    id: 'job-1',
    object: 'music_generation',
    state: 'pending',
    model: 'lyria-3.5',
    prompt: 'lo-fi',
    lyrics: null,
    instrumental: true,
    duration_seconds: 30,
    source: 'agent',
    error: null,
    output: null,
    credits: { reserved: 10, settled: null },
    created_at: '2026-10-15T00:00:00.000Z',
    updated_at: '2026-10-15T00:00:00.000Z',
    ...overrides,
  };
}

const output = (overrides: Partial<NonNullable<MusicGeneration['output']>> = {}): MusicGeneration['output'] => ({
  availability: 'ready',
  url: 'https://cdn.example/song.mp3',
  expires_at: null,
  content_type: 'audio/mpeg',
  duration_seconds: 30,
  lyrics: null,
  file_id: 'file-1',
  ...overrides,
});

const succeeded = (out: MusicGeneration['output']) => job({ state: 'succeeded', output: out });

function setup(polls: MusicGeneration[], created: MusicGeneration = job()) {
  const client = {
    createMusicGeneration: vi.fn().mockResolvedValue(created),
    getMusicGeneration: vi.fn(),
    fetchGenerated: vi.fn().mockResolvedValue({ bytes: Buffer.from('mp3'), contentType: 'audio/mpeg' }),
  };
  for (const poll of polls) client.getMusicGeneration.mockResolvedValueOnce(poll);
  const save = vi.fn().mockResolvedValue({ url: 'b4m-media://x', mimeType: 'audio/mpeg', byteLength: 3 });
  const deps = {
    client: client as unknown as MediaApiClient,
    store: { save } as unknown as MediaStore,
    sessionId: 's1',
  } satisfies AudioDeps;
  let clock = 0;
  const sleep = vi.fn(async (ms: number) => {
    clock += ms;
  });
  return { client, save, deps, options: { sleep, now: () => clock }, sleep };
}

const request = { model: 'lyria-3.5', prompt: 'lo-fi', durationSeconds: 30, instrumental: true };

describe('generateMusic', () => {
  it('creates the job with a fresh idempotency key and stores a ready song', async () => {
    const t = setup([succeeded(output())]);
    const result = await generateMusic(request, t.deps, t.options);

    const [body, key] = t.client.createMusicGeneration.mock.calls[0];
    expect(body).toEqual({ model: 'lyria-3.5', prompt: 'lo-fi', duration_seconds: 30, instrumental: true });
    expect(key).toMatch(/^[0-9a-f-]{36}$/);
    expect(t.save).toHaveBeenCalledWith('s1', Buffer.from('mp3'), 'audio/mpeg');
    expect(result.fabFileId).toBe('file-1');
    expect(result.media).toMatchObject({ kind: 'audio', caption: 'lo-fi', fabFileId: 'file-1' });
    expect(t.sleep).toHaveBeenCalledTimes(1);
  });

  it('omits duration and instrumental when not given', async () => {
    const t = setup([succeeded(output())]);
    await generateMusic({ model: 'm', prompt: 'p' }, t.deps, t.options);
    expect(t.client.createMusicGeneration.mock.calls[0][0]).toEqual({ model: 'm', prompt: 'p' });
  });

  it('does not poll when the created job is already done', async () => {
    const t = setup([], succeeded(output({ file_id: null })));
    const result = await generateMusic(request, t.deps, t.options);
    expect(t.client.getMusicGeneration).not.toHaveBeenCalled();
    expect(result.fabFileId).toBeUndefined();
  });

  it('keeps polling through running and pending_scan until the song is ready', async () => {
    const t = setup([
      job({ state: 'running' }),
      succeeded(output({ availability: 'pending_scan', url: null })),
      succeeded(output()),
    ]);
    await generateMusic(request, t.deps, t.options);
    expect(t.client.getMusicGeneration).toHaveBeenCalledTimes(3);
    expect(t.save).toHaveBeenCalledOnce();
  });

  it.each(['failed', 'blocked', 'cancelled'] as const)('surfaces the server message on %s', async state => {
    const t = setup([job({ state, error: { code: 'content_blocked', message: 'Blocked by policy' } })]);
    await expect(generateMusic(request, t.deps, t.options)).rejects.toThrow('Blocked by policy');
  });

  it('says the file is unavailable when the scan blocked it or there is no output', async () => {
    const blocked = setup([succeeded(output({ availability: 'unavailable', url: null }))]);
    await expect(generateMusic(request, blocked.deps, blocked.options)).rejects.toThrow(/unavailable/);
    const none = setup([succeeded(null)]);
    await expect(generateMusic(request, none.deps, none.options)).rejects.toThrow(/unavailable/);
    expect(blocked.save).not.toHaveBeenCalled();
  });

  it('gives up at the deadline without cancelling, pointing at Files', async () => {
    const t = setup([]);
    t.client.getMusicGeneration.mockResolvedValue(job({ state: 'running' }));
    const error = await generateMusic(request, t.deps, t.options).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(MediaToolError);
    expect((error as Error).message).toMatch(/still rendering.*Files/);
    expect(t.client.getMusicGeneration.mock.calls.length).toBeLessThanOrEqual(
      MUSIC_DEADLINE_MS / MUSIC_POLL_INTERVAL_MS
    );
    expect(t.client).not.toHaveProperty('cancelMusicGeneration');
  });

  it('stops at once when the signal aborts mid-wait', async () => {
    const controller = new AbortController();
    const t = setup([]);
    const sleep = vi.fn(async () => controller.abort());
    await expect(generateMusic(request, t.deps, { ...t.options, sleep, signal: controller.signal })).rejects.toThrow(
      /stopped/
    );
    expect(t.client.getMusicGeneration).not.toHaveBeenCalled();
  });

  it('does not create a job when already aborted', async () => {
    const controller = new AbortController();
    controller.abort();
    const t = setup([]);
    await expect(generateMusic(request, t.deps, { ...t.options, signal: controller.signal })).rejects.toThrow(
      /stopped/
    );
    expect(t.client.createMusicGeneration).not.toHaveBeenCalled();
  });
});
