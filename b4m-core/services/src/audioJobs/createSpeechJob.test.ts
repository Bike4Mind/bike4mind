import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  CreditHolderType,
  estimateTtsHoldCredits,
  insufficientCreditsError,
  TTS_DEFAULT_MODEL,
  type StorageLimitErrorInfo,
} from '@bike4mind/common';
import { Logger } from '@bike4mind/observability';
import { testSpeechProvider } from '@bike4mind/utils/audioProviders';
import { createInMemoryGenerationJobRepository } from '../generationJobs/__test__/inMemoryGenerationJobRepository';
import { GenerationJobEngine } from '../generationJobs/engine';
import type { CreditHold, CreditHoldAdapters } from '../creditService/creditHold';
import { EXPIRED_KEY_SENTINEL } from '../modelDiscoveryService/credentials';
import { createSpeechJob } from './createSpeechJob';
import { createSpeechJobHandler } from './speechJobHandler';
import { AUDIO_JOB_MAX_WALL_CLOCK_MS, type CreateSpeechJobDeps } from './types';

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

const makeDeps = (overrides: Partial<CreateSpeechJobDeps> = {}) => {
  const repository = createInMemoryGenerationJobRepository();
  const deps: CreateSpeechJobDeps = {
    assertModelAdmission: vi.fn(async () => {}),
    isModelAdmitted: vi.fn(async () => true),
    repository,
    providers: { openai: testSpeechProvider, elevenlabs: testSpeechProvider },
    getSettings: async () => ({ enforceCredits: true }),
    resolveApiKey: vi.fn(async () => 'key'),
    resolveVoice: vi.fn(async () => undefined),
    checkStorageFor: vi.fn(async () => undefined),
    saveToFiles: vi.fn(),
    saveToGeneratedBucket: vi.fn(),
    credits: unusedCredits,
    enqueue: vi.fn(async () => undefined),
    recordUsage: vi.fn(async () => undefined),
    now: () => now,
    logger: new Logger({ metadata: { test: 'createSpeechJob' } }),
    engine: { failBeforeStart: (jobId, error) => engine.failBeforeStart(jobId, error) },
    ...overrides,
  };
  const engine = new GenerationJobEngine({
    repository,
    handlers: [createSpeechJobHandler(deps)],
    enqueue: deps.enqueue,
    notify: async () => undefined,
    now: deps.now,
    logger: deps.logger,
    leaseMs: 330_000,
  });
  return { deps, repository };
};

const user = { id: 'u1', organizationId: null };
const validRequest = { text: 'hello there' };

const storageRefusal: StorageLimitErrorInfo = {
  errorCode: 'storage_limit_exceeded',
  used_bytes: 900,
  limit_bytes: 1000,
  requested_bytes: 200_000,
  owner: 'user',
};

// The key lookup answers per vendor.
const keysFor = (keys: Partial<Record<'openai' | 'elevenlabs', string | null>>) =>
  vi.fn(async (vendor: 'openai' | 'elevenlabs') => keys[vendor] ?? null);

