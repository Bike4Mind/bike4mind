import type { MusicGeneration } from '@bike4mind/common';
import { describe, expect, it, vi } from 'vitest';
import {
  MUSIC_DEADLINE_MS,
  MUSIC_MAX_POLL_FAILURES,
  MUSIC_POLL_INTERVAL_MS,
  MUSIC_RATE_LIMIT_BACKOFF_MS,
  generateMusic,
  type AudioDeps,
} from './audioGeneration';
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
    cancelMusicGeneration: vi.fn().mockResolvedValue(job({ state: 'cancelled' })),
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
    expect(t.client.fetchGenerated).toHaveBeenCalledWith(
      'https://cdn.example/song.mp3',
      'Downloading the generated song'
    );
    expect(t.save).toHaveBeenCalledWith('s1', Buffer.from('mp3'), 'audio/mpeg');
    expect(result.fabFileId).toBe('file-1');
    expect(result.media).toMatchObject({ kind: 'audio', caption: 'lo-fi', fabFileId: 'file-1' });
    expect(t.sleep).toHaveBeenCalledTimes(1);
  });

  it('uses the idempotency key it is given', async () => {
    const t = setup([succeeded(output())]);
    await generateMusic(request, t.deps, { ...t.options, idempotencyKey: 'desktop-music:c1' });
    expect(t.client.createMusicGeneration.mock.calls[0][1]).toBe('desktop-music:c1');
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
    await expect(generateMusic(request, blocked.deps, blocked.options)).rejects.toThrow(/blocked or removed/);
    const none = setup([succeeded(null)]);
    await expect(generateMusic(request, none.deps, none.options)).rejects.toThrow(/not stored/);
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
    expect(t.client.cancelMusicGeneration).not.toHaveBeenCalled();
  });

  it('says the song finished and is being scanned when the deadline hits in pending_scan', async () => {
    const t = setup([], succeeded(output({ availability: 'pending_scan', url: null })));
    t.client.getMusicGeneration.mockResolvedValue(succeeded(output({ availability: 'pending_scan', url: null })));
    const error = await generateMusic(request, t.deps, t.options).catch((e: unknown) => e);
    expect((error as Error).message).toMatch(/finished.*scanned.*Files/);
    expect((error as Error).message).not.toMatch(/still rendering/);
  });

  it('rides out a failed read and gives up only after consecutive failures', async () => {
    const blip = setup([]);
    blip.client.getMusicGeneration
      .mockRejectedValueOnce(new Error('network'))
      .mockResolvedValueOnce(succeeded(output()));
    await generateMusic(request, blip.deps, blip.options);
    expect(blip.save).toHaveBeenCalledOnce();

    const down = setup([]);
    down.client.getMusicGeneration.mockRejectedValue(new Error('network'));
    const error = await generateMusic(request, down.deps, down.options).catch((e: unknown) => e);
    expect(down.client.getMusicGeneration).toHaveBeenCalledTimes(MUSIC_MAX_POLL_FAILURES);
    expect((error as Error).message).toMatch(/may still land in Files/);
    expect(down.client.cancelMusicGeneration).not.toHaveBeenCalled();
  });

  it('backs off after a rate-limited read', async () => {
    const t = setup([]);
    const limited = Object.assign(new MediaToolError('slow down'), { status: 429 });
    t.client.getMusicGeneration.mockRejectedValueOnce(limited).mockResolvedValueOnce(succeeded(output()));
    await generateMusic(request, t.deps, t.options);
    expect(t.sleep.mock.calls.map(call => call[0])).toEqual([MUSIC_POLL_INTERVAL_MS, MUSIC_RATE_LIMIT_BACKOFF_MS]);
  });

  it('waits out a rate-limited read for as long as the server asked', async () => {
    const t = setup([]);
    const limited = Object.assign(new MediaToolError('slow down'), { status: 429, retryAfterMs: 45_000 });
    t.client.getMusicGeneration.mockRejectedValueOnce(limited).mockResolvedValueOnce(succeeded(output()));
    await generateMusic(request, t.deps, t.options);
    expect(t.sleep.mock.calls.map(call => call[0])).toEqual([MUSIC_POLL_INTERVAL_MS, 45_000]);
  });

  it('does not shorten the poll gap when a rate-limited read asks for less', async () => {
    const t = setup([job({ state: 'running' }), job({ state: 'running' }), job({ state: 'running' })]);
    const limited = Object.assign(new MediaToolError('slow down'), { status: 429, retryAfterMs: 1_000 });
    t.client.getMusicGeneration.mockRejectedValueOnce(limited).mockResolvedValueOnce(succeeded(output()));
    await generateMusic(request, t.deps, t.options);

    // By the time the 429 lands the gap has reached its cap, so the server's one-second
    // Retry-After must not send the reads back to full speed.
    const waits = t.sleep.mock.calls.map(call => call[0]);
    expect(waits[waits.length - 2]).toBe(30_000);
    expect(waits[waits.length - 1]).toBe(30_000);
    expect(waits.every(wait => wait >= MUSIC_POLL_INTERVAL_MS)).toBe(true);
  });

  it('does not give up on a song while the reads keep getting rate limited', async () => {
    const t = setup([]);
    const limited = Object.assign(new MediaToolError('slow down'), { status: 429 });
    // One past the failure cap: a 429 is this app's own read budget, not the job failing, so the
    // song that is already billed has to survive more of them than a network error would.
    for (let i = 0; i <= MUSIC_MAX_POLL_FAILURES; i += 1) {
      t.client.getMusicGeneration.mockRejectedValueOnce(limited);
    }
    t.client.getMusicGeneration.mockResolvedValueOnce(succeeded(output()));
    await generateMusic(request, t.deps, t.options);
    expect(t.client.getMusicGeneration).toHaveBeenCalledTimes(MUSIC_MAX_POLL_FAILURES + 2);
    expect(t.save).toHaveBeenCalledOnce();
  });

  it('cancels the job when stopped after it exists', async () => {
    const controller = new AbortController();
    const t = setup([]);
    const sleep = vi.fn(async () => controller.abort());
    const error = await generateMusic(request, t.deps, { ...t.options, sleep, signal: controller.signal }).catch(
      (e: unknown) => e
    );
    expect(t.client.cancelMusicGeneration).toHaveBeenCalledWith('job-1');
    expect((error as Error).message).toMatch(/stopped/);
  });

  it('still reports the stop when the cancel call fails', async () => {
    const controller = new AbortController();
    const t = setup([]);
    t.client.cancelMusicGeneration.mockRejectedValue(new Error('offline'));
    const sleep = vi.fn(async () => controller.abort());
    await expect(generateMusic(request, t.deps, { ...t.options, sleep, signal: controller.signal })).rejects.toThrow(
      /stopped/
    );
  });

  it('submits without the signal, so a stop cannot cut the create off', async () => {
    const controller = new AbortController();
    const t = setup([succeeded(output())]);
    await generateMusic(request, t.deps, { ...t.options, signal: controller.signal });
    expect(t.client.createMusicGeneration.mock.calls[0][2]).toBeUndefined();
  });

  it('cancels the job the server created while the stop was arriving', async () => {
    const controller = new AbortController();
    const t = setup([]);
    t.client.createMusicGeneration.mockImplementation(async () => {
      controller.abort();
      return job();
    });

    const error = await generateMusic(request, t.deps, { ...t.options, signal: controller.signal }).catch(
      (e: unknown) => e
    );
    expect(t.client.cancelMusicGeneration).toHaveBeenCalledWith('job-1');
    expect((error as Error).message).toMatch(/stopped/);
    expect(t.client.getMusicGeneration).not.toHaveBeenCalled();
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
