import { existsSync } from 'node:fs';
import { truncate, writeFile } from 'node:fs/promises';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { SCENE_MAX_INPUT_BYTES } from '@bike4mind/common';
import { Logger } from '@bike4mind/observability';
import { createInMemoryGenerationJobRepository } from '../generationJobs/__test__/inMemoryGenerationJobRepository';
import { GenerationJobEngine } from '../generationJobs/engine';
import type { CreditHoldAdapters } from '../creditService/creditHold';
import { createSceneCompositionJob } from './createSceneCompositionJob';
import { createSceneJobHandler, SceneInputError } from './sceneJobHandler';
import type {
  CreateSceneCompositionJobDeps,
  CreateSceneCompositionJobResult,
  FfmpegRunner,
  SceneInputFile,
  SceneJobDeps,
} from './types';

vi.mock('../creditService/creditHold', () => ({
  holdCredits: vi.fn(),
  releaseCreditHold: vi.fn(async () => undefined),
  settleCreditHold: vi.fn(async () => 0),
}));
import { holdCredits, releaseCreditHold } from '../creditService/creditHold';

// creditHold is module-mocked, so the adapters are never touched.
const unusedCredits = {} as CreditHoldAdapters;

const VIDEO_ID = 'a'.repeat(24);
const AUDIO_ID = 'b'.repeat(24);
const COVER_ID = 'c'.repeat(24);

const probeOutput = (lines: string[]) => [`Input #0, from 'x':`, ...lines].join('\n');
const PROBES = {
  video: probeOutput(['  Duration: 00:00:10.00, start: 0.000000', '  Stream #0:0: Video: h264, yuv420p, 160x120']),
  audio: probeOutput(['  Duration: 00:00:30.00, start: 0.000000', '  Stream #0:0: Audio: mp3, 44100 Hz, stereo']),
  cover: probeOutput(['  Duration: N/A, bitrate: N/A', '  Stream #0:0: Video: png, rgb24, 64x64']),
  'scene.mp4': probeOutput([
    '  Duration: 00:00:10.01, start: 0.000000',
    '  Stream #0:0: Video: h264, yuv420p, 160x120',
    '  Stream #0:1: Audio: aac, 44100 Hz, stereo',
  ]),
} satisfies Record<string, string>;

const FILES: Record<string, SceneInputFile> = {
  [VIDEO_ID]: { s3Key: 'files/video.mp4', mimeType: 'video/mp4', bytes: 1000 },
  [AUDIO_ID]: { s3Key: 'files/song.mp3', mimeType: 'audio/mpeg', bytes: 500 },
  [COVER_ID]: { s3Key: 'files/cover.png', mimeType: 'image/png', bytes: 100 },
};

/** A stand-in ffmpeg: a probe answers from PROBES by input name, a render writes a small file at the output path. */
const stubFfmpeg = (
  overrides: { probes?: Partial<Record<string, string>>; renderExitCode?: number; renderBytes?: number } = {}
) => {
  const renders: string[][] = [];
  const runner: FfmpegRunner = {
    run: vi.fn(async args => {
      const output = args[args.length - 1];
      if (args.includes('-filter_complex')) {
        renders.push([...args]);
        if (overrides.renderExitCode) return { exitCode: overrides.renderExitCode, stderr: 'Could not write header' };
        await writeFile(output, Buffer.from('rendered scene'));
        if (overrides.renderBytes) await truncate(output, overrides.renderBytes);
        return { exitCode: 0, stderr: '' };
      }
      const name = output.slice(output.lastIndexOf('/') + 1);
      const probes: Record<string, string | undefined> = { ...PROBES, ...overrides.probes };
      return { exitCode: 1, stderr: probes[name] ?? 'Invalid data found when processing input' };
    }),
  };
  return { runner, renders };
};

