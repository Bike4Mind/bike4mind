import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  CreditHolderType,
  estimateMusicCostCredits,
  insufficientCreditsError,
  MUSIC_MODEL_CATALOG,
  MUSIC_MODEL_IDS,
} from '@bike4mind/common';
import { createMusicProviderRegistry, TestMusicProvider, type MusicProvider } from '@bike4mind/utils/musicProviders';
import { Logger } from '@bike4mind/observability';
import { createInMemoryGenerationJobRepository } from '../generationJobs/__test__/inMemoryGenerationJobRepository';
import { GenerationJobEngine } from '../generationJobs/engine';
import type { CreditHold, CreditHoldAdapters } from '../creditService/creditHold';
import { EXPIRED_KEY_SENTINEL } from '../modelDiscoveryService/credentials';
import { createMusicJob } from './createMusicJob';
import { createMusicJobHandler } from './musicJobHandler';
import { MAX_MUSIC_BYTES_PER_SECOND, type CreateMusicJobDeps } from './types';

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

const validRequest = { model: 'test-music', prompt: 'a folk song', durationSeconds: 5 };

// creditHold is module-mocked, so the adapters are never touched.
const unusedCredits = {} as CreditHoldAdapters;

// Registered as ElevenLabs so a priced, per-second model can be held against.
const elevenLabsStub: MusicProvider = {
  mode: 'sync',
  id: 'elevenlabs',
  models: MUSIC_MODEL_IDS.filter(id => MUSIC_MODEL_CATALOG[id].provider === 'elevenlabs'),
  generate: vi.fn(),
  fetchOutput: vi.fn(),
};

const lyriaStub: MusicProvider = {
  mode: 'sync',
  id: 'gemini-lyria',
  models: MUSIC_MODEL_IDS.filter(id => MUSIC_MODEL_CATALOG[id].provider === 'gemini-lyria'),
  generate: vi.fn(),
  fetchOutput: vi.fn(),
};

const makeDeps = (overrides: Partial<CreateMusicJobDeps> = {}) => {
  const repository = createInMemoryGenerationJobRepository();
  const deps: CreateMusicJobDeps = {
    repository,
    providers: createMusicProviderRegistry([new TestMusicProvider(), elevenLabsStub, lyriaStub]),
    getSettings: async () => ({ enforceCredits: true, musicGeneration: undefined }),
    resolveApiKey: async () => 'key',
    checkStorageFor: vi.fn(async () => undefined),
    saveToFiles: vi.fn(),
    saveToGeneratedBucket: vi.fn(),
    credits: unusedCredits,
    enqueue: vi.fn(async () => undefined),
    recordUsage: vi.fn(async () => undefined),
    now: () => new Date('2026-10-13T00:00:00Z'),
    logger: new Logger({ metadata: { test: 'createMusicJob' } }),
    engine: { failBeforeStart: (jobId, error) => engine.failBeforeStart(jobId, error) },
    ...overrides,
  };
  const engine = new GenerationJobEngine({
    repository,
    handlers: [createMusicJobHandler(deps)],
    enqueue: deps.enqueue,
    notify: async () => undefined,
    now: deps.now,
    logger: deps.logger,
    leaseMs: 330_000,
  });
  return { deps, repository };
};

const user = { id: 'u1', organizationId: null };

