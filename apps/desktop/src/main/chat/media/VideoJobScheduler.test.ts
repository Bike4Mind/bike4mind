import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import type { VideoGeneration } from '@bike4mind/common';
import type { ChatVideoJob } from '@shared/chat';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MediaToolError, type MediaApiClient } from './MediaApiClient';
import { MediaStore } from './MediaStore';
import { VideoJobScheduler, type VideoJobConnection } from './VideoJobScheduler';
import { VideoJobStore, type StoredVideoJob } from './VideoJobStore';

const SESSION = 'f1a2b3c4-0000-4000-8000-000000000001';
const SCOPE = 'https://b4m.example|user-1';

function remote(overrides: Partial<VideoGeneration> = {}): VideoGeneration {
  return {
    id: 'job-1',
    object: 'video_generation',
    state: 'pending',
    model: 'gemini-omni-1.1-flash',
    mode: 'text_to_video',
    prompt: 'a red lighthouse',
    duration_seconds: 6,
    aspect_ratio: '16:9',
    resolution: '720p',
    source: 'studio',
    progress: null,
    error: null,
    output: null,
    credits: { reserved: 1217, settled: null },
    created_at: '2026-10-09T00:00:00.000Z',
    updated_at: '2026-10-09T00:00:00.000Z',
    ...overrides,
  };
}

const ready = (id = 'job-1'): VideoGeneration =>
  remote({
    id,
    state: 'succeeded',
    output: {
      availability: 'ready',
      url: 'https://storage.example/clip.mp4?sig=abc',
      expires_at: '2026-10-09T00:15:00.000Z',
      content_type: 'video/mp4',
      duration_seconds: 6,
      file_id: 'file-1',
    },
  });

/** Same contract as VideoJobStore, in memory, so fake timers alone drive every step. */
class MemoryJobStore {
  readonly jobs = new Map<string, StoredVideoJob[]>();
  private readonly gone = new Set<string>();
  async list(sessionId: string) {
    return [...(this.jobs.get(sessionId) ?? [])];
  }
  async get(sessionId: string, jobId: string) {
    return (await this.list(sessionId)).find(job => job.id === jobId);
  }
  async upsert(sessionId: string, job: StoredVideoJob) {
    if (this.gone.has(sessionId)) return false;
    const list = (this.jobs.get(sessionId) ?? []).filter(existing => existing.id !== job.id);
    // Keeps creation order, as the file does.
    const index = (this.jobs.get(sessionId) ?? []).findIndex(existing => existing.id === job.id);
    list.splice(index < 0 ? list.length : index, 0, job);
    this.jobs.set(sessionId, list);
    return true;
  }
  forget(sessionId: string) {
    this.gone.add(sessionId);
  }
}

interface Rig {
  scheduler: VideoJobScheduler;
  store: MemoryJobStore;
  client: {
    getVideoGeneration: ReturnType<typeof vi.fn>;
    cancelVideoGeneration: ReturnType<typeof vi.fn>;
    openVideoDownload: ReturnType<typeof vi.fn>;
  };
  saveStream: ReturnType<typeof vi.fn>;
  emitted: ChatVideoJob[];
  connection: { current: VideoJobConnection | null };
}

function rig(store = new MemoryJobStore()): Rig {
  const client = {
    getVideoGeneration: vi.fn(),
    cancelVideoGeneration: vi.fn(),
    openVideoDownload: vi.fn().mockResolvedValue({ stream: Readable.from(['x']), contentType: 'binary/octet-stream' }),
  };
  const saveStream = vi.fn().mockResolvedValue({
    name: '11111111-2222-4333-8444-555555555555.mp4',
    url: `b4m-media://media/${SESSION}/11111111-2222-4333-8444-555555555555.mp4`,
    mimeType: 'video/mp4',
    byteLength: 4096,
  });
  const emitted: ChatVideoJob[] = [];
  const connection = {
    current: { client: client as unknown as MediaApiClient, scope: SCOPE } as VideoJobConnection | null,
  };
  const scheduler = new VideoJobScheduler({
    store: store as unknown as VideoJobStore,
    media: { saveStream, locate: vi.fn() } as unknown as MediaStore,
    connection: () => connection.current,
    emit: (_sessionId, job) => emitted.push(job),
    logger: { debug: () => undefined, warn: () => undefined },
  });
  return { scheduler, store, client, saveStream, emitted, connection };
}

const track = (r: Rig, job = remote()) =>
  r.scheduler.track({
    sessionId: SESSION,
    callId: 'call-1',
    job,
    modelName: 'Gemini Omni Flash',
    estimatedCredits: 1217,
  });

