import { beforeEach, describe, expect, it, vi } from 'vitest';
import { CreditHolderType, insufficientCreditsError } from '@bike4mind/common';
import { createVideoProviderRegistry, TestVideoProvider } from '@bike4mind/utils/videoProviders';
import { Logger } from '@bike4mind/observability';
import { createInMemoryGenerationJobRepository } from '../generationJobs/__test__/inMemoryGenerationJobRepository';
import { GenerationJobEngine } from '../generationJobs/engine';
import type { CreditHold, CreditHoldAdapters } from '../creditService/creditHold';
import { EXPIRED_KEY_SENTINEL } from '../modelDiscoveryService/credentials';
import { createVideoJob } from './createVideoJob';
import { createVideoJobHandler } from './videoJobHandler';
import type { CreateVideoJobDeps, VideoJobDeps } from './types';

vi.mock('../creditService/creditHold', () => ({
  holdCredits: vi.fn(),
  releaseCreditHold: vi.fn(async () => undefined),
  settleCreditHold: vi.fn(async (_hold: unknown, charged: number) => charged),
}));
import { holdCredits, releaseCreditHold } from '../creditService/creditHold';

const fakeHold = (params: { userId: string; requiredCredits: number }): CreditHold => ({
  ownerId: params.userId,
  ownerType: CreditHolderType.User,
  userId: params.userId,
  organizationId: null,
  reservedCredits: params.requiredCredits,
  balanceAfterHold: 1000,
});

const validRequest = {
  model: 'test-video',
  mode: 'text_to_video',
  prompt: 'a cat',
  durationSeconds: 4,
  aspectRatio: '16:9',
  resolution: '720p',
};

// creditHold is module-mocked, so the adapters are never touched.
const unusedCredits = {} as CreditHoldAdapters;

const makeDeps = (overrides: Partial<VideoJobDeps> = {}) => {
  const repository = createInMemoryGenerationJobRepository();
  const deps: CreateVideoJobDeps = {
    repository,
    providers: createVideoProviderRegistry([new TestVideoProvider()]),
    getSettings: async () => ({ enforceCredits: true, videoGeneration: undefined }),
    resolveApiKey: async () => 'key',
    loadInputImage: async () => ({ bytes: Buffer.from('img'), mimeType: 'image/png' }),
    saveToFiles: vi.fn(),
    saveToGeneratedBucket: vi.fn(),
    credits: unusedCredits,
    enqueue: vi.fn(async () => undefined),
    recordUsage: vi.fn(async () => undefined),
    now: () => new Date('2026-10-06T00:00:00Z'),
    logger: new Logger({ metadata: { test: 'createVideoJob' } }),
    engine: { failBeforeStart: (jobId, error) => engine.failBeforeStart(jobId, error) },
    ...overrides,
  };
  const engine = new GenerationJobEngine({
    repository,
    handlers: [createVideoJobHandler(deps)],
    enqueue: deps.enqueue,
    notify: async () => undefined,
    now: deps.now,
    logger: deps.logger,
    leaseMs: 330_000,
  });
  return { deps, repository };
};

const user = { id: 'u1', organizationId: null };