const setup = (
  options: { ffmpeg?: ReturnType<typeof stubFfmpeg>; deps?: Partial<SceneJobDeps>; denial?: string } = {}
) => {
  let clock = new Date('2026-11-17T00:00:00Z');
  const repository = createInMemoryGenerationJobRepository({ now: () => clock });
  const queue: string[] = [];
  const ffmpeg = options.ffmpeg ?? stubFfmpeg();
  const workDirs: string[] = [];
  const deps: SceneJobDeps & CreateSceneCompositionJobDeps = {
    repository,
    loadInputFile: vi.fn(async (_userId: string, fileId: string) => FILES[fileId] ?? null),
    downloadInputFile: vi.fn(async ({ destinationPath }: { destinationPath: string }) => {
      workDirs.push(destinationPath.slice(0, destinationPath.lastIndexOf('/')));
      await writeFile(destinationPath, Buffer.from('input'));
      return { bytes: 5 };
    }),
    ffmpeg: ffmpeg.runner,
    saveToFiles: vi.fn(async ({ generation: { jobId } }: { generation: { jobId: string } }) => ({
      saved: true as const,
      fileId: `file-${jobId}`,
      s3Key: `files/${jobId}.mp4`,
      fileName: 'scene.mp4',
    })),
    saveToGeneratedBucket: vi.fn(async ({ key }: { key: string }) => ({ s3Key: key })),
    credits: unusedCredits,
    enqueue: vi.fn(async (jobId: string) => {
      queue.push(jobId);
    }),
    now: () => clock,
    logger: new Logger({ metadata: { test: 'sceneJobHandler' } }),
    checkStorageFor: vi.fn(async () => undefined),
    engine: { failBeforeStart: (jobId, error) => engine.failBeforeStart(jobId, error) },
    ...options.deps,
  };
  const engine = new GenerationJobEngine({
    repository,
    handlers: [createSceneJobHandler(deps)],
    enqueue: deps.enqueue,
    notify: async () => undefined,
    now: () => clock,
    logger: deps.logger,
    leaseMs: 330_000,
    ...(options.denial && { aiAccessDenial: async () => options.denial }),
  });
  const runToCompletion = async () => {
    for (let i = 0; i < 20 && queue.length; i++) {
      const jobId = queue.shift();
      if (!jobId) break;
      clock = new Date(clock.getTime() + 60_000);
      await engine.step(jobId);
    }
  };
  const jobOf = (created: CreateSceneCompositionJobResult) => {
    if (!created.ok) throw new Error(`createSceneCompositionJob refused: ${created.code}`);
    const job = repository.jobs.get(created.job.id);
    if (!job || job.kind !== 'compose') throw new Error('compose job vanished');
    return job;
  };
  return { deps, repository, ffmpeg, workDirs, runToCompletion, jobOf };
};

const user = { id: 'u1', organizationId: null };
const create = (deps: CreateSceneCompositionJobDeps, request: Record<string, unknown> = {}, idempotencyKey?: string) =>
  createSceneCompositionJob(
    {
      user,
      request: { videoFileId: VIDEO_ID, audioFileId: AUDIO_ID, ...request },
      source: 'api',
      ...(idempotencyKey && { idempotencyKey }),
    },
    deps
  );

beforeEach(() => {
  vi.clearAllMocks();
});

