import { describe, expect, it, vi } from 'vitest';
import {
  StudioTimelineSchema,
  studioRenderOutputKey,
  type IGenerationJobDocument,
  type StudioRenderStatus,
} from '@bike4mind/common';
import {
  DEADLINE_MARGIN_MS,
  HEARTBEAT_INTERVAL_MS,
  RUNNING_STATUS_FRESH_MS,
  runRender,
  type FfmpegRun,
  type RunRenderDeps,
} from './runRender';

const JOB_ID = 'a'.repeat(24);
const VIDEO_ID = 'b'.repeat(24);
const AUDIO_ID = 'c'.repeat(24);
const NOW = new Date('2026-11-17T10:00:00.000Z');

const timeline = StudioTimelineSchema.parse({
  version: 1,
  durationMs: 4000,
  fps: 30,
  outputs: [{ id: 'wide', aspectRatio: '16:9', width: 1280, height: 720 }],
  tracks: [
    { id: 'v', kind: 'video', clips: [{ id: 'c1', fileId: VIDEO_ID, startMs: 0, durationMs: 4000 }] },
    { id: 'm', kind: 'music', clips: [{ id: 'c2', fileId: AUDIO_ID, startMs: 0, durationMs: 4000 }] },
  ],
});

const makeJob = (overrides: Record<string, unknown> = {}, jobTimeline = timeline): IGenerationJobDocument =>
  ({
    id: JOB_ID,
    kind: 'render',
    state: 'running',
    requestedBy: 'user-1',
    deadlineAt: new Date(NOW.getTime() + 60 * 60_000),
    payload: {
      request: { compositionId: 'comp-1', title: 'Promo', output: jobTimeline.outputs[0], timeline: jobTimeline },
      pricing: { usdPerOutputSecond: 0.01, billedSeconds: 4, usd: 0.04 },
      groupId: 'group-1',
      groupSize: 1,
    },
    ...overrides,
  }) as unknown as IGenerationJobDocument;

const readableFiles = [
  { id: VIDEO_ID, filePath: 'files/video.mp4', mimeType: 'video/mp4', moderationStatus: 'clean' },
  { id: AUDIO_ID, filePath: 'files/audio.mp3', mimeType: 'audio/mpeg', moderationStatus: 'clean' },
];

const makeDeps = (overrides: Partial<RunRenderDeps> = {}) => {
  const statuses: StudioRenderStatus[] = [];
  const deps: RunRenderDeps = {
    loadJob: vi.fn(async () => makeJob()),
    findReadableFiles: vi.fn(async () => readableFiles),
    downloadSource: vi.fn(async () => undefined),
    probeHasAudio: vi.fn(async () => true),
    readStatus: vi.fn(async () => null),
    writeStatus: vi.fn(async (_jobId: string, status: StudioRenderStatus) => {
      statuses.push(status);
    }),
    uploadOutput: vi.fn(async () => undefined),
    enqueueStep: vi.fn(async () => undefined),
    runFfmpeg: vi.fn(async () => undefined),
    ffmpegMajorVersion: 7,
    makeWorkDir: vi.fn(async () => '/work'),
    removeWorkDir: vi.fn(async () => undefined),
    writeTextFile: vi.fn(async () => undefined),
    fileSize: vi.fn(async () => 123_456),
    now: () => NOW,
    logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    ...overrides,
  };
  return { deps, statuses };
};