describe('createVideoJob', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(holdCredits).mockImplementation(async params => fakeHold(params));
  });

  it('holds credits, creates a pending job and enqueues it immediately', async () => {
    const { deps } = makeDeps();
    const result = await createVideoJob({ user, request: validRequest, source: 'studio' }, deps);
    expect(result).toMatchObject({
      ok: true,
      created: true,
      job: { state: 'pending', creditHold: { reservedCredits: expect.any(Number) } },
    });
    expect(deps.enqueue).toHaveBeenCalledWith(expect.any(String), 0);
  });

  it('invalid request holds no credits', async () => {
    const { deps } = makeDeps();
    const result = await createVideoJob(
      { user, request: { ...validRequest, durationSeconds: 12 }, source: 'api' },
      deps
    );
    expect(result).toMatchObject({ ok: false, status: 422, code: 'unsupported_duration' });
    expect(holdCredits).not.toHaveBeenCalled();
  });

  it('rejects malformed input with invalid_request', async () => {
    const result = await createVideoJob({ user, request: { model: 'nope' }, source: 'api' }, makeDeps().deps);
    expect(result).toMatchObject({ ok: false, status: 400, code: 'invalid_request' });
  });

  it('rejects a disabled model', async () => {
    const { deps } = makeDeps({
      getSettings: async () => ({ enforceCredits: true, videoGeneration: { enabledModels: { 'test-video': false } } }),
    });
    expect(await createVideoJob({ user, request: validRequest, source: 'api' }, deps)).toMatchObject({
      ok: false,
      status: 403,
      code: 'model_disabled',
    });
  });

  it('rejects a model whose provider is not registered', async () => {
    const { deps } = makeDeps({ providers: createVideoProviderRegistry([]) });
    expect(await createVideoJob({ user, request: validRequest, source: 'api' }, deps)).toMatchObject({
      ok: false,
      status: 422,
      code: 'model_unavailable',
    });
  });

  it.each([null, EXPIRED_KEY_SENTINEL])(
    'rejects a provider whose key resolves to %j as model_unavailable, holding nothing',
    async apiKey => {
      const { deps } = makeDeps({ resolveApiKey: async () => apiKey });
      expect(await createVideoJob({ user, request: validRequest, source: 'api' }, deps)).toMatchObject({
        ok: false,
        status: 422,
        code: 'model_unavailable',
      });
      expect(holdCredits).not.toHaveBeenCalled();
    }
  );

  it('reports an admin-disabled model as model_disabled even when no key is configured', async () => {
    const { deps } = makeDeps({
      resolveApiKey: async () => null,
      getSettings: async () => ({ enforceCredits: true, videoGeneration: { enabledModels: { 'test-video': false } } }),
    });
    expect(await createVideoJob({ user, request: validRequest, source: 'api' }, deps)).toMatchObject({
      ok: false,
      code: 'model_disabled',
    });
  });

  it("rejects image_to_video when the input image is not the user's", async () => {
    const { deps } = makeDeps({ loadInputImage: async () => null });
    const result = await createVideoJob(
      { user, request: { ...validRequest, mode: 'image_to_video', inputImageFileId: 'f9' }, source: 'api' },
      deps
    );
    expect(result).toMatchObject({ ok: false, status: 404, code: 'input_image_not_found' });
    expect(holdCredits).not.toHaveBeenCalled();
  });

  it('maps insufficient credits to 402', async () => {
    vi.mocked(holdCredits).mockRejectedValueOnce(insufficientCreditsError('You do not have enough credits'));
    expect(await createVideoJob({ user, request: validRequest, source: 'api' }, makeDeps().deps)).toMatchObject({
      ok: false,
      status: 402,
      code: 'insufficient_credits',
      message: 'You do not have enough credits',
    });
  });

  it('rethrows a hold failure that is not insufficient credits', async () => {
    vi.mocked(holdCredits).mockRejectedValueOnce(new Error('db down'));
    await expect(createVideoJob({ user, request: validRequest, source: 'api' }, makeDeps().deps)).rejects.toThrow(
      'db down'
    );
  });

  it('skips the hold when credits are not enforced', async () => {
    const { deps } = makeDeps({ getSettings: async () => ({ enforceCredits: false, videoGeneration: undefined }) });
    const result = await createVideoJob({ user, request: validRequest, source: 'api' }, deps);
    expect(result).toMatchObject({ ok: true, job: { creditHold: null } });
    expect(holdCredits).not.toHaveBeenCalled();
  });

  it('bills an organization member against the organization', async () => {
    const { deps } = makeDeps();
    const result = await createVideoJob(
      { user: { id: 'u1', organizationId: 'org1' }, request: validRequest, source: 'api' },
      deps
    );
    expect(result).toMatchObject({ ok: true, job: { ownerType: CreditHolderType.Organization, ownerId: 'org1' } });
    expect(holdCredits).toHaveBeenCalledWith(
      expect.objectContaining({ userId: 'u1', organizationId: 'org1', featureLabel: 'video generation' }),
      deps.credits
    );
  });

  it('returns the existing job for a repeated idempotency key with the same request', async () => {
    const { deps } = makeDeps();
    const first = await createVideoJob({ user, request: validRequest, source: 'api', idempotencyKey: 'k1' }, deps);
    const second = await createVideoJob({ user, request: validRequest, source: 'api', idempotencyKey: 'k1' }, deps);
    expect(second).toMatchObject({ ok: true, created: false });
    if (!first.ok || !second.ok) throw new Error('expected both calls to succeed');
    expect(second.job.id).toBe(first.job.id);
    expect(holdCredits).toHaveBeenCalledTimes(1);
  });

  it('replays a stored request that differs only by an undefined field, as after a Mongo round trip', async () => {
    const { deps, repository } = makeDeps();
    const first = await createVideoJob({ user, request: validRequest, source: 'api', idempotencyKey: 'k1' }, deps);
    if (!first.ok) throw new Error('expected the first call to succeed');
    const stored = repository.jobs.get(first.job.id)!;
    stored.payload.request = { ...stored.payload.request, audio: undefined };
    const second = await createVideoJob({ user, request: validRequest, source: 'api', idempotencyKey: 'k1' }, deps);
    expect(second).toMatchObject({ ok: true, created: false, job: { id: first.job.id } });
  });

  it('replays a repeated idempotency key even after the provider key was removed', async () => {
    let key: string | null = 'key';
    const { deps } = makeDeps({ resolveApiKey: async () => key });
    const first = await createVideoJob({ user, request: validRequest, source: 'api', idempotencyKey: 'k1' }, deps);
    if (!first.ok) throw new Error('expected the first call to succeed');
    key = null;
    const second = await createVideoJob({ user, request: validRequest, source: 'api', idempotencyKey: 'k1' }, deps);
    expect(second).toMatchObject({ ok: true, created: false, job: { id: first.job.id } });
    expect(holdCredits).toHaveBeenCalledTimes(1);
  });

  it('rejects a reused idempotency key with a different request', async () => {
    const { deps } = makeDeps();
    await createVideoJob({ user, request: validRequest, source: 'api', idempotencyKey: 'k1' }, deps);
    const second = await createVideoJob(
      { user, request: { ...validRequest, prompt: 'a dog' }, source: 'api', idempotencyKey: 'k1' },
      deps
    );
    expect(second).toMatchObject({ ok: false, status: 422, code: 'idempotency_key_reused' });
  });

  it('answers a lost idempotency race as a replay of the winner and releases its own hold', async () => {
    const { deps, repository } = makeDeps();
    const winner = await createVideoJob({ user, request: validRequest, source: 'api', idempotencyKey: 'k1' }, deps);
    // The pre-check misses (the winner had not committed yet), then the unique index rejects the insert.
    vi.spyOn(repository, 'findByIdempotencyKey').mockResolvedValueOnce(null);
    vi.spyOn(repository, 'createJob').mockRejectedValueOnce(Object.assign(new Error('E11000'), { code: 11000 }));
    const loser = await createVideoJob({ user, request: validRequest, source: 'api', idempotencyKey: 'k1' }, deps);
    if (!winner.ok) throw new Error('expected the winner to succeed');
    expect(loser).toMatchObject({ ok: true, created: false, job: { id: winner.job.id } });
    expect(releaseCreditHold).toHaveBeenCalledTimes(1);
  });

  describe('an ambiguous create failure', () => {
    // No idempotency key: the caller-generated job id alone resolves the outcome.
    const keyless = { user, request: validRequest, source: 'api' as const };

    it('passes a caller-generated ObjectId to createJob', async () => {
      const { deps, repository } = makeDeps();
      const create = vi.spyOn(repository, 'createJob');
      const result = await createVideoJob(keyless, deps);
      expect(create).toHaveBeenCalledWith(expect.objectContaining({ id: expect.stringMatching(/^[0-9a-f]{24}$/) }));
      if (!result.ok) throw new Error('expected creation to succeed');
      expect(result.job.id).toBe(create.mock.calls[0][0].id);
    });

    const insertThenThrow = (repository: ReturnType<typeof makeDeps>['repository'], error: Error) => {
      const realCreate = repository.createJob.bind(repository);
      return vi.spyOn(repository, 'createJob').mockImplementationOnce(async jobInput => {
        await realCreate(jobInput);
        throw error;
      });
    };

    it('succeeds when the insert landed before the error: the job owns the hold and is enqueued', async () => {
      const { deps, repository } = makeDeps();
      insertThenThrow(repository, new Error('ack lost'));
      const result = await createVideoJob(keyless, deps);
      const [stored] = [...repository.jobs.values()];
      expect(result).toMatchObject({ ok: true, created: true, job: { id: stored.id, state: 'pending' } });
      expect(deps.enqueue).toHaveBeenCalledWith(stored.id, 0);
      expect(releaseCreditHold).not.toHaveBeenCalled();
    });

    it('takes the enqueue-failure path when a landed job then cannot be queued', async () => {
      const { deps, repository } = makeDeps({
        enqueue: vi.fn(async () => {
          throw new Error('SQS down');
        }),
      });
      insertThenThrow(repository, new Error('ack lost'));
      await expect(createVideoJob(keyless, deps)).rejects.toThrow('SQS down');
      const [stored] = [...repository.jobs.values()];
      expect(stored).toMatchObject({ state: 'failed', error: { code: 'enqueue_failed' } });
      expect(releaseCreditHold).toHaveBeenCalledTimes(1);
    });

    it('treats a duplicate-key error raised by its own landed insert as success, not a lost race', async () => {
      const { deps, repository } = makeDeps();
      insertThenThrow(repository, Object.assign(new Error('E11000 on retry'), { code: 11000 }));
      const result = await createVideoJob({ ...keyless, idempotencyKey: 'k1' }, deps);
      const [stored] = [...repository.jobs.values()];
      expect(result).toMatchObject({ ok: true, created: true, job: { id: stored.id } });
      expect(deps.enqueue).toHaveBeenCalledWith(stored.id, 0);
      expect(releaseCreditHold).not.toHaveBeenCalled();
    });

    it('resolves a duplicate-key error by id when the key lookup fails', async () => {
      const { deps, repository } = makeDeps();
      vi.spyOn(repository, 'findByIdempotencyKey')
        .mockResolvedValueOnce(null)
        .mockRejectedValueOnce(new Error('read failed'));
      vi.spyOn(repository, 'createJob').mockRejectedValueOnce(Object.assign(new Error('E11000'), { code: 11000 }));
      await expect(createVideoJob({ ...keyless, idempotencyKey: 'k1' }, deps)).rejects.toThrow('E11000');
      expect(releaseCreditHold).toHaveBeenCalledTimes(1);
    });

    it('releases the hold once when the job is confirmed absent', async () => {
      const { deps, repository } = makeDeps();
      vi.spyOn(repository, 'createJob').mockRejectedValueOnce(new Error('write failed'));
      await expect(createVideoJob(keyless, deps)).rejects.toThrow('write failed');
      expect(repository.jobs.size).toBe(0);
      expect(releaseCreditHold).toHaveBeenCalledTimes(1);
    });

    it('keeps the hold and alarms when the lookup itself fails', async () => {
      const { deps, repository } = makeDeps();
      const error = vi.spyOn(deps.logger, 'error');
      const create = vi.spyOn(repository, 'createJob').mockRejectedValueOnce(new Error('write failed'));
      vi.spyOn(repository, 'findById').mockRejectedValueOnce(new Error('read failed'));
      await expect(createVideoJob(keyless, deps)).rejects.toThrow('write failed');
      expect(releaseCreditHold).not.toHaveBeenCalled();
      expect(error).toHaveBeenCalledWith('video_job_create_ambiguous', {
        jobId: create.mock.calls[0][0].id,
        ownerId: 'u1',
        reservedCredits: expect.any(Number),
        error: expect.any(Error),
      });
    });

    it('rethrows the original error when the release itself fails', async () => {
      const { deps, repository } = makeDeps();
      const error = vi.spyOn(deps.logger, 'error');
      vi.spyOn(repository, 'createJob').mockRejectedValueOnce(new Error('write failed'));
      vi.mocked(releaseCreditHold).mockRejectedValueOnce(new Error('refund failed'));
      await expect(createVideoJob(keyless, deps)).rejects.toThrow('write failed');
      expect(error).toHaveBeenCalledWith('video_job_create_cleanup_failed', expect.objectContaining({ ownerId: 'u1' }));
    });
  });

  it('rethrows the enqueue error when failing the unqueued job also fails', async () => {
    const { deps, repository } = makeDeps({
      enqueue: vi.fn(async () => {
        throw new Error('SQS down');
      }),
    });
    const error = vi.spyOn(deps.logger, 'error');
    vi.spyOn(repository, 'commit').mockRejectedValueOnce(new Error('mongo down'));
    await expect(createVideoJob({ user, request: validRequest, source: 'api' }, deps)).rejects.toThrow('SQS down');
    expect(error).toHaveBeenCalledWith(
      'video_job_create_cleanup_failed',
      expect.objectContaining({ jobId: expect.any(String), ownerId: 'u1' })
    );
  });

  it('releases the hold and fails the job when enqueue throws', async () => {
    const { deps, repository } = makeDeps({
      enqueue: vi.fn(async () => {
        throw new Error('SQS down');
      }),
    });
    await expect(createVideoJob({ user, request: validRequest, source: 'api' }, deps)).rejects.toThrow('SQS down');
    const [job] = [...repository.jobs.values()];
    expect(job.state).toBe('failed');
    expect(job.error?.code).toBe('enqueue_failed');
    expect(job.nextPollAt).toBeNull();
    expect(job.settledCredits).toBe(0);
    expect(job.terminalHandledAt).toBeTruthy();
    expect(releaseCreditHold).toHaveBeenCalledTimes(1);
  });

  it('succeeds when the enqueue errors but a worker already started the job: the send landed', async () => {
    const { deps, repository } = makeDeps();
    deps.enqueue = vi.fn(async (jobId: string) => {
      await repository.acquireLease(jobId, deps.now(), new Date(deps.now().getTime() + 330_000));
      throw new Error('SQS ack lost');
    });
    const result = await createVideoJob({ user, request: validRequest, source: 'api' }, deps);
    expect(result).toMatchObject({ ok: true, created: true, job: { state: 'pending' } });
    expect(releaseCreditHold).not.toHaveBeenCalled();
  });
});