describe('createSceneCompositionJob', () => {
  it('persists a pending compose job with resolved audio defaults and no credit hold', async () => {
    const { deps, jobOf } = setup();
    const job = jobOf(await create(deps, { title: '  Sunrise  ' }));
    expect(job).toMatchObject({ kind: 'compose', state: 'pending', creditHold: null, source: 'api' });
    expect(job.payload.request).toEqual({
      videoFileId: VIDEO_ID,
      audioFileId: AUDIO_ID,
      audio: { fit: 'trim', fadeInSeconds: 0, fadeOutSeconds: 1.5 },
      title: 'Sunrise',
    });
    expect(deps.enqueue).toHaveBeenCalledWith(job.id, expect.any(Number));
    expect(holdCredits).not.toHaveBeenCalled();
  });

  it('refuses an invalid request before reading any file', async () => {
    const { deps } = setup();
    const result = await create(deps, { audio: { fit: 'stretch', fadeOutSeconds: 11 } });
    expect(result).toMatchObject({ ok: false, status: 422, code: 'invalid_request' });
    expect(deps.loadInputFile).not.toHaveBeenCalled();
  });

  it('answers 404 naming the slot of a file the caller cannot read', async () => {
    const { deps, repository } = setup();
    const result = await create(deps, { coverFileId: 'd'.repeat(24) });
    expect(result).toMatchObject({ ok: false, status: 404, code: 'input_file_not_found', slot: 'cover' });
    expect(repository.jobs.size).toBe(0);
  });

  it('refuses a file of the wrong media kind for its slot', async () => {
    const { deps } = setup();
    const result = await create(deps, { videoFileId: AUDIO_ID });
    expect(result).toMatchObject({ ok: false, status: 422, code: 'unsupported_input' });
  });

  it('refuses inputs over the size cap', async () => {
    const { deps } = setup({
      deps: {
        loadInputFile: vi.fn(async (_userId: string, fileId: string) => {
          const file = FILES[fileId];
          return file && { ...file, bytes: SCENE_MAX_INPUT_BYTES };
        }),
      },
    });
    expect(await create(deps)).toMatchObject({ ok: false, status: 422, code: 'limit_exceeded' });
  });

  it('refuses when the Files quota has no room for the Scene', async () => {
    const storage = { limitBytes: 10, usedBytes: 10, requiredBytes: 1500 };
    const { deps } = setup({
      deps: { checkStorageFor: vi.fn(async () => storage) } as Partial<SceneJobDeps>,
    });
    expect(await create(deps)).toMatchObject({ ok: false, status: 400, code: 'storage_quota_exceeded', storage });
    expect(deps.checkStorageFor).toHaveBeenCalledWith('u1', 1500);
  });

  it('replays an Idempotency-Key and refuses it for a different request', async () => {
    const { deps, repository } = setup();
    const first = await create(deps, {}, 'key-1');
    const again = await create(deps, {}, 'key-1');
    expect(again).toMatchObject({ ok: true, created: false });
    expect(first.ok && again.ok && again.job.id).toBe(first.ok && first.job.id);
    expect(await create(deps, { title: 'other' }, 'key-1')).toMatchObject({
      ok: false,
      status: 422,
      code: 'idempotency_key_reused',
    });
    expect(repository.jobs.size).toBe(1);
  });
});

describe('scene limit boundaries', () => {
  const MAX_INPUT_BYTES = 209_715_200;
  const withTotalBytes = (total: number): Partial<SceneJobDeps> => ({
    loadInputFile: vi.fn(async (_userId: string, fileId: string) => {
      const file = FILES[fileId];
      return file && { ...file, bytes: fileId === VIDEO_ID ? total - FILES[AUDIO_ID].bytes : file.bytes };
    }),
  });

  it('accepts inputs totalling exactly 200 MiB and refuses one byte more', async () => {
    const atCap = setup({ deps: withTotalBytes(MAX_INPUT_BYTES) });
    const job = atCap.jobOf(await create(atCap.deps));
    await atCap.runToCompletion();
    expect(atCap.repository.jobs.get(job.id)).toMatchObject({ state: 'succeeded' });

    const overCap = setup({ deps: withTotalBytes(MAX_INPUT_BYTES + 1) });
    expect(await create(overCap.deps)).toMatchObject({ ok: false, status: 422, code: 'limit_exceeded' });
  });

  it('fails at render, without downloading, when inputs grew past 200 MiB after create', async () => {
    const { deps, jobOf, runToCompletion, repository } = setup();
    const job = jobOf(await create(deps));
    Object.assign(deps, withTotalBytes(MAX_INPUT_BYTES + 1));
    await runToCompletion();
    expect(repository.jobs.get(job.id)).toMatchObject({ state: 'failed', error: { code: 'unsupported_input' } });
    expect(deps.downloadInputFile).not.toHaveBeenCalled();
  });

  it('accepts a video of exactly 300 seconds and refuses 301', async () => {
    const probeFor = (clock: string) =>
      stubFfmpeg({ probes: { video: probeOutput([`  Duration: ${clock}`, '  Stream #0:0: Video: h264']) } });

    const at = setup({ ffmpeg: probeFor('00:05:00.00') });
    const okJob = at.jobOf(await create(at.deps));
    await at.runToCompletion();
    expect(at.repository.jobs.get(okJob.id)).toMatchObject({ state: 'succeeded' });

    const over = setup({ ffmpeg: probeFor('00:05:01.00') });
    const badJob = over.jobOf(await create(over.deps));
    await over.runToCompletion();
    expect(over.repository.jobs.get(badJob.id)).toMatchObject({
      state: 'failed',
      error: { code: 'unsupported_input' },
    });
  });

  it('fails with output_too_large when the rendered file is over 256 MiB', async () => {
    const { deps, jobOf, runToCompletion, repository } = setup({
      ffmpeg: stubFfmpeg({ renderBytes: 268_435_456 + 1 }),
    });
    const job = jobOf(await create(deps));
    await runToCompletion();
    expect(repository.jobs.get(job.id)).toMatchObject({ state: 'failed', error: { code: 'output_too_large' } });
    expect(deps.saveToFiles).not.toHaveBeenCalled();
  });
});