describe('runRender', () => {
  it.each([
    ['missing', null, 'missing'],
    ['not a render', makeJob({ kind: 'video' }), 'not_render'],
    ['cancelled', makeJob({ state: 'cancelled' }), 'not_running'],
    ['pending with no submit in flight', makeJob({ state: 'pending' }), 'not_running'],
    ['running with a cancel requested', makeJob({ cancelRequested: true }), 'cancel_requested'],
  ])('acks without rendering when the job is %s', async (_label, job, reason) => {
    const { deps } = makeDeps({ loadJob: vi.fn(async () => job) });

    await expect(runRender(JOB_ID, deps)).resolves.toEqual({ outcome: 'skipped', reason });
    expect(deps.writeStatus).not.toHaveBeenCalled();
    expect(deps.runFfmpeg).not.toHaveBeenCalled();
    expect(deps.enqueueStep).not.toHaveBeenCalled();
  });

  it('asks for a redelivery when the engine has not committed running yet', async () => {
    const { deps } = makeDeps({
      loadJob: vi.fn(async () => makeJob({ state: 'pending', submitAttemptedAt: NOW })),
    });

    await expect(runRender(JOB_ID, deps)).resolves.toEqual({ outcome: 'not_yet_running' });
    expect(deps.readStatus).not.toHaveBeenCalled();
    expect(deps.runFfmpeg).not.toHaveBeenCalled();
  });

  it('only re-wakes the engine when a succeeded status already exists', async () => {
    const { deps } = makeDeps({
      readStatus: vi.fn(async () => ({
        state: 'succeeded' as const,
        s3Key: studioRenderOutputKey(JOB_ID),
        bytes: 10,
        durationSeconds: 4,
        updatedAt: NOW.toISOString(),
      })),
    });

    await expect(runRender(JOB_ID, deps)).resolves.toEqual({ outcome: 'already_succeeded' });
    expect(deps.enqueueStep).toHaveBeenCalledWith(JOB_ID);
    expect(deps.runFfmpeg).not.toHaveBeenCalled();
    expect(deps.writeStatus).not.toHaveBeenCalled();
  });

  it('downloads, encodes, uploads, writes succeeded and wakes the engine', async () => {
    const { deps, statuses } = makeDeps();

    await expect(runRender(JOB_ID, deps)).resolves.toEqual({
      outcome: 'succeeded',
      bytes: 123_456,
      durationSeconds: 4,
    });

    expect(deps.findReadableFiles).toHaveBeenCalledWith([VIDEO_ID, AUDIO_ID], 'user-1');
    expect(deps.downloadSource).toHaveBeenCalledWith('files/video.mp4', '/work/source-0', expect.any(AbortSignal));
    expect(deps.downloadSource).toHaveBeenCalledWith('files/audio.mp3', '/work/source-1', expect.any(AbortSignal));
    expect(deps.writeTextFile).toHaveBeenCalledWith('/work/filtergraph.txt', expect.stringContaining('[vout]'));
    expect(deps.uploadOutput).toHaveBeenCalledWith(
      '/work/output.mp4',
      studioRenderOutputKey(JOB_ID),
      expect.any(AbortSignal)
    );
    expect(statuses.map(status => status.state)).toEqual(['running', 'succeeded']);
    expect(statuses[1]).toEqual({
      state: 'succeeded',
      s3Key: studioRenderOutputKey(JOB_ID),
      bytes: 123_456,
      durationSeconds: 4,
      updatedAt: NOW.toISOString(),
    });
    expect(deps.enqueueStep).toHaveBeenCalledWith(JOB_ID);
    expect(deps.removeWorkDir).toHaveBeenCalledWith('/work');
  });

  it('writes throttled progress from ffmpeg and never after the terminal status', async () => {
    let clock = NOW.getTime();
    const { deps, statuses } = makeDeps({
      now: () => new Date(clock),
      runFfmpeg: vi.fn(async ({ onProgress }: FfmpegRun) => {
        clock += 1_000;
        onProgress(500); // Inside the write interval: dropped.
        clock += 5_000;
        onProgress(2_000);
        clock += 5_000;
        onProgress(2_010); // Below the minimum delta: dropped.
      }),
    });

    await runRender(JOB_ID, deps);

    expect(statuses.map(status => status.state)).toEqual(['running', 'running', 'succeeded']);
    expect(statuses[1]).toMatchObject({ state: 'running', progress: 0.5 });
  });

  it('fails without encoding when the owner can no longer read a clip', async () => {
    const { deps, statuses } = makeDeps({ findReadableFiles: vi.fn(async () => [readableFiles[0]]) });

    await expect(runRender(JOB_ID, deps)).resolves.toEqual({
      outcome: 'failed',
      message: 'A file used in this Production is no longer available to you',
    });
    expect(deps.runFfmpeg).not.toHaveBeenCalled();
    expect(statuses.at(-1)).toMatchObject({ state: 'failed' });
    expect(deps.enqueueStep).toHaveBeenCalledWith(JOB_ID);
    expect(deps.removeWorkDir).toHaveBeenCalledWith('/work');
  });

  it('downloads nothing when a clip file is no longer readable', async () => {
    const { deps } = makeDeps({ findReadableFiles: vi.fn(async () => [readableFiles[1]]) });

    await expect(runRender(JOB_ID, deps)).resolves.toMatchObject({ outcome: 'failed' });
    expect(deps.downloadSource).not.toHaveBeenCalled();
  });

  it('refuses a clip that has not cleared moderation', async () => {
    const { deps } = makeDeps({
      findReadableFiles: vi.fn(async () => [readableFiles[0], { ...readableFiles[1], moderationStatus: 'pending' }]),
    });

    await expect(runRender(JOB_ID, deps)).resolves.toMatchObject({ outcome: 'failed' });
    expect(deps.downloadSource).toHaveBeenCalledTimes(1);
  });

  it('reports an encoder failure generically, never the raw error, and wakes the engine', async () => {
    const { deps, statuses } = makeDeps({
      runFfmpeg: vi.fn(async () => {
        throw new Error('ffmpeg exited with 1: https://bucket.example/secret?X-Amz-Signature=abc');
      }),
    });

    const result = await runRender(JOB_ID, deps);

    expect(result).toEqual({ outcome: 'failed', message: 'The render failed while encoding the video.' });
    const failed = statuses.at(-1);
    expect(failed).toMatchObject({ state: 'failed', message: 'The render failed while encoding the video.' });
    expect(JSON.stringify(statuses)).not.toContain('X-Amz');
    expect(deps.uploadOutput).not.toHaveBeenCalled();
    expect(deps.enqueueStep).toHaveBeenCalledWith(JOB_ID);
    expect(deps.removeWorkDir).toHaveBeenCalledWith('/work');
  });

  it('fails a job whose deadline leaves no room to render', async () => {
    const { deps, statuses } = makeDeps({
      loadJob: vi.fn(async () => makeJob({ deadlineAt: new Date(NOW.getTime() + DEADLINE_MARGIN_MS - 1) })),
    });

    await expect(runRender(JOB_ID, deps)).resolves.toEqual({
      outcome: 'failed',
      message: 'The render did not finish in time.',
    });
    expect(deps.runFfmpeg).not.toHaveBeenCalled();
    expect(statuses).toHaveLength(1);
  });

  it('kills the encode at the deadline and reports a timeout', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    try {
      const { deps, statuses } = makeDeps({
        loadJob: vi.fn(async () => makeJob({ deadlineAt: new Date(NOW.getTime() + DEADLINE_MARGIN_MS + 1_000) })),
        runFfmpeg: vi.fn(
          ({ signal }: FfmpegRun) =>
            new Promise<void>((_resolve, reject) => {
              signal.addEventListener('abort', () => reject(new Error('killed')));
            })
        ),
      });

      const pending = runRender(JOB_ID, deps);
      await vi.advanceTimersByTimeAsync(1_000);

      await expect(pending).resolves.toEqual({ outcome: 'failed', message: 'The render did not finish in time.' });
      expect(statuses.at(-1)).toMatchObject({ state: 'failed' });
    } finally {
      vi.useRealTimers();
    }
  });

  it('releases the status when the caller aborts for shutdown, so the redelivery encodes again', async () => {
    const controller = new AbortController();
    const { deps, statuses } = makeDeps({
      runFfmpeg: vi.fn(
        ({ signal }: FfmpegRun) =>
          new Promise<void>((_resolve, reject) => {
            signal.addEventListener('abort', () => reject(new Error('killed')));
            controller.abort();
          })
      ),
    });

    await expect(runRender(JOB_ID, deps, { signal: controller.signal })).resolves.toEqual({
      outcome: 'aborted',
      released: true,
    });
    expect(statuses.map(status => status.state)).toEqual(['running', 'running']);
    // An epoch heartbeat is never fresh, so the redelivered message is not taken for a live duplicate.
    expect(statuses[1]).toMatchObject({ updatedAt: new Date(0).toISOString() });
    expect(deps.enqueueStep).not.toHaveBeenCalled();
    expect(deps.removeWorkDir).toHaveBeenCalledWith('/work');
  });

  it('reports the release as failed when the shutdown status write rejects', async () => {
    const controller = new AbortController();
    const writeStatus = vi.fn(async (_id: string, status: { updatedAt: string }) => {
      if (status.updatedAt === new Date(0).toISOString()) throw new Error('mongo down');
    });
    const { deps } = makeDeps({
      writeStatus,
      runFfmpeg: vi.fn(
        ({ signal }: FfmpegRun) =>
          new Promise<void>((_resolve, reject) => {
            signal.addEventListener('abort', () => reject(new Error('killed')));
            controller.abort();
          })
      ),
    });

    await expect(runRender(JOB_ID, deps, { signal: controller.signal })).resolves.toEqual({
      outcome: 'aborted',
      released: false,
    });
  });

  describe('duplicate deliveries', () => {
    const runningAt = (updatedAt: Date) => ({
      state: 'running' as const,
      progress: 0.4,
      updatedAt: updatedAt.toISOString(),
    });

    it('drops a delivery while another task holds a fresh running status', async () => {
      const { deps } = makeDeps({ readStatus: vi.fn(async () => runningAt(new Date(NOW.getTime() - 10_000))) });

      await expect(runRender(JOB_ID, deps)).resolves.toEqual({ outcome: 'skipped', reason: 'in_progress' });
      expect(deps.writeStatus).not.toHaveBeenCalled();
      expect(deps.runFfmpeg).not.toHaveBeenCalled();
      expect(deps.enqueueStep).not.toHaveBeenCalled();
    });

    it.each([
      ['stale (its task died)', new Date(NOW.getTime() - RUNNING_STATUS_FRESH_MS)],
      ['released on shutdown', new Date(0)],
    ])('encodes when the running status is %s', async (_label, updatedAt) => {
      const { deps } = makeDeps({ readStatus: vi.fn(async () => runningAt(updatedAt)) });

      await expect(runRender(JOB_ID, deps)).resolves.toMatchObject({ outcome: 'succeeded' });
    });
  });

  it('drops a progress tick that arrives after the final status', async () => {
    let clock = NOW.getTime();
    let lateTick: ((outTimeMs: number) => void) | undefined;
    const { deps, statuses } = makeDeps({
      now: () => new Date(clock),
      runFfmpeg: vi.fn(async ({ onProgress }: FfmpegRun) => {
        lateTick = onProgress;
      }),
    });

    await runRender(JOB_ID, deps);
    clock += 60_000;
    lateTick?.(3_000);
    await Promise.resolve();

    expect(statuses.map(status => status.state)).toEqual(['running', 'succeeded']);
  });

  it('leaves the message for redelivery, without writing failed, when the succeeded write fails', async () => {
    const { deps, statuses } = makeDeps({
      writeStatus: vi.fn(async (_jobId: string, status: StudioRenderStatus) => {
        if (status.state === 'succeeded') throw new Error('S3 unavailable');
        statuses.push(status);
      }),
    });

    await expect(runRender(JOB_ID, deps)).rejects.toThrow('S3 unavailable');
    expect(statuses.map(status => status.state)).toEqual(['running']);
  });

  describe('heartbeat', () => {
    const hangUntilAborted = () =>
      vi.fn(
        ({ signal }: FfmpegRun) =>
          new Promise<void>((_resolve, reject) => {
            signal.addEventListener('abort', () => reject(new Error('killed')));
          })
      );

    it('re-stamps the running status and stops the encode once the job is cancelled', async () => {
      vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval'] });
      try {
        const loadJob = vi
          .fn<RunRenderDeps['loadJob']>()
          .mockResolvedValueOnce(makeJob())
          .mockResolvedValueOnce(makeJob())
          .mockResolvedValue(makeJob({ cancelRequested: true }));
        const { deps, statuses } = makeDeps({ loadJob, runFfmpeg: hangUntilAborted() });

        const pending = runRender(JOB_ID, deps);
        await vi.advanceTimersByTimeAsync(HEARTBEAT_INTERVAL_MS);
        expect(statuses.map(status => status.state)).toEqual(['running', 'running']);

        await vi.advanceTimersByTimeAsync(HEARTBEAT_INTERVAL_MS);
        await expect(pending).resolves.toEqual({ outcome: 'cancelled' });
        expect(statuses.map(status => status.state)).toEqual(['running', 'running', 'running']);
        expect(deps.uploadOutput).not.toHaveBeenCalled();
        expect(deps.enqueueStep).not.toHaveBeenCalled();
        expect(deps.removeWorkDir).toHaveBeenCalledWith('/work');

        // The heartbeat is stopped: nothing more is written or loaded.
        const loads = loadJob.mock.calls.length;
        await vi.advanceTimersByTimeAsync(HEARTBEAT_INTERVAL_MS * 3);
        expect(statuses).toHaveLength(3);
        expect(loadJob).toHaveBeenCalledTimes(loads);
      } finally {
        vi.useRealTimers();
      }
    });

    it('stops the encode when the job left running (e.g. failed at its deadline by the engine)', async () => {
      vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval'] });
      try {
        const loadJob = vi
          .fn<RunRenderDeps['loadJob']>()
          .mockResolvedValueOnce(makeJob())
          .mockResolvedValue(makeJob({ state: 'failed' }));
        const { deps, statuses } = makeDeps({ loadJob, runFfmpeg: hangUntilAborted() });

        const pending = runRender(JOB_ID, deps);
        await vi.advanceTimersByTimeAsync(HEARTBEAT_INTERVAL_MS);

        await expect(pending).resolves.toEqual({ outcome: 'cancelled' });
        expect(statuses.some(status => status.state === 'failed')).toBe(false);
      } finally {
        vi.useRealTimers();
      }
    });

    it('keeps encoding when the re-check itself fails', async () => {
      vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval'] });
      try {
        let finish: () => void = () => undefined;
        const loadJob = vi
          .fn<RunRenderDeps['loadJob']>()
          .mockResolvedValueOnce(makeJob())
          .mockRejectedValue(new Error('mongo down'));
        const { deps } = makeDeps({
          loadJob,
          runFfmpeg: vi.fn(
            () =>
              new Promise<void>(resolve => {
                finish = resolve;
              })
          ),
        });

        const pending = runRender(JOB_ID, deps);
        await vi.advanceTimersByTimeAsync(HEARTBEAT_INTERVAL_MS);
        finish();

        await expect(pending).resolves.toMatchObject({ outcome: 'succeeded' });
        expect(deps.logger.warn).toHaveBeenCalledWith('render job re-check failed', expect.anything());
      } finally {
        vi.useRealTimers();
      }
    });
  });

  it('skips files on a disabled track', async () => {
    const withDisabledMusic = {
      ...timeline,
      tracks: timeline.tracks.map(track => (track.kind === 'music' ? { ...track, enabled: false } : track)),
    };
    const { deps } = makeDeps({ loadJob: vi.fn(async () => makeJob({}, withDisabledMusic)) });

    await runRender(JOB_ID, deps);

    expect(deps.findReadableFiles).toHaveBeenCalledWith([VIDEO_ID], 'user-1');
  });
});
