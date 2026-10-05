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
import { createVideoJob } from './createVideoJob';
import { createVideoJobHandler } from './videoJobHandler';
import type { CreateVideoJobResult, VideoJobDeps } from './types';

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
  const deps: VideoJobDeps = {
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
  return { deps, repository, engine, runToCompletion, jobOf };
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

  it('a store re-run after a crash between save and commit does not save twice', async () => {
    const t = setup();
    const created = await createVideoJob({ user, request: request(), source: 'studio' }, t.deps);
    await t.runToCompletion();
    const job = t.jobOf(created);
    // Simulate: output persisted but the terminal commit never happened.
    Object.assign(job, {
      state: 'storing',
      terminalHandledAt: null,
      terminalHandlingClaimedAt: null,
      leaseUntil: null,
    });
    const handler = createVideoJobHandler(t.deps);
    const result = await handler.store(structuredClone(job));
    expect(result).toMatchObject({ next: 'succeeded', payload: { output: job.payload.output } });
    expect(t.deps.saveToFiles).toHaveBeenCalledTimes(1);
  });
});
