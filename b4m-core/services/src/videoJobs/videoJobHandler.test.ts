import { beforeEach, describe, expect, it, vi } from 'vitest';
import { CreditHolderType, MAX_INLINE_PROVIDER_OUTPUT_BYTES } from '@bike4mind/common';
import {
  createVideoProviderRegistry,
  ProviderSubmitError,
  TestVideoProvider,
  VideoOutputTooLargeError,
  type VideoProvider,
} from '@bike4mind/utils/videoProviders';
import { Logger } from '@bike4mind/observability';
import { createInMemoryGenerationJobRepository } from '../generationJobs/__test__/inMemoryGenerationJobRepository';
import { GenerationJobEngine } from '../generationJobs/engine';
import { MAX_STEP_ATTEMPTS } from '../generationJobs/backoff';
import type { CreditHoldAdapters } from '../creditService/creditHold';
import { EXPIRED_KEY_SENTINEL } from '../modelDiscoveryService/credentials';
import { createVideoJob } from './createVideoJob';
import { createVideoJobHandler } from './videoJobHandler';
import type { CreateVideoJobDeps, CreateVideoJobResult, VideoJobDeps } from './types';

vi.mock('../creditService/creditHold', () => ({
  holdCredits: vi.fn(),
  releaseCreditHold: vi.fn(async () => undefined),
  settleCreditHold: vi.fn(async (_hold: unknown, charged: number) => charged),
}));
import { holdCredits, releaseCreditHold, settleCreditHold } from '../creditService/creditHold';

// creditHold is module-mocked, so the adapters are never touched.
const unusedCredits = {} as CreditHoldAdapters;

const setup = (overrides: Partial<VideoJobDeps> = {}) => {
  let clock = new Date('2026-10-06T00:00:00Z');
  const repository = createInMemoryGenerationJobRepository({ now: () => clock });
  const queue: string[] = [];
  const deps: CreateVideoJobDeps = {
    repository,
    providers: createVideoProviderRegistry([new TestVideoProvider()]),
    getSettings: async () => ({ enforceCredits: true, videoGeneration: undefined }),
    resolveApiKey: async () => 'key',
    loadInputImage: async () => ({ bytes: Buffer.from('img'), mimeType: 'image/png' }),
    saveToFiles: vi.fn(async ({ jobId }: { jobId: string }) => ({
      saved: true as const,
      fileId: `file-${jobId}`,
      s3Key: `files/${jobId}.mp4`,
    })),
    saveToGeneratedBucket: vi.fn(async ({ key }: { key: string }) => ({ s3Key: key })),
    credits: unusedCredits,
    enqueue: vi.fn(async (jobId: string) => {
      queue.push(jobId);
    }),
    recordUsage: vi.fn(async () => undefined),
    now: () => clock,
    logger: new Logger({ metadata: { test: 'videoJobHandler' } }),
    engine: { failBeforeStart: (jobId, error) => engine.failBeforeStart(jobId, error) },
    ...overrides,
  };
  const engine = new GenerationJobEngine({
    repository,
    handlers: [createVideoJobHandler(deps)],
    enqueue: deps.enqueue,
    notify: async () => undefined,
    now: () => clock,
    logger: deps.logger,
    leaseMs: 330_000,
  });
  // Drain the queue, advancing the clock past each delay, until the job is terminal.
  const runToCompletion = async () => {
    for (let i = 0; i < 20 && queue.length; i++) {
      const jobId = queue.shift();
      if (!jobId) break;
      clock = new Date(clock.getTime() + 60_000);
      await engine.step(jobId);
    }
  };
  const jobOf = (created: CreateVideoJobResult) => {
    if (!created.ok) throw new Error(`createVideoJob refused: ${created.code}`);
    const job = repository.jobs.get(created.job.id);
    if (!job) throw new Error('job vanished');
    return job;
  };
  const advance = (ms: number) => {
    clock = new Date(clock.getTime() + ms);
  };
  return { deps, repository, engine, runToCompletion, jobOf, advance };
};

