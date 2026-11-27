import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  CreditHolderType,
  StudioTimelineSchema,
  usdToCreditsStochastic,
  type StudioRenderStatus,
  type StudioTimelineInput,
} from '@bike4mind/common';
import { Logger } from '@bike4mind/observability';
import type { CreditHoldAdapters } from '../creditService/creditHold';
import { MAX_RENDER_OUTPUT_BYTES, RENDER_MODEL_ID, createRenderJobHandler } from './renderJobHandler';
import type { RenderJob, RenderJobDeps } from './types';

// The real stochastic rounding with its draw pinned, so a settlement is deterministic.
vi.mock('@bike4mind/common', async importOriginal => {
  const actual = await importOriginal<typeof import('@bike4mind/common')>();
  return { ...actual, usdToCreditsStochastic: (usd: number) => actual.usdToCreditsStochastic(usd, () => 0.5) };
});

vi.mock('../creditService/creditHold', () => ({
  holdCredits: vi.fn(),
  releaseCreditHold: vi.fn(async () => undefined),
  settleCreditHold: vi.fn(async (_hold: unknown, charged: number) => charged),
}));
import { releaseCreditHold, settleCreditHold } from '../creditService/creditHold';

const FILE_A = 'a'.repeat(24);
const FILE_B = 'b'.repeat(24);
const FILE_D = 'd'.repeat(24);
const JOB_ID = 'e'.repeat(24);

// FILE_A appears on two tracks (listed once); the captions track and the disabled track add nothing.
const timeline = StudioTimelineSchema.parse({
  version: 1,
  durationMs: 10_000,
  fps: 30,
  outputs: [{ id: 'out-wide', aspectRatio: '16:9', width: 1920, height: 1080 }],
  tracks: [
    {
      id: 'video-1',
      kind: 'video',
      clips: [
        { id: 'v1', fileId: FILE_A, startMs: 0, durationMs: 4000 },
        { id: 'v2', fileId: FILE_B, startMs: 4000, durationMs: 4000 },
      ],
    },
    { id: 'music-1', kind: 'music', clips: [{ id: 'm1', fileId: FILE_A, startMs: 0, durationMs: 8000 }] },
    {
      id: 'sfx-off',
      kind: 'sfx',
      enabled: false,
      clips: [{ id: 's1', fileId: FILE_D, startMs: 0, durationMs: 1000 }],
    },
    { id: 'captions-1', kind: 'captions', clips: [{ id: 'c1', text: 'Hello', startMs: 0, durationMs: 2000 }] },
  ],
} satisfies StudioTimelineInput);

const hold = {
  ownerId: 'u1',
  ownerType: CreditHolderType.User,
  userId: 'u1',
  organizationId: null,
  reservedCredits: 20,
  balanceAfterHold: 100,
};

const makeJob = (overrides: Partial<RenderJob> = {}): RenderJob => ({
  id: JOB_ID,
  kind: 'render',
  ownerType: CreditHolderType.User,
  ownerId: 'u1',
  requestedBy: 'u1',
  source: 'studio',
  state: 'pending',
  pollCount: 0,
  attempts: 0,
  cancelRequested: false,
  deadlineAt: new Date('2026-11-17T01:00:00Z'),
  creditHold: hold,
  payload: {
    request: { compositionId: 'f'.repeat(24), title: 'Spring ad', output: timeline.outputs[0], timeline },
    pricing: { usdPerOutputSecond: 0.01, billedSeconds: 10, usd: 0.1 },
    groupId: '1'.repeat(24),
    groupSize: 1,
  },
  ...overrides,
});

const makeDeps = (overrides: Partial<RenderJobDeps> = {}): RenderJobDeps => ({
  repository: { recordSettlement: vi.fn(async () => undefined) } as unknown as RenderJobDeps['repository'],
  credits: {} as CreditHoldAdapters,
  dispatchRender: vi.fn(async () => undefined),
  readRenderStatus: vi.fn(async () => null),
  fetchRenderedOutput: vi.fn(async () => Buffer.from('mp4-bytes')),
  saveToFiles: vi.fn(async ({ generation: { jobId } }) => ({
    saved: true as const,
    fileId: `file-${jobId}`,
    s3Key: `files/${jobId}.mp4`,
    fileName: 'render.mp4',
  })),
  saveToGeneratedBucket: vi.fn(async ({ key }) => ({ s3Key: key })),
  now: () => new Date('2026-11-17T00:00:00Z'),
  logger: new Logger({ metadata: { test: 'renderJobHandler' } }),
  ...overrides,
});