describe('VideoJobScheduler', () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
    vi.setSystemTime(new Date('2026-10-09T00:00:00.000Z'));
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('records the job before track resolves, so the card survives a crash right after create', async () => {
    const r = rig();
    const job = await track(r);

    expect(job).toMatchObject({ id: 'job-1', callId: 'call-1', state: 'pending', reservedCredits: 1217 });
    expect(await r.store.get(SESSION, 'job-1')).toMatchObject({ scope: SCOPE, state: 'pending' });
    expect(r.emitted.at(-1)?.id).toBe('job-1');
    expect(r.scheduler.following()).toEqual(['job-1']);
  });

  it('polls until the clip is ready, downloads it locally, then never polls again', async () => {
    const r = rig();
    r.client.getVideoGeneration
      .mockResolvedValueOnce(remote({ state: 'running', progress: 0.4 }))
      .mockResolvedValueOnce(ready());
    await track(r);

    await vi.advanceTimersByTimeAsync(10_000);
    expect(r.emitted.at(-1)).toMatchObject({ state: 'running', progress: 0.4 });

    await vi.advanceTimersByTimeAsync(15_000);
    expect(r.client.openVideoDownload).toHaveBeenCalledWith(
      'https://storage.example/clip.mp4?sig=abc',
      expect.any(AbortSignal)
    );
    // Storage's octet-stream label loses to the job's own content type.
    expect(r.saveStream).toHaveBeenCalledWith(SESSION, expect.anything(), 'video/mp4', expect.any(Number));
    await vi.advanceTimersByTimeAsync(0);
    const stored = await r.store.get(SESSION, 'job-1');
    expect(stored?.media?.url).toMatch(/^b4m-media:\/\//);
    expect(r.scheduler.following()).toEqual([]);

    await vi.advanceTimersByTimeAsync(10 * 60_000);
    expect(r.client.getVideoGeneration).toHaveBeenCalledTimes(2);
  });

  it.each([
    [
      'failed',
      remote({
        state: 'failed',
        error: { code: 'provider_error', message: 'The provider failed to generate the video.' },
      }),
    ],
    ['blocked', remote({ state: 'blocked', error: { code: 'content_blocked', message: 'Declined.' } })],
    [
      'cancelled',
      remote({ state: 'cancelled', error: { code: 'cancelled', message: 'The generation was cancelled.' } }),
    ],
  ])('stops polling once the job is %s', async (_state, settled) => {
    const r = rig();
    r.client.getVideoGeneration.mockResolvedValue(settled);
    await track(r);

    await vi.advanceTimersByTimeAsync(10_000);
    expect(r.emitted.at(-1)).toMatchObject({ state: settled.state, error: settled.error?.message });
    await vi.advanceTimersByTimeAsync(60 * 60_000);
    expect(r.client.getVideoGeneration).toHaveBeenCalledTimes(1);
    expect(r.scheduler.following()).toEqual([]);
  });

  it('stops polling when the user cancels, and settles the card at once', async () => {
    const r = rig();
    r.client.getVideoGeneration.mockResolvedValue(remote({ state: 'running' }));
    r.client.cancelVideoGeneration.mockResolvedValue(remote({ state: 'running' }));
    await track(r);
    await vi.advanceTimersByTimeAsync(10_000);

    await r.scheduler.cancel(SESSION, 'job-1');

    expect(r.client.cancelVideoGeneration).toHaveBeenCalledWith('job-1');
    expect(r.emitted.at(-1)).toMatchObject({ state: 'cancelled' });
    await vi.advanceTimersByTimeAsync(60 * 60_000);
    expect(r.client.getVideoGeneration).toHaveBeenCalledTimes(1);
  });

  it('keeps following a job the server says was already storing when the cancel arrived', async () => {
    const r = rig();
    r.client.cancelVideoGeneration.mockResolvedValue(remote({ state: 'storing' }));
    r.client.getVideoGeneration.mockResolvedValue(remote({ state: 'storing' }));
    await track(r);

    await r.scheduler.cancel(SESSION, 'job-1');
    expect(r.emitted.at(-1)).toMatchObject({ state: 'storing' });
    expect(r.scheduler.following()).toEqual(['job-1']);
  });

  it('stops polling when the conversation is deleted or archived, and on quit', async () => {
    for (const close of ['forgetSession', 'stopSession', 'dispose'] as const) {
      const r = rig();
      r.client.getVideoGeneration.mockResolvedValue(remote({ state: 'running' }));
      await track(r);
      if (close === 'dispose') r.scheduler.dispose();
      else r.scheduler[close](SESSION);

      await vi.advanceTimersByTimeAsync(60 * 60_000);
      expect(r.client.getVideoGeneration, close).not.toHaveBeenCalled();
    }
  });

  it('shares one cadence across jobs: one read at a time, never closer than the gap', async () => {
    const r = rig();
    r.client.getVideoGeneration.mockImplementation(async (id: string) => remote({ id, state: 'running' }));
    await track(r, remote({ id: 'job-1' }));
    await track(r, remote({ id: 'job-2' }));
    await track(r, remote({ id: 'job-3' }));

    await vi.advanceTimersByTimeAsync(10_000);
    expect(r.client.getVideoGeneration).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(7_000);
    expect(r.client.getVideoGeneration).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(60_000);
    // ~9 a minute at most, however many jobs run.
    expect(r.client.getVideoGeneration.mock.calls.length).toBeLessThanOrEqual(2 + Math.ceil(60_000 / 7_000));
  });

  it('backs off for a minute when rate limited', async () => {
    const r = rig();
    const limited = Object.assign(new MediaToolError('slow down'), { status: 429 });
    r.client.getVideoGeneration.mockRejectedValueOnce(limited).mockResolvedValue(remote({ state: 'running' }));
    await track(r);

    await vi.advanceTimersByTimeAsync(10_000);
    await vi.advanceTimersByTimeAsync(59_000);
    expect(r.client.getVideoGeneration).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(2_000);
    expect(r.client.getVideoGeneration).toHaveBeenCalledTimes(2);
  });

  it('reports a job stalled after an hour and leaves it alone until asked to check again', async () => {
    const r = rig();
    r.client.getVideoGeneration.mockResolvedValue(remote({ state: 'running' }));
    await track(r);

    await vi.advanceTimersByTimeAsync(61 * 60_000);
    expect(r.emitted.at(-1)).toMatchObject({ stalled: true });
    const calls = r.client.getVideoGeneration.mock.calls.length;
    await vi.advanceTimersByTimeAsync(60 * 60_000);
    expect(r.client.getVideoGeneration).toHaveBeenCalledTimes(calls);

    await r.scheduler.recheck(SESSION, 'job-1');
    await vi.advanceTimersByTimeAsync(7_000);
    expect(r.client.getVideoGeneration.mock.calls.length).toBeGreaterThan(calls);
  });

  it('does not poll a job from another account or backend', async () => {
    const r = rig();
    await track(r);
    r.connection.current = { client: r.connection.current!.client, scope: 'https://other.example|user-2' };

    await vi.advanceTimersByTimeAsync(60_000);
    expect(r.client.getVideoGeneration).not.toHaveBeenCalled();
    expect(r.scheduler.following()).toEqual([]);
  });
});

