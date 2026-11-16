import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  CreditHolderType,
  DEFAULT_SOUND_MODEL_ID,
  insufficientCreditsError,
  type StorageLimitErrorInfo,
} from '@bike4mind/common';
import { Logger } from '@bike4mind/observability';
import { testSoundEffectProvider } from '@bike4mind/utils/audioProviders';
import { createInMemoryGenerationJobRepository } from '../generationJobs/__test__/inMemoryGenerationJobRepository';
import { GenerationJobEngine } from '../generationJobs/engine';
import type { CreditHold, CreditHoldAdapters } from '../creditService/creditHold';
import { EXPIRED_KEY_SENTINEL } from '../modelDiscoveryService/credentials';
import { estimateSoundCredits } from '../soundCost';
import { createSoundEffectJob } from './createSoundEffectJob';
import { createSoundEffectJobHandler } from './soundEffectJobHandler';
import { AUDIO_JOB_MAX_WALL_CLOCK_MS, type CreateSoundEffectJobDeps } from './types';

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

// creditHold is module-mocked, so the adapters are never touched.
const unusedCredits = {} as CreditHoldAdapters;

const now = new Date('2026-10-13T00:00:00Z');

const makeDeps = (overrides: Partial<CreateSoundEffectJobDeps> = {}) => {
  const repository = createInMemoryGenerationJobRepository();
  const deps: CreateSoundEffectJobDeps = {
    assertModelAdmission: vi.fn(async () => {}),
    repository,
    providers: { elevenlabs: testSoundEffectProvider },
    getSettings: async () => ({ enforceCredits: true }),
    resolveApiKey: vi.fn(async () => 'key'),
    checkStorageFor: vi.fn(async () => undefined),
    saveToFiles: vi.fn(),
    saveToGeneratedBucket: vi.fn(),
    credits: unusedCredits,
    enqueue: vi.fn(async () => undefined),
    recordUsage: vi.fn(async () => undefined),
    now: () => now,
    logger: new Logger({ metadata: { test: 'createSoundEffectJob' } }),
    engine: { failBeforeStart: (jobId, error) => engine.failBeforeStart(jobId, error) },
    ...overrides,
  };
  const engine = new GenerationJobEngine({
    repository,
    handlers: [createSoundEffectJobHandler(deps)],
    enqueue: deps.enqueue,
    notify: async () => undefined,
    now: deps.now,
    logger: deps.logger,
    leaseMs: 330_000,
  });
  return { deps, repository };
};

const user = { id: 'u1', organizationId: null };
const validRequest = { text: 'a door slams', durationSeconds: 4 };

const storageRefusal: StorageLimitErrorInfo = {
  errorCode: 'storage_limit_exceeded',
  used_bytes: 900,
  limit_bytes: 1000,
  requested_bytes: 200_000,
  owner: 'user',
};