describe('createSceneJobHandler', () => {
  it('fails with unsupported_input, without retrying, when a download passes the input budget', async () => {
    const { deps, jobOf, runToCompletion, repository } = setup();
    const job = jobOf(await create(deps));
    vi.mocked(deps.downloadInputFile).mockRejectedValueOnce(new SceneInputError('too big', 'unsupported_input'));
    await runToCompletion();
    expect(repository.jobs.get(job.id)).toMatchObject({ state: 'failed', error: { code: 'unsupported_input' } });
    expect(deps.downloadInputFile).toHaveBeenCalledTimes(1);
  });

  it('gives each download only the input budget the earlier ones left', async () => {
    const { deps, jobOf, runToCompletion } = setup();
    jobOf(await create(deps));
    await runToCompletion();
    const budgets = vi.mocked(deps.downloadInputFile).mock.calls.map(([params]) => params.maxBytes);
    expect(budgets).toEqual([209_715_200, 209_715_200 - 5]);
  });

  it('renders, stores the Scene with lineage to every input, and settles nothing', async () => {
    const { deps, ffmpeg, workDirs, jobOf, runToCompletion, repository } = setup();
    const job = jobOf(await create(deps, { coverFileId: COVER_ID, title: 'Sunrise' }));
    await runToCompletion();

    const done = repository.jobs.get(job.id);
    expect(done).toMatchObject({ state: 'succeeded', settledCredits: 0 });
    expect(done?.kind === 'compose' && done.payload.output).toMatchObject({
      contentType: 'video/mp4',
      durationSeconds: 10.01,
      bytes: Buffer.byteLength('rendered scene'),
    });
    expect(deps.saveToFiles).toHaveBeenCalledWith(
      expect.objectContaining({
        contentType: 'video/mp4',
        generation: expect.objectContaining({
          generator: 'scene',
          provider: 'ffmpeg',
          jobId: job.id,
          prompt: 'Sunrise',
        }),
        derivedFrom: [
          { fileId: VIDEO_ID, jobId: job.id, role: 'scene_video' },
          { fileId: AUDIO_ID, jobId: job.id, role: 'scene_audio' },
          { fileId: COVER_ID, jobId: job.id, role: 'scene_cover' },
        ],
      })
    );
    // The render is built from the probed durations: a 30s track trimmed to the 10s video.
    expect(ffmpeg.renders).toHaveLength(1);
    expect(ffmpeg.renders[0]).toEqual(expect.arrayContaining(['-t', '10.000', 'attached_pic', 'title=Sunrise']));
    // A null hold is handled: nothing to release, a zero settlement recorded.
    expect(releaseCreditHold).not.toHaveBeenCalled();
    expect(new Set(workDirs).size).toBe(1);
    expect(existsSync(workDirs[0])).toBe(false);
  });

  it.each(['file_too_large', 'storage_limit'] as const)(
    'keeps a Scene Files refuses (%s) outside Files, says why, and renders once',
    async reason => {
      const { deps, ffmpeg, jobOf, runToCompletion, repository } = setup({
        deps: { saveToFiles: vi.fn(async () => ({ saved: false as const, reason })) },
      });
      const job = jobOf(await create(deps));
      await runToCompletion();

      const done = repository.jobs.get(job.id);
      expect(done).toMatchObject({ state: 'succeeded' });
      expect(done?.kind === 'compose' && done.payload.output).toMatchObject({
        location: 'generated',
        s3Key: `generated-video/u1/${job.id}.mp4`,
        filesSkipReason: reason,
      });
      expect(ffmpeg.renders).toHaveLength(1);
      expect(deps.saveToFiles).toHaveBeenCalledTimes(1);
    }
  );

  it('records no skip reason for a Scene saved to Files', async () => {
    const { deps, jobOf, runToCompletion, repository } = setup();
    const job = jobOf(await create(deps));
    await runToCompletion();

    const done = repository.jobs.get(job.id);
    expect(done?.kind === 'compose' && done.payload.output).toMatchObject({ location: 'files' });
    expect(done?.kind === 'compose' && done.payload.output).not.toHaveProperty('filesSkipReason');
  });

  it('fails with unsupported_input when the video runs past the cap, and still cleans up', async () => {
    const ffmpeg = stubFfmpeg({
      probes: { video: probeOutput(['  Duration: 00:05:00.50', '  Stream #0:0: Video: h264']) },
    });
    const { deps, workDirs, jobOf, runToCompletion, repository } = setup({ ffmpeg });
    const job = jobOf(await create(deps));
    await runToCompletion();

    expect(repository.jobs.get(job.id)).toMatchObject({
      state: 'failed',
      error: { code: 'unsupported_input' },
      settledCredits: 0,
    });
    expect(ffmpeg.renders).toHaveLength(0);
    expect(deps.saveToFiles).not.toHaveBeenCalled();
    expect(existsSync(workDirs[0])).toBe(false);
  });

  it('fails with unsupported_input when the audio file has no audio stream', async () => {
    const ffmpeg = stubFfmpeg({ probes: { audio: probeOutput(['  Stream #0:0: Video: png']) } });
    const { deps, jobOf, runToCompletion, repository } = setup({ ffmpeg });
    const job = jobOf(await create(deps));
    await runToCompletion();
    expect(repository.jobs.get(job.id)).toMatchObject({ state: 'failed', error: { code: 'unsupported_input' } });
  });

  it('fails with unsupported_input when ffmpeg exits non-zero, carrying its stderr', async () => {
    const { deps, jobOf, runToCompletion, repository } = setup({ ffmpeg: stubFfmpeg({ renderExitCode: 1 }) });
    const job = jobOf(await create(deps));
    await runToCompletion();
    expect(repository.jobs.get(job.id)).toMatchObject({
      state: 'failed',
      error: { code: 'unsupported_input', message: expect.stringContaining('Could not write header') },
    });
  });

  it('fails when an input was deleted between create and render', async () => {
    const { deps, jobOf, runToCompletion, repository } = setup();
    const job = jobOf(await create(deps));
    vi.mocked(deps.loadInputFile).mockResolvedValueOnce(null);
    await runToCompletion();
    expect(repository.jobs.get(job.id)).toMatchObject({ state: 'failed', error: { code: 'unsupported_input' } });
    expect(deps.downloadInputFile).not.toHaveBeenCalled();
  });

  it('retries an infrastructure failure and succeeds on the next attempt', async () => {
    const { deps, jobOf, runToCompletion, repository } = setup();
    const job = jobOf(await create(deps));
    vi.mocked(deps.downloadInputFile).mockRejectedValueOnce(new Error('socket hang up'));
    await runToCompletion();
    expect(repository.jobs.get(job.id)).toMatchObject({ state: 'succeeded', settledCredits: 0 });
    expect(deps.saveToFiles).toHaveBeenCalledTimes(1);
  });

  it('never renders for a blocked account', async () => {
    const { deps, ffmpeg, jobOf, runToCompletion, repository } = setup({ denial: 'Account suspended' });
    const job = jobOf(await create(deps));
    await runToCompletion();
    expect(repository.jobs.get(job.id)).toMatchObject({
      state: 'failed',
      error: { code: 'account_blocked' },
      settledCredits: 0,
    });
    expect(ffmpeg.runner.run).not.toHaveBeenCalled();
    expect(releaseCreditHold).not.toHaveBeenCalled();
  });
});