describe('createMusicJob', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(holdCredits).mockImplementation(async params => fakeHold(params));
  });

  it('holds credits, creates a pending music job with its defaults resolved and enqueues it', async () => {
    const { deps } = makeDeps();
    const result = await createMusicJob(
      { user, request: { model: 'test-music', prompt: 'a song' }, source: 'agent', sessionId: 's1', questId: 'q1' },
      deps
    );
    expect(result).toMatchObject({
      ok: true,
      created: true,
      job: {
        kind: 'music',
        state: 'pending',
        questId: 'q1',
        payload: {
          providerId: 'test',
          sessionId: 's1',
          request: { model: 'test-music', prompt: 'a song', durationSeconds: 5, instrumental: false },
        },
      },
    });
    expect(deps.enqueue).toHaveBeenCalledWith(expect.any(String), 0);
  });

  it('holds the estimate for the requested length', async () => {
    const { deps } = makeDeps();
    const result = await createMusicJob(
      { user, request: { model: 'music_v2_5', prompt: 'x', durationSeconds: 90 }, source: 'api' },
      deps
    );
    const expected = estimateMusicCostCredits(MUSIC_MODEL_CATALOG.music_v2_5, { durationSeconds: 90 });
    expect(expected).toBeGreaterThan(0);
    expect(result).toMatchObject({ ok: true, job: { creditHold: { reservedCredits: expected } } });
    expect(holdCredits).toHaveBeenCalledWith(
      expect.objectContaining({ requiredCredits: expected, featureLabel: 'music generation' }),
      deps.credits
    );
  });

  it('rejects malformed input with invalid_request', async () => {
    const result = await createMusicJob({ user, request: { model: 'nope' }, source: 'api' }, makeDeps().deps);
    expect(result).toMatchObject({ ok: false, status: 400, code: 'invalid_request' });
  });

  it('rejects a model whose provider is not registered', async () => {
    const { deps } = makeDeps({ providers: createMusicProviderRegistry([]) });
    expect(await createMusicJob({ user, request: validRequest, source: 'api' }, deps)).toMatchObject({
      ok: false,
      status: 422,
      code: 'model_unavailable',
    });
  });

  it('rejects an admin-disabled model', async () => {
    const { deps } = makeDeps({
      getSettings: async () => ({ enforceCredits: true, musicGeneration: { enabledModels: { 'test-music': false } } }),
    });
    expect(await createMusicJob({ user, request: validRequest, source: 'api' }, deps)).toMatchObject({
      ok: false,
      status: 403,
      code: 'model_disabled',
    });
  });

  it.each([
    [{ ...validRequest, durationSeconds: 99 }, 'unsupported_duration'],
    [{ ...validRequest, lyrics: 'la', instrumental: true }, 'lyrics_with_instrumental'],
  ])('rejects a request the model cannot honour with its validation code, holding nothing', async (request, code) => {
    const result = await createMusicJob({ user, request, source: 'api' }, makeDeps().deps);
    expect(result).toMatchObject({ ok: false, status: 422, code });
    expect(holdCredits).not.toHaveBeenCalled();
  });

  it.each([null, EXPIRED_KEY_SENTINEL])('rejects a key that resolves to %j as model_unavailable', async apiKey => {
    const { deps } = makeDeps({ resolveApiKey: async () => apiKey });
    expect(await createMusicJob({ user, request: validRequest, source: 'api' }, deps)).toMatchObject({
      ok: false,
      status: 422,
      code: 'model_unavailable',
    });
    expect(holdCredits).not.toHaveBeenCalled();
  });

  it('refuses a full Files quota before holding, sized for an exact model at the requested length', async () => {
    const storage = {
      errorCode: 'storage_limit_exceeded',
      used_bytes: 900,
      limit_bytes: 1000,
      requested_bytes: 200_000,
      owner: 'user',
    } as const;
    const { deps } = makeDeps({ checkStorageFor: vi.fn(async () => storage) });
    expect(await createMusicJob({ user, request: validRequest, source: 'api' }, deps)).toMatchObject({
      ok: false,
      status: 400,
      code: 'storage_quota_exceeded',
      storage,
    });
    expect(deps.checkStorageFor).toHaveBeenCalledWith('u1', 5 * MAX_MUSIC_BYTES_PER_SECOND);
    expect(holdCredits).not.toHaveBeenCalled();
  });

  it('sizes the storage check for an approximate model at its maximum, since length is only steered', async () => {
    const { deps } = makeDeps();
    await createMusicJob({ user, request: { model: 'lyria-3.5', prompt: 'x' }, source: 'api' }, deps);
    expect(deps.checkStorageFor).toHaveBeenCalledWith('u1', 180 * MAX_MUSIC_BYTES_PER_SECOND);
  });

  it('sizes the storage check for a fixed-length model at its fixed seconds', async () => {
    const { deps } = makeDeps();
    await createMusicJob({ user, request: { model: 'lyria-3-clip-preview', prompt: 'x' }, source: 'api' }, deps);
    expect(deps.checkStorageFor).toHaveBeenCalledWith('u1', 30 * MAX_MUSIC_BYTES_PER_SECOND);
  });

  it('maps insufficient credits to 402', async () => {
    vi.mocked(holdCredits).mockRejectedValueOnce(insufficientCreditsError('You do not have enough credits'));
    expect(await createMusicJob({ user, request: validRequest, source: 'api' }, makeDeps().deps)).toMatchObject({
      ok: false,
      status: 402,
      code: 'insufficient_credits',
    });
  });

  it('skips the hold when credits are not enforced', async () => {
    const { deps } = makeDeps({ getSettings: async () => ({ enforceCredits: false, musicGeneration: undefined }) });
    expect(await createMusicJob({ user, request: validRequest, source: 'api' }, deps)).toMatchObject({
      ok: true,
      job: { creditHold: null },
    });
    expect(holdCredits).not.toHaveBeenCalled();
  });

  it('bills an organization member against the organization', async () => {
    const { deps } = makeDeps();
    const result = await createMusicJob(
      { user: { id: 'u1', organizationId: 'org1' }, request: validRequest, source: 'api' },
      deps
    );
    expect(result).toMatchObject({ ok: true, job: { ownerType: CreditHolderType.Organization, ownerId: 'org1' } });
  });

  it('replays a repeated idempotency key with the same request, including its resolved defaults', async () => {
    const { deps } = makeDeps();
    const bare = { model: 'test-music', prompt: 'a song' };
    const first = await createMusicJob({ user, request: bare, source: 'api', idempotencyKey: 'k1' }, deps);
    const second = await createMusicJob(
      { user, request: { ...bare, durationSeconds: 5 }, source: 'api', idempotencyKey: 'k1' },
      deps
    );
    if (!first.ok || !second.ok) throw new Error('expected both calls to succeed');
    expect(second).toMatchObject({ created: false, job: { id: first.job.id } });
    expect(holdCredits).toHaveBeenCalledTimes(1);
  });

  it('rejects a reused idempotency key with a different request', async () => {
    const { deps } = makeDeps();
    await createMusicJob({ user, request: validRequest, source: 'api', idempotencyKey: 'k1' }, deps);
    const second = await createMusicJob(
      { user, request: { ...validRequest, prompt: 'a dirge' }, source: 'api', idempotencyKey: 'k1' },
      deps
    );
    expect(second).toMatchObject({ ok: false, status: 422, code: 'idempotency_key_reused' });
  });

  it('rejects a key already held by a job of another kind', async () => {
    const { deps, repository } = makeDeps();
    const first = await createMusicJob({ user, request: validRequest, source: 'api', idempotencyKey: 'k1' }, deps);
    if (!first.ok) throw new Error('expected the first call to succeed');
    vi.spyOn(repository, 'findByIdempotencyKey').mockResolvedValueOnce({
      ...first.job,
      kind: 'video',
    } as unknown as Awaited<ReturnType<typeof repository.findByIdempotencyKey>>);
    const second = await createMusicJob({ user, request: validRequest, source: 'api', idempotencyKey: 'k1' }, deps);
    expect(second).toMatchObject({ ok: false, code: 'idempotency_key_reused' });
  });

  it('releases the hold and fails the job when enqueue throws', async () => {
    const { deps, repository } = makeDeps({
      enqueue: vi.fn(async () => {
        throw new Error('SQS down');
      }),
    });
    await expect(createMusicJob({ user, request: validRequest, source: 'api' }, deps)).rejects.toThrow('SQS down');
    const [job] = [...repository.jobs.values()];
    expect(job).toMatchObject({ kind: 'music', state: 'failed', error: { code: 'enqueue_failed' }, settledCredits: 0 });
    expect(releaseCreditHold).toHaveBeenCalledTimes(1);
  });

  it('logs a failed cleanup under the music kind', async () => {
    const { deps, repository } = makeDeps();
    const error = vi.spyOn(deps.logger, 'error');
    vi.spyOn(repository, 'createJob').mockRejectedValueOnce(new Error('write failed'));
    vi.mocked(releaseCreditHold).mockRejectedValueOnce(new Error('refund failed'));
    await expect(createMusicJob({ user, request: validRequest, source: 'api' }, deps)).rejects.toThrow('write failed');
    expect(error).toHaveBeenCalledWith('music_job_create_cleanup_failed', expect.objectContaining({ ownerId: 'u1' }));
  });
});