const request = (prompt = 'a cat') => ({
  model: 'test-video',
  mode: 'text_to_video',
  prompt,
  durationSeconds: 4,
  aspectRatio: '16:9',
  resolution: '720p',
});
const user = { id: 'u1', organizationId: null };

// A TestVideoProvider whose methods a test can override, for outcomes the prompt markers cannot express.
const stubProvider = (overrides: Partial<VideoProvider>): VideoProvider => {
  const base = new TestVideoProvider();
  return {
    id: base.id,
    submit: overrides.submit ?? base.submit.bind(base),
    poll: overrides.poll ?? base.poll.bind(base),
    fetchOutput: overrides.fetchOutput ?? base.fetchOutput.bind(base),
    cancel: overrides.cancel ?? base.cancel.bind(base),
  };
};

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(holdCredits).mockImplementation(async params => ({
    ownerId: params.userId,
    ownerType: CreditHolderType.User,
    userId: params.userId,
    organizationId: null,
    reservedCredits: params.requiredCredits,
    balanceAfterHold: 1000,
  }));
});

describe('video job end to end with the test provider', () => {
  it('stores the clip in Files, settles credits once and records usage', async () => {
    const t = setup();
    const created = await createVideoJob({ user, request: request(), source: 'studio' }, t.deps);
    await t.runToCompletion();
    const job = t.jobOf(created);
    expect(job.state).toBe('succeeded');
    expect(job.payload.output).toMatchObject({
      location: 'files',
      fileId: expect.any(String),
      contentType: 'video/mp4',
    });
    expect(job.payload.providerOutput).toBeUndefined();
    expect(settleCreditHold).toHaveBeenCalledTimes(1);
    expect(t.deps.recordUsage).toHaveBeenCalledTimes(1);
    expect(releaseCreditHold).not.toHaveBeenCalled();
  });

  it('settles on the reported duration with a quest-scoped video ledger entry and marks the job settled', async () => {
    const t = setup();
    const created = await createVideoJob({ user, request: request(), source: 'studio' }, t.deps);
    await t.runToCompletion();
    const job = t.jobOf(created);
    const hold = job.creditHold;
    if (!hold) throw new Error('expected a hold');
    // test-video: 4s at $0.01/s.
    const [, charged, entry] = vi.mocked(settleCreditHold).mock.calls[0];
    expect(charged).toBe(hold.reservedCredits);
    expect(entry).toEqual({
      type: 'video_generation_usage',
      sessionId: job.id,
      questId: job.id,
      model: 'test-video',
    });
    expect(job.settledCredits).toBe(charged);
    expect(t.deps.recordUsage).toHaveBeenCalledWith(
      expect.objectContaining({ creditsCharged: charged, costUsd: 0.04, durationSeconds: 4 })
    );
  });

  it('settles on the provider-reported duration when it differs from the request', async () => {
    const base = new TestVideoProvider();
    const t = setup({
      providers: createVideoProviderRegistry([
        stubProvider({
          poll: async (handle, ctx) => {
            const result = await base.poll(handle, ctx);
            return result.status === 'succeeded' ? { ...result, reportedDurationSeconds: 2 } : result;
          },
        }),
      ]),
    });
    const created = await createVideoJob({ user, request: request(), source: 'studio', questId: 'q1' }, t.deps);
    await t.runToCompletion();
    const job = t.jobOf(created);
    const [, charged, entry] = vi.mocked(settleCreditHold).mock.calls[0];
    expect(charged).toBeLessThan(job.creditHold?.reservedCredits ?? 0);
    expect(entry).toMatchObject({ sessionId: 'q1', questId: 'q1' });
    expect(t.deps.recordUsage).toHaveBeenCalledWith(expect.objectContaining({ durationSeconds: 2 }));
  });

  it('bills a reported duration the model does not offer on the requested duration', async () => {
    const base = new TestVideoProvider();
    const t = setup({
      providers: createVideoProviderRegistry([
        stubProvider({
          poll: async (handle, ctx) => {
            const result = await base.poll(handle, ctx);
            return result.status === 'succeeded' ? { ...result, reportedDurationSeconds: 8.04 } : result;
          },
        }),
      ]),
    });
    const created = await createVideoJob({ user, request: request(), source: 'studio' }, t.deps);
    await t.runToCompletion();
    const job = t.jobOf(created);
    const [, charged] = vi.mocked(settleCreditHold).mock.calls[0];
    expect(charged).toBe(job.creditHold?.reservedCredits);
    expect(t.deps.recordUsage).toHaveBeenCalledWith(expect.objectContaining({ costUsd: 0.04, durationSeconds: 4 }));
  });

  it('keeps the full reservation and still finishes terminal handling when the price lookup throws', async () => {
    const t = setup();
    const error = vi.spyOn(t.deps.logger, 'error');
    const created = await createVideoJob({ user, request: request(), source: 'studio' }, t.deps);
    const job = t.jobOf(created);
    await t.engine.step(job.id); // submit -> running
    // A catalog change after submit: the stored resolution no longer has a price.
    t.repository.jobs.get(job.id)!.payload.request.resolution = '1080p';
    await t.runToCompletion();
    const settled = t.jobOf(created);
    expect(settled).toMatchObject({ state: 'succeeded' });
    expect(settled.terminalHandledAt).toBeTruthy();
    expect(vi.mocked(settleCreditHold).mock.calls[0][1]).toBeNaN();
    expect(error).toHaveBeenCalledWith('video_job_estimate_failed', expect.objectContaining({ jobId: job.id }));
    expect(t.deps.recordUsage).not.toHaveBeenCalled();
  });

  it('keeps the full reservation when the model left the catalog before settlement', async () => {
    const t = setup();
    const error = vi.spyOn(t.deps.logger, 'error');
    const created = await createVideoJob({ user, request: request(), source: 'studio' }, t.deps);
    const job = t.jobOf(created);
    await t.engine.step(job.id); // submit -> running
    // A catalog change after submit: the model itself was removed.
    const stored = t.repository.jobs.get(job.id)!;
    stored.payload.reportedDurationSeconds = 4;
    stored.payload.request.model = 'removed-video-model' as typeof stored.payload.request.model;
    await t.runToCompletion();
    const settled = t.jobOf(created);
    expect(settled).toMatchObject({ state: 'succeeded' });
    expect(settled.terminalHandledAt).toBeTruthy();
    expect(vi.mocked(settleCreditHold).mock.calls[0][1]).toBeNaN();
    expect(error).toHaveBeenCalledWith('video_job_estimate_failed', expect.objectContaining({ jobId: job.id }));
  });

  it('falls back to the generated bucket when Files refuses', async () => {
    const t = setup({ saveToFiles: vi.fn(async () => ({ saved: false as const, reason: 'storage_limit' as const })) });
    const created = await createVideoJob({ user, request: request(), source: 'studio' }, t.deps);
    await t.runToCompletion();
    const job = t.jobOf(created);
    expect(job.state).toBe('succeeded');
    expect(job.payload.output).toMatchObject({ location: 'generated', s3Key: `generated-video/u1/${job.id}.mp4` });
    expect(job.payload.output?.fileId).toBeUndefined();
    expect(settleCreditHold).toHaveBeenCalledTimes(1);
  });

  it.each([
    ['video/webm', 'webm'],
    ['application/octet-stream', 'bin'],
  ])('names a generated-bucket %s clip with the .%s extension', async (contentType, extension) => {
    const t = setup({ saveToFiles: vi.fn(async () => ({ saved: false as const, reason: 'storage_limit' as const })) });
    const created = await createVideoJob({ user, request: request(), source: 'studio' }, t.deps);
    const pending = t.jobOf(created);
    const storing = {
      ...pending,
      state: 'storing' as const,
      payload: {
        ...pending.payload,
        providerOutput: { kind: 'inline' as const, base64: Buffer.from('clip').toString('base64'), contentType },
      },
    };
    const result = await createVideoJobHandler(t.deps).store(storing, { signal: new AbortController().signal });
    expect(result).toMatchObject({
      next: 'succeeded',
      payload: { output: { location: 'generated', s3Key: `generated-video/u1/${pending.id}.${extension}` } },
    });
  });

  it('passes the input image to the provider for image_to_video', async () => {
    const base = new TestVideoProvider();
    const submit = vi.fn<VideoProvider['submit']>((req, inputs, ctx) => base.submit(req, inputs, ctx));
    const t = setup({ providers: createVideoProviderRegistry([stubProvider({ submit })]) });
    const created = await createVideoJob(
      { user, request: { ...request(), mode: 'image_to_video', inputImageFileId: 'f1' }, source: 'studio' },
      t.deps
    );
    await t.runToCompletion();
    expect(t.jobOf(created).state).toBe('succeeded');
    expect(submit).toHaveBeenCalledWith(
      expect.objectContaining({ inputImageFileId: 'f1' }),
      { inputImage: { bytes: Buffer.from('img'), mimeType: 'image/png' } },
      expect.objectContaining({ apiKey: 'key' })
    );
  });

  it('fails with input_image_not_found when the image disappears before submit', async () => {
    const loadInputImage = vi
      .fn<VideoJobDeps['loadInputImage']>()
      .mockResolvedValueOnce({ bytes: Buffer.from('img'), mimeType: 'image/png' })
      .mockResolvedValue(null);
    const t = setup({ loadInputImage });
    const created = await createVideoJob(
      { user, request: { ...request(), mode: 'image_to_video', inputImageFileId: 'f1' }, source: 'studio' },
      t.deps
    );
    await t.runToCompletion();
    expect(t.jobOf(created)).toMatchObject({ state: 'failed', error: { code: 'input_image_not_found' } });
    expect(releaseCreditHold).toHaveBeenCalledTimes(1);
  });

  it('a policy block releases the hold and charges nothing', async () => {
    const t = setup();
    const created = await createVideoJob({ user, request: request('a cat [blocked]'), source: 'studio' }, t.deps);
    await t.runToCompletion();
    const job = t.jobOf(created);
    expect(job).toMatchObject({ state: 'blocked', error: { code: 'content_blocked' }, settledCredits: 0 });
    expect(releaseCreditHold).toHaveBeenCalledTimes(1);
    expect(settleCreditHold).not.toHaveBeenCalled();
    expect(t.deps.recordUsage).not.toHaveBeenCalled();
  });

  it('a provider failure releases the hold', async () => {
    const t = setup();
    const created = await createVideoJob({ user, request: request('a cat [fail]'), source: 'studio' }, t.deps);
    await t.runToCompletion();
    expect(t.jobOf(created).error?.code).toBe('provider_error');
    expect(releaseCreditHold).toHaveBeenCalledTimes(1);
  });

  it('a definitive submit rejection retries, then fails as provider_error and releases the whole hold', async () => {
    const t = setup();
    const created = await createVideoJob({ user, request: request('a cat [reject]'), source: 'studio' }, t.deps);
    await t.runToCompletion();
    const job = t.jobOf(created);
    expect(job).toMatchObject({
      state: 'failed',
      attempts: MAX_STEP_ATTEMPTS - 1,
      error: { code: 'provider_error', message: 'test provider rejected the prompt' },
    });
    expect(job.payload.output).toBeUndefined();
    expect(t.deps.saveToFiles).not.toHaveBeenCalled();
    expect(releaseCreditHold).toHaveBeenCalledTimes(1);
    expect(releaseCreditHold).toHaveBeenCalledWith(job.creditHold, t.deps.credits);
    expect(settleCreditHold).not.toHaveBeenCalled();
  });

  it('a non-definitive submit error is an unknown outcome: orphaned_submit', async () => {
    const t = setup({
      providers: createVideoProviderRegistry([
        stubProvider({
          submit: async () => {
            throw new ProviderSubmitError('socket reset', false);
          },
        }),
      ]),
    });
    const created = await createVideoJob({ user, request: request(), source: 'studio' }, t.deps);
    await t.runToCompletion();
    expect(t.jobOf(created)).toMatchObject({ state: 'failed', error: { code: 'orphaned_submit' } });
    expect(releaseCreditHold).toHaveBeenCalledTimes(1);
  });

  it('retries a failure before the provider call instead of failing it as orphaned_submit', async () => {
    const submit = vi.fn<VideoProvider['submit']>();
    const t = setup({
      providers: createVideoProviderRegistry([stubProvider({ submit })]),
      resolveApiKey: async () => {
        throw new Error('secrets store unavailable');
      },
    });
    const created = await createVideoJob({ user, request: request(), source: 'studio' }, t.deps);
    await t.runToCompletion();
    expect(t.jobOf(created)).toMatchObject({
      state: 'failed',
      attempts: MAX_STEP_ATTEMPTS - 1,
      error: { code: 'provider_error' },
    });
    expect(submit).not.toHaveBeenCalled();
    expect(releaseCreditHold).toHaveBeenCalledTimes(1);
  });

  it.each([
    [1.7, 1],
    [-0.5, 0],
    [0.25, 0.25],
  ])('clamps a reported progress of %s to %s', async (reported, expected) => {
    const t = setup({
      providers: createVideoProviderRegistry([
        stubProvider({ poll: async () => ({ status: 'running', progress: reported }) }),
      ]),
    });
    const created = await createVideoJob({ user, request: request(), source: 'studio' }, t.deps);
    const job = t.jobOf(created);
    await t.engine.step(job.id); // submit -> running
    const running = t.repository.jobs.get(job.id)!;
    const result = await createVideoJobHandler(t.deps).poll(running, { signal: new AbortController().signal });
    expect(result).toEqual({ next: 'poll_again', progress: expected });
  });

  it('a retryable poll failure polls again and then succeeds', async () => {
    const base = new TestVideoProvider();
    const poll = vi
      .fn<VideoProvider['poll']>()
      .mockResolvedValueOnce({ status: 'failed', retryable: true, message: 'busy', raw: null })
      .mockImplementation((handle, ctx) => base.poll(handle, ctx));
    const t = setup({ providers: createVideoProviderRegistry([stubProvider({ poll })]) });
    const created = await createVideoJob({ user, request: request(), source: 'studio' }, t.deps);
    await t.runToCompletion();
    expect(t.jobOf(created).state).toBe('succeeded');
    expect(poll).toHaveBeenCalledTimes(2);
  });

  it('refuses to persist an inline output over the limit', async () => {
    const tooBig = 'A'.repeat(Math.ceil(((MAX_INLINE_PROVIDER_OUTPUT_BYTES + 1) * 4) / 3) + 4);
    const t = setup({
      providers: createVideoProviderRegistry([
        stubProvider({
          poll: async () => ({
            status: 'succeeded',
            output: { kind: 'inline', base64: tooBig, contentType: 'video/mp4' },
          }),
        }),
      ]),
    });
    const created = await createVideoJob({ user, request: request(), source: 'studio' }, t.deps);
    await t.runToCompletion();
    const job = t.jobOf(created);
    expect(job).toMatchObject({ state: 'failed', error: { code: 'output_too_large' } });
    expect(job.payload.providerOutput).toBeUndefined();
    expect(releaseCreditHold).toHaveBeenCalledTimes(1);
  });

  it('fails with output_too_large when the fetched output exceeds the cap', async () => {
    const t = setup({
      providers: createVideoProviderRegistry([
        stubProvider({
          fetchOutput: async () => {
            throw new VideoOutputTooLargeError(300 * 1024 * 1024);
          },
        }),
      ]),
    });
    const created = await createVideoJob({ user, request: request(), source: 'studio' }, t.deps);
    await t.runToCompletion();
    expect(t.jobOf(created)).toMatchObject({ state: 'failed', error: { code: 'output_too_large' } });
    expect(t.deps.saveToFiles).not.toHaveBeenCalled();
  });

  it('fails cleanly when no API key resolves for the provider', async () => {
    const t = setup({ resolveApiKey: async () => null });
    const created = await createVideoJob({ user, request: request(), source: 'studio' }, t.deps);
    await t.runToCompletion();
    expect(t.jobOf(created)).toMatchObject({
      state: 'failed',
      error: { code: 'provider_error', message: 'No API key configured for test' },
    });
  });

  it('treats the expired-key sentinel as a missing key and never calls the provider', async () => {
    const submit = vi.fn<VideoProvider['submit']>();
    const t = setup({
      resolveApiKey: async () => EXPIRED_KEY_SENTINEL,
      providers: createVideoProviderRegistry([stubProvider({ submit })]),
    });
    const created = await createVideoJob({ user, request: request(), source: 'studio' }, t.deps);
    await t.runToCompletion();
    expect(t.jobOf(created)).toMatchObject({
      state: 'failed',
      error: { code: 'provider_error', message: 'No API key configured for test' },
    });
    expect(submit).not.toHaveBeenCalled();
  });

  it('does not poll with a key that expired after submit', async () => {
    const poll = vi.fn<VideoProvider['poll']>();
    const resolveApiKey = vi
      .fn<VideoJobDeps['resolveApiKey']>()
      .mockResolvedValueOnce('key')
      .mockResolvedValue(EXPIRED_KEY_SENTINEL);
    const t = setup({ resolveApiKey, providers: createVideoProviderRegistry([stubProvider({ poll })]) });
    const created = await createVideoJob({ user, request: request(), source: 'studio' }, t.deps);
    await t.runToCompletion();
    expect(t.jobOf(created)).toMatchObject({ state: 'failed', error: { code: 'provider_error' } });
    expect(poll).not.toHaveBeenCalled();
  });

  it('warns instead of cancelling at the provider when no usable key resolves', async () => {
    const cancel = vi.fn<NonNullable<VideoProvider['cancel']>>(async () => undefined);
    const resolveApiKey = vi
      .fn<VideoJobDeps['resolveApiKey']>()
      .mockResolvedValueOnce('key')
      .mockResolvedValue(EXPIRED_KEY_SENTINEL);
    const t = setup({ resolveApiKey, providers: createVideoProviderRegistry([stubProvider({ cancel })]) });
    const warn = vi.spyOn(t.deps.logger, 'warn');
    const created = await createVideoJob({ user, request: request(), source: 'studio' }, t.deps);
    if (!created.ok) throw new Error('expected creation to succeed');
    await t.engine.step(created.job.id); // submit -> running
    await t.engine.requestCancel(created.job.id);
    await t.runToCompletion();
    expect(t.jobOf(created).state).toBe('cancelled');
    expect(cancel).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalledWith('video_job_cancel_no_key', { jobId: created.job.id, providerId: 'test' });
  });

  it('an aborted step signal fails the provider call like a transport error: the step retries', async () => {
    const t = setup();
    const created = await createVideoJob({ user, request: request(), source: 'studio' }, t.deps);
    if (!created.ok) throw new Error('expected creation to succeed');
    await t.engine.step(created.job.id); // submit -> running
    const handler = createVideoJobHandler(t.deps);
    const aborted = new GenerationJobEngine({
      repository: t.repository,
      handlers: [{ ...handler, poll: job => handler.poll(job, { signal: AbortSignal.abort() }) }],
      enqueue: t.deps.enqueue,
      notify: async () => undefined,
      now: t.deps.now,
      logger: t.deps.logger,
      leaseMs: 330_000,
    });
    t.advance(60_000);
    expect(await aborted.step(created.job.id)).toBe('advanced');
    expect(t.jobOf(created)).toMatchObject({ state: 'running', attempts: 1 });
  });

  it('cancels at the provider when a running job is cancelled', async () => {
    const cancel = vi.fn<NonNullable<VideoProvider['cancel']>>(async () => undefined);
    const t = setup({ providers: createVideoProviderRegistry([stubProvider({ cancel })]) });
    const created = await createVideoJob({ user, request: request(), source: 'studio' }, t.deps);
    if (!created.ok) throw new Error('expected creation to succeed');
    await t.engine.step(created.job.id); // submit -> running
    await t.engine.requestCancel(created.job.id);
    await t.runToCompletion();
    expect(t.jobOf(created)).toMatchObject({ state: 'cancelled', settledCredits: 0 });
    expect(cancel).toHaveBeenCalledWith(expect.objectContaining({ provider: 'test' }), expect.anything());
    expect(releaseCreditHold).toHaveBeenCalledTimes(1);
  });

  it('without a hold, records usage on success and charges nothing', async () => {
    const t = setup({ getSettings: async () => ({ enforceCredits: false, videoGeneration: undefined }) });
    const created = await createVideoJob({ user, request: request(), source: 'studio' }, t.deps);
    await t.runToCompletion();
    expect(t.jobOf(created)).toMatchObject({ state: 'succeeded', creditHold: null, settledCredits: 0 });
    expect(settleCreditHold).not.toHaveBeenCalled();
    expect(t.deps.recordUsage).toHaveBeenCalledWith(expect.objectContaining({ creditsCharged: 0 }));
  });

  it('store may run twice for one job: both runs save under the same job id, which saveToFiles dedups', async () => {
    const t = setup();
    const created = await createVideoJob({ user, request: request(), source: 'studio' }, t.deps);
    const pending = t.jobOf(created);
    // The provider finished, but no output was ever committed: every store run must fetch and save.
    const storing = structuredClone({
      ...pending,
      state: 'storing' as const,
      payload: {
        ...pending.payload,
        providerOutput: {
          kind: 'inline' as const,
          base64: Buffer.from('clip').toString('base64'),
          contentType: 'video/mp4',
        },
      },
    });
    const handler = createVideoJobHandler(t.deps);
    const context = { signal: new AbortController().signal };
    const first = await handler.store(structuredClone(storing), context);
    const rerun = await handler.store(structuredClone(storing), context);
    expect(first).toMatchObject({ next: 'succeeded', payload: { output: { location: 'files', bytes: 4 } } });
    expect(rerun).toEqual(first);
    expect(t.deps.saveToFiles).toHaveBeenCalledTimes(2);
    expect(vi.mocked(t.deps.saveToFiles).mock.calls.map(([params]) => params.jobId)).toEqual([pending.id, pending.id]);
  });

  it('persists the settlement marker even when recording usage fails', async () => {
    const t = setup({
      recordUsage: vi.fn(async () => {
        throw new Error('metrics down');
      }),
    });
    const error = vi.spyOn(t.deps.logger, 'error');
    const created = await createVideoJob({ user, request: request(), source: 'studio' }, t.deps);
    await t.runToCompletion();
    const job = t.jobOf(created);
    expect(job.settledCredits).toBe(job.creditHold?.reservedCredits);
    expect(job.terminalHandledAt).toBeTruthy();
    expect(settleCreditHold).toHaveBeenCalledTimes(1);
    expect(error).toHaveBeenCalledWith('video_job_record_usage_failed', expect.objectContaining({ jobId: job.id }));
  });
});