describe('createSpeechJob', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(holdCredits).mockImplementation(async params => fakeHold(params));
  });

  describe('validation', () => {
    it.each([
      ['an empty body', {}],
      ['empty text', { text: '' }],
      ['an unknown vendor', { text: 'hi', provider: 'nope' }],
      ['a non-object body', 'hello'],
    ])('rejects %s with 400 invalid_request, before any hold', async (_label, request) => {
      const { deps } = makeDeps();
      expect(await createSpeechJob({ user, request, source: 'api' }, deps)).toMatchObject({
        ok: false,
        status: 400,
        code: 'invalid_request',
      });
      expect(holdCredits).not.toHaveBeenCalled();
      expect(deps.enqueue).not.toHaveBeenCalled();
    });

    it('rejects text over the requested vendor limit with 422', async () => {
      const { deps } = makeDeps();
      const result = await createSpeechJob(
        { user, request: { text: 'a'.repeat(4097), provider: 'openai' }, source: 'api' },
        deps
      );
      expect(result).toMatchObject({ ok: false, status: 422, code: 'invalid_request' });
      expect(result.ok === false && result.message).toContain('4096');
      expect(holdCredits).not.toHaveBeenCalled();
    });

    it('applies the default vendor limit when none is requested', async () => {
      const { deps } = makeDeps();
      expect(await createSpeechJob({ user, request: { text: 'a'.repeat(4097) }, source: 'api' }, deps)).toMatchObject({
        ok: false,
        status: 422,
        code: 'invalid_request',
      });
    });

    it('accepts text over the default vendor limit when a larger vendor is requested', async () => {
      const { deps } = makeDeps();
      const result = await createSpeechJob(
        { user, request: { text: 'a'.repeat(5000), provider: 'elevenlabs' }, source: 'api' },
        deps
      );
      expect(result).toMatchObject({ ok: true, job: { payload: { candidates: ['elevenlabs'] } } });
    });

    it('rejects a format the vendor cannot produce with 422', async () => {
      const { deps } = makeDeps();
      const result = await createSpeechJob(
        { user, request: { text: 'hi', provider: 'elevenlabs', format: 'wav' }, source: 'api' },
        deps
      );
      expect(result).toMatchObject({ ok: false, status: 422, code: 'invalid_request' });
      expect(result.ok === false && result.message).toContain('wav');
      expect(deps.resolveApiKey).not.toHaveBeenCalled();
      expect(holdCredits).not.toHaveBeenCalled();
    });
  });

  describe('admission and candidates', () => {
    it('refuses a withheld model before holding credits or enqueuing work', async () => {
      const { deps } = makeDeps();
      const refusal = new Error('paid plan required');
      vi.mocked(deps.assertModelAdmission).mockRejectedValue(refusal);
      await expect(
        createSpeechJob({ user: { ...user, adminRoleWithheld: true }, request: validRequest, source: 'api' }, deps)
      ).rejects.toBe(refusal);
      expect(deps.assertModelAdmission).toHaveBeenCalledWith('u1', TTS_DEFAULT_MODEL.openai, true);
      expect(holdCredits).not.toHaveBeenCalled();
      expect(deps.enqueue).not.toHaveBeenCalled();
    });

    it('admits the requested model, not the vendor default', async () => {
      const { deps } = makeDeps();
      await createSpeechJob(
        { user, request: { text: 'hi', provider: 'openai', model: 'tts-1-hd' }, source: 'api' },
        deps
      );
      expect(deps.assertModelAdmission).toHaveBeenCalledWith('u1', 'tts-1-hd', undefined);
    });

    it('lists the requested vendor first, then each usable alternate', async () => {
      const { deps } = makeDeps();
      expect(await createSpeechJob({ user, request: validRequest, source: 'api' }, deps)).toMatchObject({
        ok: true,
        job: { payload: { candidates: ['openai', 'elevenlabs'] } },
      });
      const elevenlabsFirst = await createSpeechJob(
        { user, request: { text: 'hi', provider: 'elevenlabs' }, source: 'api' },
        deps
      );
      expect(elevenlabsFirst).toMatchObject({ ok: true, job: { payload: { candidates: ['elevenlabs', 'openai'] } } });
    });

    it('refuses with model_unavailable when no candidate has a usable key', async () => {
      const { deps } = makeDeps({ resolveApiKey: keysFor({}) });
      expect(await createSpeechJob({ user, request: validRequest, source: 'api' }, deps)).toMatchObject({
        ok: false,
        status: 422,
        code: 'model_unavailable',
      });
      expect(holdCredits).not.toHaveBeenCalled();
    });

    it('refuses with model_unavailable when no provider is registered', async () => {
      const { deps } = makeDeps({ providers: {} });
      expect(await createSpeechJob({ user, request: validRequest, source: 'api' }, deps)).toMatchObject({
        ok: false,
        status: 422,
        code: 'model_unavailable',
      });
    });

    it('treats an expired key as unusable', async () => {
      const { deps } = makeDeps({ resolveApiKey: keysFor({ openai: EXPIRED_KEY_SENTINEL, elevenlabs: 'key' }) });
      expect(await createSpeechJob({ user, request: validRequest, source: 'api' }, deps)).toMatchObject({
        ok: true,
        job: { payload: { candidates: ['elevenlabs'] } },
      });
    });

    it('serves from an alternate alone when the requested vendor has no key', async () => {
      const { deps } = makeDeps({ resolveApiKey: keysFor({ elevenlabs: 'key' }) });
      expect(await createSpeechJob({ user, request: validRequest, source: 'api' }, deps)).toMatchObject({
        ok: true,
        job: { payload: { candidates: ['elevenlabs'] } },
      });
    });

    it('drops an alternate whose default model the user may not use', async () => {
      const { deps } = makeDeps({
        isModelAdmitted: vi.fn(async (_userId, modelId) => modelId !== TTS_DEFAULT_MODEL.elevenlabs),
      });
      const result = await createSpeechJob(
        { user: { ...user, adminRoleWithheld: true }, request: validRequest, source: 'api' },
        deps
      );
      expect(result).toMatchObject({ ok: true, job: { payload: { candidates: ['openai'] } } });
      expect(deps.isModelAdmitted).toHaveBeenCalledWith('u1', TTS_DEFAULT_MODEL.elevenlabs, true);
    });

    it('does not run the alternate admission check for the requested vendor', async () => {
      const { deps } = makeDeps({ isModelAdmitted: vi.fn(async () => false) });
      const result = await createSpeechJob({ user, request: validRequest, source: 'api' }, deps);
      expect(result).toMatchObject({ ok: true, job: { payload: { candidates: ['openai'] } } });
      expect(deps.isModelAdmitted).not.toHaveBeenCalledWith('u1', TTS_DEFAULT_MODEL.openai, undefined);
    });

    it('drops only the vendor whose key lookup fails', async () => {
      const { deps } = makeDeps({
        resolveApiKey: vi.fn(async (vendor: string) => {
          if (vendor === 'elevenlabs') throw new Error('secrets store down');
          return 'key';
        }),
      });
      const warn = vi.spyOn(deps.logger, 'warn');
      expect(await createSpeechJob({ user, request: validRequest, source: 'api' }, deps)).toMatchObject({
        ok: true,
        job: { payload: { candidates: ['openai'] } },
      });
      expect(warn).toHaveBeenCalledWith(
        'TTS candidate key lookup failed',
        expect.objectContaining({ vendor: 'elevenlabs' })
      );
    });
  });

  describe('storage quota', () => {
    it('refuses a Files quota with no room at all before holding', async () => {
      const { deps } = makeDeps({ checkStorageFor: vi.fn(async () => storageRefusal) });
      expect(await createSpeechJob({ user, request: validRequest, source: 'api' }, deps)).toMatchObject({
        ok: false,
        status: 400,
        code: 'storage_quota_exceeded',
        storage: storageRefusal,
      });
      expect(holdCredits).not.toHaveBeenCalled();
      expect(deps.enqueue).not.toHaveBeenCalled();
    });

    it.each(['wav', 'mp3'] as const)(
      'checks only for room for any clip, never a worst-case %s size: the store step checks the real one',
      async format => {
        const { deps } = makeDeps();
        await createSpeechJob(
          { user, request: { text: 'a'.repeat(4_000), provider: 'openai', format }, source: 'api' },
          deps
        );
        expect(deps.checkStorageFor).toHaveBeenCalledExactlyOnceWith('u1', 1);
      }
    );

    it('skips the check for a clip kept outside Files', async () => {
      const { deps } = makeDeps({ checkStorageFor: vi.fn(async () => storageRefusal) });
      const result = await createSpeechJob({ user, request: validRequest, source: 'api', saveToFiles: false }, deps);
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
        expect(await createSpeechJob({ user, request: validRequest, source: 'api' }, deps)).toEqual({
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
        await createSpeechJob(
          { user: { id: 'u1', organizationId: 'org1' }, request: validRequest, source: 'api' },
          deps
        );
        expect(checkDailySpendCap).toHaveBeenCalledWith({ userId: 'u1', billingOrganizationId: 'org1' });
      });

      it('creates the job when the user is under the cap', async () => {
        const { deps } = makeDeps({ checkDailySpendCap: vi.fn(async () => undefined) });
        expect(await createSpeechJob({ user, request: validRequest, source: 'api' }, deps)).toMatchObject({ ok: true });
      });

      it('does not check the cap while credits are not enforced', async () => {
        const checkDailySpendCap = vi.fn(async () => refusal);
        const { deps } = makeDeps({ checkDailySpendCap, getSettings: async () => ({ enforceCredits: false }) });
        expect(await createSpeechJob({ user, request: validRequest, source: 'api' }, deps)).toMatchObject({ ok: true });
        expect(checkDailySpendCap).not.toHaveBeenCalled();
      });
    });

    it('maps insufficient credits to a 402 refusal', async () => {
      vi.mocked(holdCredits).mockRejectedValueOnce(insufficientCreditsError('You do not have enough credits'));
      const { deps } = makeDeps();
      expect(await createSpeechJob({ user, request: validRequest, source: 'api' }, deps)).toMatchObject({
        ok: false,
        status: 402,
        code: 'insufficient_credits',
        message: 'You do not have enough credits',
      });
      expect(deps.enqueue).not.toHaveBeenCalled();
    });

    it('rethrows any other hold failure', async () => {
      vi.mocked(holdCredits).mockRejectedValueOnce(new Error('ledger down'));
      await expect(createSpeechJob({ user, request: validRequest, source: 'api' }, makeDeps().deps)).rejects.toThrow(
        'ledger down'
      );
    });

    it('skips the hold when credits are not enforced', async () => {
      const { deps } = makeDeps({ getSettings: async () => ({ enforceCredits: false }) });
      expect(await createSpeechJob({ user, request: validRequest, source: 'api' }, deps)).toMatchObject({
        ok: true,
        job: { creditHold: null },
      });
      expect(holdCredits).not.toHaveBeenCalled();
    });

    it('holds enough for the costliest candidate, at the requested model for the requested vendor', async () => {
      const { deps } = makeDeps();
      const text = 'a'.repeat(1000);
      const result = await createSpeechJob(
        { user, request: { text, provider: 'openai', model: 'tts-1' }, source: 'api' },
        deps
      );
      const expected = estimateTtsHoldCredits('openai', 'tts-1', 1000, ['openai', 'elevenlabs']);
      expect(expected).toBeGreaterThan(0);
      expect(result).toMatchObject({ ok: true, job: { creditHold: { reservedCredits: expected } } });
      expect(holdCredits).toHaveBeenCalledWith(
        expect.objectContaining({ requiredCredits: expected, featureLabel: 'text-to-speech', userId: 'u1' }),
        deps.credits
      );
    });

    it('sizes the hold to the candidates that survived', async () => {
      const { deps } = makeDeps({ resolveApiKey: keysFor({ openai: 'key' }) });
      await createSpeechJob({ user, request: { text: 'a'.repeat(1000), provider: 'openai' }, source: 'api' }, deps);
      expect(holdCredits).toHaveBeenCalledWith(
        expect.objectContaining({ requiredCredits: estimateTtsHoldCredits('openai', undefined, 1000, ['openai']) }),
        deps.credits
      );
    });

    it('bills an organization member against the organization', async () => {
      const { deps } = makeDeps();
      const result = await createSpeechJob(
        { user: { id: 'u1', organizationId: 'org1' }, request: validRequest, source: 'api' },
        deps
      );
      expect(result).toMatchObject({ ok: true, job: { ownerType: CreditHolderType.Organization, ownerId: 'org1' } });
    });
  });

  describe('persisting and enqueuing', () => {
    it('creates a pending speech job with its candidates and hold, then enqueues it', async () => {
      const { deps, repository } = makeDeps();
      const result = await createSpeechJob(
        {
          user,
          request: { text: 'hello there', voice: 'nova' },
          source: 'agent',
          apiKeyId: 'key1',
          sessionId: 's1',
          questId: 'q1',
          preferredVoice: 'marin',
        },
        deps
      );
      if (!result.ok) throw new Error('expected success');
      expect(result).toMatchObject({
        created: true,
        job: {
          kind: 'speech',
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
            request: { text: 'hello there', provider: 'openai', voice: 'nova' },
            candidates: ['openai', 'elevenlabs'],
            preferredVoice: 'marin',
            saveToFiles: true,
            sessionId: 's1',
          },
        },
      });
      expect(repository.jobs.get(result.job.id)).toMatchObject({ kind: 'speech', state: 'pending' });
      expect(deps.enqueue).toHaveBeenCalledWith(result.job.id, 0);
    });

    it('omits the optional fields it was not given', async () => {
      const { deps } = makeDeps();
      const result = await createSpeechJob({ user, request: validRequest, source: 'api' }, deps);
      if (!result.ok) throw new Error('expected success');
      expect(result.job.payload).not.toHaveProperty('preferredVoice');
      expect(result.job.payload).not.toHaveProperty('sessionId');
      expect(result.job).not.toHaveProperty('apiKeyId');
    });

    it('ignores an empty voice preference', async () => {
      const { deps } = makeDeps();
      const result = await createSpeechJob({ user, request: validRequest, source: 'api', preferredVoice: '' }, deps);
      if (!result.ok) throw new Error('expected success');
      expect(result.job.payload).not.toHaveProperty('preferredVoice');
    });

    it('releases the hold and fails the job when enqueue throws', async () => {
      const { deps, repository } = makeDeps({
        enqueue: vi.fn(async () => {
          throw new Error('SQS down');
        }),
      });
      await expect(createSpeechJob({ user, request: validRequest, source: 'api' }, deps)).rejects.toThrow('SQS down');
      const [job] = [...repository.jobs.values()];
      expect(job).toMatchObject({ kind: 'speech', state: 'failed', error: { code: 'enqueue_failed' } });
      expect(releaseCreditHold).toHaveBeenCalledTimes(1);
    });
  });

  describe('idempotency', () => {
    it('replays a repeated key with the same request, without a second hold or job', async () => {
      const { deps, repository } = makeDeps();
      const first = await createSpeechJob({ user, request: validRequest, source: 'api', idempotencyKey: 'k1' }, deps);
      const second = await createSpeechJob(
        { user, request: { ...validRequest, provider: 'openai' }, source: 'api', idempotencyKey: 'k1' },
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
      await createSpeechJob({ user, request: validRequest, source: 'api', idempotencyKey: 'k1' }, deps);
      expect(
        await createSpeechJob({ user, request: { text: 'something else' }, source: 'api', idempotencyKey: 'k1' }, deps)
      ).toMatchObject({ ok: false, status: 422, code: 'idempotency_key_reused' });
    });

    it('replays before admission and the key lookups', async () => {
      const { deps } = makeDeps();
      await createSpeechJob({ user, request: validRequest, source: 'api', idempotencyKey: 'k1' }, deps);
      vi.mocked(deps.assertModelAdmission).mockClear();
      vi.mocked(deps.resolveApiKey).mockClear();
      await createSpeechJob({ user, request: validRequest, source: 'api', idempotencyKey: 'k1' }, deps);
      expect(deps.assertModelAdmission).not.toHaveBeenCalled();
      expect(deps.resolveApiKey).not.toHaveBeenCalled();
    });
  });
});