describe('createSoundEffectJob', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(holdCredits).mockImplementation(async params => fakeHold(params));
  });

  describe('validation', () => {
    it.each([
      ['an empty body', {}],
      ['empty text', { text: '' }],
      ['text over the limit', { text: 'a'.repeat(451) }],
      ['a duration under the minimum', { text: 'x', durationSeconds: 0.1 }],
      ['a duration over the maximum', { text: 'x', durationSeconds: 31 }],
      ['a prompt influence over 1', { text: 'x', promptInfluence: 2 }],
      ['an unknown vendor', { text: 'x', provider: 'nope' }],
    ])('rejects %s with 400 invalid_request, before any hold', async (_label, request) => {
      const { deps } = makeDeps();
      expect(await createSoundEffectJob({ user, request, source: 'api' }, deps)).toMatchObject({
        ok: false,
        status: 400,
        code: 'invalid_request',
      });
      expect(holdCredits).not.toHaveBeenCalled();
      expect(deps.enqueue).not.toHaveBeenCalled();
    });

    it.each(['bogus_format', ''])("rejects the unsupported output format '%s' with 422", async format => {
      const { deps } = makeDeps();
      const result = await createSoundEffectJob({ user, request: { text: 'x', format }, source: 'api' }, deps);
      expect(result).toMatchObject({ ok: false, status: 422, code: 'invalid_request' });
      expect(deps.resolveApiKey).not.toHaveBeenCalled();
      expect(holdCredits).not.toHaveBeenCalled();
    });

    it('accepts a supported output format', async () => {
      const { deps } = makeDeps();
      const result = await createSoundEffectJob(
        { user, request: { text: 'x', format: 'mp3_44100_128' }, source: 'api' },
        deps
      );
      expect(result).toMatchObject({ ok: true, job: { payload: { request: { format: 'mp3_44100_128' } } } });
    });

    it('refuses with model_unavailable when the vendor is not registered', async () => {
      const { deps } = makeDeps({ providers: {} });
      expect(await createSoundEffectJob({ user, request: validRequest, source: 'api' }, deps)).toMatchObject({
        ok: false,
        status: 422,
        code: 'model_unavailable',
      });
      expect(holdCredits).not.toHaveBeenCalled();
    });
  });

  describe('admission and keys', () => {
    it('refuses a withheld model before holding credits or enqueuing work', async () => {
      const { deps } = makeDeps();
      const refusal = new Error('paid plan required');
      vi.mocked(deps.assertModelAdmission).mockRejectedValue(refusal);
      await expect(
        createSoundEffectJob({ user: { ...user, adminRoleWithheld: true }, request: validRequest, source: 'api' }, deps)
      ).rejects.toBe(refusal);
      expect(deps.assertModelAdmission).toHaveBeenCalledWith('u1', DEFAULT_SOUND_MODEL_ID, true);
      expect(holdCredits).not.toHaveBeenCalled();
      expect(deps.enqueue).not.toHaveBeenCalled();
    });

    it.each([
      ['no key', null],
      ['an expired key', EXPIRED_KEY_SENTINEL],
    ])('refuses with model_unavailable when there is %s', async (_label, key) => {
      const { deps } = makeDeps({ resolveApiKey: vi.fn(async () => key) });
      expect(await createSoundEffectJob({ user, request: validRequest, source: 'api' }, deps)).toMatchObject({
        ok: false,
        status: 422,
        code: 'model_unavailable',
      });
      expect(holdCredits).not.toHaveBeenCalled();
    });
  });

  describe('storage quota', () => {
    it('refuses a full Files quota before holding, sized for the requested duration', async () => {
      const { deps } = makeDeps({ checkStorageFor: vi.fn(async () => storageRefusal) });
      expect(await createSoundEffectJob({ user, request: validRequest, source: 'api' }, deps)).toMatchObject({
        ok: false,
        status: 400,
        code: 'storage_quota_exceeded',
        storage: storageRefusal,
      });
      expect(deps.checkStorageFor).toHaveBeenCalledWith('u1', 4 * 100_000);
      expect(holdCredits).not.toHaveBeenCalled();
      expect(deps.enqueue).not.toHaveBeenCalled();
    });

    it('sizes the check for the longest clip when no duration is requested', async () => {
      const { deps } = makeDeps();
      await createSoundEffectJob({ user, request: { text: 'x' }, source: 'api' }, deps);
      expect(deps.checkStorageFor).toHaveBeenCalledWith('u1', 30 * 100_000);
    });

    it('rounds a fractional duration up to a whole byte', async () => {
      const { deps } = makeDeps();
      await createSoundEffectJob({ user, request: { text: 'x', durationSeconds: 0.5 }, source: 'api' }, deps);
      expect(deps.checkStorageFor).toHaveBeenCalledWith('u1', 50_000);
    });

    it('skips the check for a clip kept outside Files', async () => {
      const { deps } = makeDeps({ checkStorageFor: vi.fn(async () => storageRefusal) });
      const result = await createSoundEffectJob(
        { user, request: validRequest, source: 'api', saveToFiles: false },
        deps
      );
      expect(result).toMatchObject({ ok: true, job: { payload: { saveToFiles: false } } });
      expect(deps.checkStorageFor).not.toHaveBeenCalled();
    });
  });

  describe('credits', () => {
    describe('free-tier daily cap', () => {
      const refusal = {
        message: 'Daily free-tier credit limit reached. Try again tomorrow.',
        retryAfterSeconds: 3_600,
      };

      it('refuses a capped user with a 429 before holding credits or enqueuing work', async () => {
        const checkDailySpendCap = vi.fn(async () => refusal);
        const { deps } = makeDeps({ checkDailySpendCap });
        expect(await createSoundEffectJob({ user, request: validRequest, source: 'api' }, deps)).toEqual({
          ok: false,
          status: 429,
          code: 'daily_limit_reached',
          ...refusal,
        });
        expect(checkDailySpendCap).toHaveBeenCalledWith({ userId: 'u1', billingOrganizationId: null });
        expect(holdCredits).not.toHaveBeenCalled();
        expect(deps.enqueue).not.toHaveBeenCalled();
      });

      it('checks the cap against the billed organization', async () => {
        const checkDailySpendCap = vi.fn(async () => undefined);
        const { deps } = makeDeps({ checkDailySpendCap });
        await createSoundEffectJob(
          { user: { id: 'u1', organizationId: 'org1' }, request: validRequest, source: 'api' },
          deps
        );
        expect(checkDailySpendCap).toHaveBeenCalledWith({ userId: 'u1', billingOrganizationId: 'org1' });
      });

      it('creates the job when the user is under the cap', async () => {
        const { deps } = makeDeps({ checkDailySpendCap: vi.fn(async () => undefined) });
        expect(await createSoundEffectJob({ user, request: validRequest, source: 'api' }, deps)).toMatchObject({
          ok: true,
        });
      });

      it('does not check the cap while credits are not enforced', async () => {
        const checkDailySpendCap = vi.fn(async () => refusal);
        const { deps } = makeDeps({ checkDailySpendCap, getSettings: async () => ({ enforceCredits: false }) });
        expect(await createSoundEffectJob({ user, request: validRequest, source: 'api' }, deps)).toMatchObject({
          ok: true,
        });
        expect(checkDailySpendCap).not.toHaveBeenCalled();
      });
    });

    it('maps insufficient credits to a 402 refusal', async () => {
      vi.mocked(holdCredits).mockRejectedValueOnce(insufficientCreditsError('You do not have enough credits'));
      const { deps } = makeDeps();
      expect(await createSoundEffectJob({ user, request: validRequest, source: 'api' }, deps)).toMatchObject({
        ok: false,
        status: 402,
        code: 'insufficient_credits',
        message: 'You do not have enough credits',
      });
      expect(deps.enqueue).not.toHaveBeenCalled();
    });

    it('skips the hold when credits are not enforced', async () => {
      const { deps } = makeDeps({ getSettings: async () => ({ enforceCredits: false }) });
      expect(await createSoundEffectJob({ user, request: validRequest, source: 'api' }, deps)).toMatchObject({
        ok: true,
        job: { creditHold: null },
      });
      expect(holdCredits).not.toHaveBeenCalled();
    });

    it('holds the duration-driven estimate', async () => {
      const { deps } = makeDeps();
      const expected = estimateSoundCredits('elevenlabs', { durationSeconds: 4 }).requiredCredits;
      expect(expected).toBeGreaterThan(0);
      const result = await createSoundEffectJob({ user, request: validRequest, source: 'api' }, deps);
      expect(result).toMatchObject({ ok: true, job: { creditHold: { reservedCredits: expected } } });
      expect(holdCredits).toHaveBeenCalledWith(
        expect.objectContaining({ requiredCredits: expected, featureLabel: 'sound generation', userId: 'u1' }),
        deps.credits
      );
    });

    it('holds the vendor default duration when none is requested', async () => {
      const { deps } = makeDeps();
      await createSoundEffectJob({ user, request: { text: 'x' }, source: 'api' }, deps);
      expect(holdCredits).toHaveBeenCalledWith(
        expect.objectContaining({
          requiredCredits: estimateSoundCredits('elevenlabs', { durationSeconds: undefined }).requiredCredits,
        }),
        deps.credits
      );
    });

    it('bills an organization member against the organization', async () => {
      const { deps } = makeDeps();
      const result = await createSoundEffectJob(
        { user: { id: 'u1', organizationId: 'org1' }, request: validRequest, source: 'api' },
        deps
      );
      expect(result).toMatchObject({ ok: true, job: { ownerType: CreditHolderType.Organization, ownerId: 'org1' } });
    });
  });

  describe('persisting and enqueuing', () => {
    it('creates a pending sound-effect job with its hold, then enqueues it', async () => {
      const { deps, repository } = makeDeps();
      const result = await createSoundEffectJob(
        {
          user,
          request: { text: 'a door slams', durationSeconds: 4, promptInfluence: 0.5 },
          source: 'agent',
          apiKeyId: 'key1',
          sessionId: 's1',
          questId: 'q1',
        },
        deps
      );
      if (!result.ok) throw new Error('expected success');
      expect(result).toMatchObject({
        created: true,
        job: {
          kind: 'sound_effect',
          state: 'pending',
          source: 'agent',
          ownerType: CreditHolderType.User,
          ownerId: 'u1',
          requestedBy: 'u1',
          apiKeyId: 'key1',
          questId: 'q1',
          pollCount: 0,
          attempts: 0,
          cancelRequested: false,
          nextPollAt: now,
          deadlineAt: new Date(now.getTime() + AUDIO_JOB_MAX_WALL_CLOCK_MS),
          creditHold: { userId: 'u1' },
          payload: {
            request: { text: 'a door slams', provider: 'elevenlabs', durationSeconds: 4, promptInfluence: 0.5 },
            providerId: 'elevenlabs',
            saveToFiles: true,
            sessionId: 's1',
          },
        },
      });
      expect(repository.jobs.get(result.job.id)).toMatchObject({ kind: 'sound_effect', state: 'pending' });
      expect(deps.enqueue).toHaveBeenCalledWith(result.job.id, 0);
    });

    it('omits the optional fields it was not given', async () => {
      const { deps } = makeDeps();
      const result = await createSoundEffectJob({ user, request: validRequest, source: 'api' }, deps);
      if (!result.ok) throw new Error('expected success');
      expect(result.job.payload).not.toHaveProperty('sessionId');
      expect(result.job).not.toHaveProperty('apiKeyId');
    });

    it('releases the hold and fails the job when enqueue throws', async () => {
      const { deps, repository } = makeDeps({
        enqueue: vi.fn(async () => {
          throw new Error('SQS down');
        }),
      });
      await expect(createSoundEffectJob({ user, request: validRequest, source: 'api' }, deps)).rejects.toThrow(
        'SQS down'
      );
      const [job] = [...repository.jobs.values()];
      expect(job).toMatchObject({ kind: 'sound_effect', state: 'failed', error: { code: 'enqueue_failed' } });
      expect(releaseCreditHold).toHaveBeenCalledTimes(1);
    });
  });

  describe('idempotency', () => {
    it('replays a repeated key with the same request, without a second hold or job', async () => {
      const { deps, repository } = makeDeps();
      const first = await createSoundEffectJob(
        { user, request: validRequest, source: 'api', idempotencyKey: 'k1' },
        deps
      );
      const second = await createSoundEffectJob(
        { user, request: { ...validRequest, provider: 'elevenlabs' }, source: 'api', idempotencyKey: 'k1' },
        deps
      );
      if (!first.ok || !second.ok) throw new Error('expected both calls to succeed');
      expect(second).toMatchObject({ created: false, job: { id: first.job.id } });
      expect(holdCredits).toHaveBeenCalledTimes(1);
      expect(deps.enqueue).toHaveBeenCalledTimes(1);
      expect(repository.jobs.size).toBe(1);
    });

    it('rejects a reused key with a different request', async () => {
      const { deps } = makeDeps();
      await createSoundEffectJob({ user, request: validRequest, source: 'api', idempotencyKey: 'k1' }, deps);
      expect(
        await createSoundEffectJob(
          { user, request: { text: 'something else' }, source: 'api', idempotencyKey: 'k1' },
          deps
        )
      ).toMatchObject({ ok: false, status: 422, code: 'idempotency_key_reused' });
    });
  });
});