describe('VideoJobScheduler after a restart', () => {
  it('resumes an unfinished job when its cards are listed, and never polls a finished one', async () => {
    const store = new VideoJobStore(new MediaStore(await mkdtemp(join(tmpdir(), 'b4m-video-jobs-'))));
    const base = {
      callId: 'call-1',
      scope: SCOPE,
      modelId: 'gemini-omni-1.1-flash',
      modelName: 'Gemini Omni Flash',
      prompt: 'x',
      durationSeconds: 6,
      aspectRatio: '16:9',
      resolution: '720p',
      estimatedCredits: 1217,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
    await store.upsert(SESSION, { ...base, id: 'running-job', state: 'running' });
    await store.upsert(SESSION, {
      ...base,
      id: 'done-job',
      state: 'succeeded',
      media: { url: `b4m-media://media/${SESSION}/a.mp4`, mimeType: 'video/mp4', byteLength: 1 },
    });

    // A fresh scheduler is what a relaunch has: nothing in memory, only the file.
    const r = rig(store as unknown as MemoryJobStore);
    r.client.getVideoGeneration.mockResolvedValue(remote({ id: 'running-job', state: 'running' }));
    const listed = await r.scheduler.list(SESSION);

    expect(listed.map(job => job.id)).toEqual(['running-job', 'done-job']);
    expect(listed[0]).not.toHaveProperty('scope');
    expect(r.scheduler.following()).toEqual(['running-job']);
    await vi.waitFor(() =>
      expect(r.client.getVideoGeneration).toHaveBeenCalledWith('running-job', expect.any(AbortSignal))
    );
    expect(r.client.getVideoGeneration).not.toHaveBeenCalledWith('done-job', expect.anything());
    r.scheduler.dispose();
  });
});