const at = '2026-11-17T00:00:00Z';
const context = () => ({ signal: new AbortController().signal });

describe('createRenderJobHandler', () => {
  beforeEach(() => vi.clearAllMocks());

  it('is an async handler for the render kind', () => {
    expect(createRenderJobHandler(makeDeps())).toMatchObject({ kind: 'render', submitMode: 'async' });
  });

  describe('submit', () => {
    it('dispatches the job id and reports it running with its payload unchanged', async () => {
      const deps = makeDeps();
      const job = makeJob();
      expect(await createRenderJobHandler(deps).submit(job, context())).toEqual({
        next: 'running',
        payload: job.payload,
      });
      expect(deps.dispatchRender).toHaveBeenCalledWith(JOB_ID);
    });

    it('retries with the reason when the dispatch throws', async () => {
      const deps = makeDeps({ dispatchRender: vi.fn(async () => Promise.reject(new Error('SQS down'))) });
      expect(await createRenderJobHandler(deps).submit(makeJob(), context())).toEqual({
        next: 'retry',
        reason: 'SQS down',
      });
    });
  });

  describe('poll', () => {
    const pollWith = (status: StudioRenderStatus | null) =>
      createRenderJobHandler(makeDeps({ readRenderStatus: vi.fn(async () => status) })).poll(
        makeJob({ state: 'running' }),
        context()
      );

    it('polls again at zero progress while the worker has not reported', async () => {
      expect(await pollWith(null)).toEqual({ next: 'poll_again', progress: 0 });
    });

    it('polls again with the worker progress while it runs', async () => {
      expect(await pollWith({ state: 'running', progress: 0.4, updatedAt: at })).toEqual({
        next: 'poll_again',
        progress: 0.4,
      });
    });

    it('fails with provider_error carrying the worker message', async () => {
      expect(await pollWith({ state: 'failed', message: 'ffmpeg exited 1', updatedAt: at })).toEqual({
        next: 'failed',
        error: { code: 'provider_error', message: 'ffmpeg exited 1' },
      });
    });

    it('fails with output_too_large when the encode exceeds what the store step can buffer', async () => {
      const result = await pollWith({
        state: 'succeeded',
        s3Key: 'studio-render/x/output.mp4',
        bytes: MAX_RENDER_OUTPUT_BYTES + 1,
        durationSeconds: 10,
        updatedAt: at,
      });
      expect(result).toMatchObject({ next: 'failed', error: { code: 'output_too_large' } });
    });

    it('moves a success to storing with the rendered output on the payload', async () => {
      const job = makeJob({ state: 'running' });
      const handler = createRenderJobHandler(
        makeDeps({
          readRenderStatus: vi.fn(async () => ({
            state: 'succeeded' as const,
            s3Key: 'studio-render/x/output.mp4',
            bytes: MAX_RENDER_OUTPUT_BYTES,
            durationSeconds: 9.5,
            updatedAt: at,
          })),
        })
      );
      expect(await handler.poll(job, context())).toEqual({
        next: 'storing',
        payload: {
          ...job.payload,
          rendered: { s3Key: 'studio-render/x/output.mp4', bytes: MAX_RENDER_OUTPUT_BYTES, durationSeconds: 9.5 },
        },
      });
    });
  });

  describe('store', () => {
    const storingJob = () =>
      makeJob({
        state: 'storing',
        payload: {
          ...makeJob().payload,
          rendered: { s3Key: 'studio-render/x/output.mp4', bytes: 9, durationSeconds: 9.5 },
        },
      });

    it('fetches the encode then saves it to Files with the unique enabled media clips as lineage', async () => {
      const deps = makeDeps();
      const signal = new AbortController().signal;
      const result = await createRenderJobHandler(deps).store(storingJob(), { signal });

      expect(deps.fetchRenderedOutput).toHaveBeenCalledWith('studio-render/x/output.mp4', signal);
      expect(deps.saveToFiles).toHaveBeenCalledTimes(1);
      const saved = vi.mocked(deps.saveToFiles).mock.calls[0][0];
      expect(saved).toMatchObject({
        userId: 'u1',
        contentType: 'video/mp4',
        derivedFrom: [
          { fileId: FILE_A, role: 'timeline_clip' },
          { fileId: FILE_B, role: 'timeline_clip' },
        ],
        generation: {
          generator: 'video',
          provider: 'studio-render',
          modelId: RENDER_MODEL_ID,
          jobId: JOB_ID,
          prompt: 'Spring ad (16:9, 1920x1080)',
          durationSeconds: 9.5,
          request: { compositionId: 'f'.repeat(24), output: timeline.outputs[0] },
        },
      });
      expect(saved.bytes.toString()).toBe('mp4-bytes');
      expect(saved.derivedFrom?.map(entry => entry.fileId)).not.toContain(FILE_D);
      expect(result).toMatchObject({
        next: 'succeeded',
        payload: {
          output: {
            location: 'files',
            fileId: `file-${JOB_ID}`,
            contentType: 'video/mp4',
            bytes: 'mp4-bytes'.length,
            durationSeconds: 9.5,
          },
        },
      });
    });

    it('rethrows a rejecting Files save so the step retries instead of falling back', async () => {
      const saveError = new Error('dedup lookup failed');
      const deps = makeDeps({ saveToFiles: vi.fn(async () => Promise.reject(saveError)) });
      await expect(createRenderJobHandler(deps).store(storingJob(), context())).rejects.toBe(saveError);
      expect(deps.saveToGeneratedBucket).not.toHaveBeenCalled();
    });

    it('keeps the encode in the generated bucket when Files refuses it', async () => {
      const deps = makeDeps({
        saveToFiles: vi.fn(async () => ({ saved: false as const, reason: 'quota' })),
      });
      const result = await createRenderJobHandler(deps).store(storingJob(), context());
      expect(result).toMatchObject({
        next: 'succeeded',
        payload: { output: { location: 'generated', s3Key: `studio-render/u1/${JOB_ID}.mp4` } },
      });
    });

    it('fails a job that reaches storing without a rendered output', async () => {
      const deps = makeDeps();
      expect(await createRenderJobHandler(deps).store(makeJob({ state: 'storing' }), context())).toMatchObject({
        next: 'failed',
        error: { code: 'provider_error' },
      });
      expect(deps.fetchRenderedOutput).not.toHaveBeenCalled();
    });
  });

  describe('onTerminal', () => {
    it('settles a success against its price snapshot as a studio-render video usage entry', async () => {
      const deps = makeDeps();
      const job = makeJob({ state: 'succeeded' });
      await createRenderJobHandler(deps).onTerminal(job);

      expect(settleCreditHold).toHaveBeenCalledWith(
        hold,
        usdToCreditsStochastic(0.1),
        { type: 'video_generation_usage', sessionId: JOB_ID, questId: JOB_ID, model: 'studio-render' },
        expect.objectContaining({ featureLabel: 'studio render' }),
        deps.credits
      );
      expect(releaseCreditHold).not.toHaveBeenCalled();
      expect(deps.repository.recordSettlement).toHaveBeenCalledWith(JOB_ID, usdToCreditsStochastic(0.1));
    });

    it('keeps the full reservation (NaN credits) when the snapshot price is not finite', async () => {
      const deps = makeDeps();
      const job = makeJob({ state: 'succeeded' });
      job.payload.pricing.usd = Number.NaN;
      await createRenderJobHandler(deps).onTerminal(job);
      expect(vi.mocked(settleCreditHold).mock.calls[0][1]).toBeNaN();
    });

    it.each(['failed', 'cancelled', 'blocked'] as const)('returns the hold of a %s job', async state => {
      const deps = makeDeps();
      await createRenderJobHandler(deps).onTerminal(makeJob({ state }));
      expect(releaseCreditHold).toHaveBeenCalledWith(hold, deps.credits);
      expect(settleCreditHold).not.toHaveBeenCalled();
      expect(deps.repository.recordSettlement).toHaveBeenCalledWith(JOB_ID, 0);
    });
  });
});
