import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  CreditHolderType,
  usdToCreditsStochastic as pinnedUsdToCredits,
  type CreditHoldRecord,
} from '@bike4mind/common';
import { Logger } from '@bike4mind/observability';
import { testSoundEffectProvider } from '@bike4mind/utils/audioProviders';
import {
  ProviderOutputTooLargeError,
  type ProviderOutput,
  type ProviderTerminalResult,
} from '@bike4mind/utils/generationProviders';
import { silentMp3 } from '@bike4mind/utils/musicProviders';
import { createInMemoryGenerationJobRepository } from '../generationJobs/__test__/inMemoryGenerationJobRepository';
import type { CreditHoldAdapters } from '../creditService/creditHold';
import { EXPIRED_KEY_SENTINEL } from '../modelDiscoveryService/credentials';
import { ProviderBusyError, runWithProviderCapacity } from '../providerCapacity/runWithProviderCapacity';
import { estimateSoundCredits } from '../soundCost';
import { createSoundEffectJobHandler } from './soundEffectJobHandler';
import type { SoundEffectJob, SoundEffectJobDeps, SoundEffectJobProvider } from './types';

// The real stochastic rounding with its draw pinned.
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

// creditHold is module-mocked, so the adapters are never touched.
const unusedCredits = {} as CreditHoldAdapters;

const hold: CreditHoldRecord = {
  ownerId: 'u1',
  ownerType: CreditHolderType.User,
  userId: 'u1',
  organizationId: null,
  reservedCredits: 100,
  balanceAfterHold: 900,
};

const stepContext = () => ({ signal: new AbortController().signal });

const makeJob = (payload: Partial<SoundEffectJob['payload']> = {}, fields: Partial<SoundEffectJob> = {}) =>
  ({
    id: 'job1',
    kind: 'sound_effect',
    ownerType: CreditHolderType.User,
    ownerId: 'u1',
    requestedBy: 'u1',
    source: 'api',
    state: 'pending',
    pollCount: 0,
    attempts: 0,
    cancelRequested: false,
    deadlineAt: new Date('2026-10-13T00:05:00Z'),
    creditHold: null,
    payload: {
      request: { text: 'a door slams', provider: 'elevenlabs', durationSeconds: 4 },
      providerId: 'elevenlabs',
      saveToFiles: true,
      ...payload,
    },
    ...fields,
  }) as SoundEffectJob;

const providerReturning = (result: ProviderTerminalResult) => {
  const generate = vi.fn<SoundEffectJobProvider['generate']>(async () => result);
  const provider: SoundEffectJobProvider = { ...testSoundEffectProvider, generate };
  return { provider, generate };
};

const clip = (): ProviderOutput => ({
  kind: 'inline',
  base64: silentMp3(1).toString('base64'),
  contentType: 'audio/mpeg',
});

const setup = (overrides: Partial<SoundEffectJobDeps> = {}) => {
  const repository = createInMemoryGenerationJobRepository();
  const recordSettlement = vi.spyOn(repository, 'recordSettlement');
  const deps: SoundEffectJobDeps = {
    repository,
    providers: { elevenlabs: testSoundEffectProvider },
    getSettings: async () => ({ enforceCredits: true }),
    resolveApiKey: vi.fn(async () => 'key'),
    saveToFiles: vi.fn(async ({ generation: { jobId } }: { generation: { jobId: string } }) => ({
      saved: true as const,
      fileId: `file-${jobId}`,
      s3Key: `files/${jobId}.mp3`,
      fileName: 'sfx.mp3',
    })),
    saveToGeneratedBucket: vi.fn(async ({ key }: { key: string }) => ({ s3Key: key })),
    credits: unusedCredits,
    enqueue: vi.fn(async () => undefined),
    recordUsage: vi.fn(async () => undefined),
    now: () => new Date('2026-10-13T00:00:00Z'),
    logger: new Logger({ metadata: { test: 'soundEffectJobHandler' } }),
    ...overrides,
  };
  return { deps, handler: createSoundEffectJobHandler(deps), recordSettlement };
};

beforeEach(() => {
  vi.clearAllMocks();
});

describe('sound effect job handler submit', () => {
  it('generates, stores in Files and succeeds with the output', async () => {
    const { handler, deps } = setup();
    const result = await handler.submit(makeJob(), stepContext());
    expect(result).toMatchObject({
      next: 'succeeded',
      payload: { output: { location: 'files', fileId: 'file-job1', contentType: 'audio/mpeg' } },
    });
    expect(deps.saveToFiles).toHaveBeenCalledWith(
      expect.objectContaining({
        userId: 'u1',
        contentType: 'audio/mpeg',
        generation: expect.objectContaining({
          generator: 'sound_effect',
          provider: 'elevenlabs',
          jobId: 'job1',
          prompt: 'a door slams',
          durationSeconds: 4,
        }),
      })
    );
  });

  it('forwards the request fields to the provider with the resolved key', async () => {
    const elevenlabs = providerReturning({ status: 'blocked', reason: 'stop', raw: {} });
    const { handler, deps } = setup({ providers: { elevenlabs: elevenlabs.provider } });
    const job = makeJob({
      request: {
        text: 'a door slams',
        provider: 'elevenlabs',
        durationSeconds: 4,
        promptInfluence: 0.3,
        format: 'mp3_44100_128',
      },
    });
    await handler.submit(job, stepContext());
    expect(deps.resolveApiKey).toHaveBeenCalledWith('elevenlabs', 'u1');
    expect(elevenlabs.generate).toHaveBeenCalledWith(
      { text: 'a door slams', durationSeconds: 4, promptInfluence: 0.3, format: 'mp3_44100_128' },
      {},
      expect.objectContaining({ apiKey: 'key' })
    );
  });

  it('stores only in the generated bucket, keyed by owner and job, when saveToFiles is false', async () => {
    const { handler, deps } = setup();
    const result = await handler.submit(makeJob({ saveToFiles: false }), stepContext());
    expect(result).toMatchObject({
      next: 'succeeded',
      payload: { output: { location: 'generated', s3Key: 'generated-audio/u1/job1.mp3' } },
    });
    expect(deps.saveToFiles).not.toHaveBeenCalled();
    expect(deps.saveToGeneratedBucket).toHaveBeenCalledWith(
      expect.objectContaining({ key: 'generated-audio/u1/job1.mp3' })
    );
  });

  it('gives a bucket-only store a fresh budget once the step signal has fired', async () => {
    const controller = new AbortController();
    // The provider honours the signal, so it fires once the clip is fetched: the step budget ran out mid-store.
    const abortingProvider: SoundEffectJobProvider = {
      ...testSoundEffectProvider,
      fetchOutput: async (output, ctx) => {
        const bytes = await testSoundEffectProvider.fetchOutput(output, ctx);
        controller.abort();
        return bytes;
      },
    };
    const { deps, handler } = setup({ providers: { elevenlabs: abortingProvider } });
    await handler.submit(makeJob({ saveToFiles: false }), { signal: controller.signal });
    const [{ signal }] = vi.mocked(deps.saveToGeneratedBucket).mock.calls[0];
    expect(signal.aborted).toBe(false);
  });

  it('falls back to the generated bucket when Files refuses the clip', async () => {
    const { handler } = setup({
      saveToFiles: vi.fn(async () => ({ saved: false as const, reason: 'storage_limit' as const })),
    });
    expect(await handler.submit(makeJob(), stepContext())).toMatchObject({
      next: 'succeeded',
      payload: { output: { location: 'generated', s3Key: 'generated-audio/u1/job1.mp3' } },
    });
  });

  it('fails a job whose provider is not registered', async () => {
    const { handler } = setup({ providers: {} });
    expect(await handler.submit(makeJob(), stepContext())).toMatchObject({
      next: 'failed',
      error: { code: 'provider_error', message: "sound-effect provider 'elevenlabs' is not registered" },
    });
  });

  it.each([
    ['no key', null],
    ['an expired key', EXPIRED_KEY_SENTINEL],
  ])('fails without calling the provider when there is %s', async (_label, key) => {
    const elevenlabs = providerReturning({ status: 'succeeded', output: clip() });
    const { handler } = setup({
      providers: { elevenlabs: elevenlabs.provider },
      resolveApiKey: vi.fn(async () => key),
    });
    expect(await handler.submit(makeJob(), stepContext())).toMatchObject({
      next: 'failed',
      error: { code: 'provider_error', message: 'No API key configured for elevenlabs' },
    });
    expect(elevenlabs.generate).not.toHaveBeenCalled();
  });

  it('retries when the key lookup throws, before anything reaches the provider', async () => {
    const elevenlabs = providerReturning({ status: 'succeeded', output: clip() });
    const { handler } = setup({
      providers: { elevenlabs: elevenlabs.provider },
      resolveApiKey: vi.fn(async () => {
        throw new Error('db blip');
      }),
    });
    expect(await handler.submit(makeJob(), stepContext())).toEqual({ next: 'retry', reason: 'db blip' });
    expect(elevenlabs.generate).not.toHaveBeenCalled();
  });

  it('ends a blocked outcome as content_blocked with the raw payload', async () => {
    const { handler } = setup();
    const job = makeJob({ request: { text: 'x [blocked]', provider: 'elevenlabs' } });
    expect(await handler.submit(job, stepContext())).toMatchObject({
      next: 'blocked',
      error: { code: 'content_blocked' },
      rawProviderError: { text: 'x [blocked]' },
    });
  });

  it('bounds a huge raw provider payload', async () => {
    const huge = providerReturning({
      status: 'failed',
      retryable: false,
      message: 'bad',
      raw: { a: 'a'.repeat(50_000) },
    });
    const { handler } = setup({ providers: { elevenlabs: huge.provider } });
    const result = await handler.submit(makeJob(), stepContext());
    if (result.next !== 'failed') throw new Error('expected a failure');
    expect(String(result.rawProviderError)).toContain('truncated');
  });

  it('fails a non-retryable failure as provider_error', async () => {
    const { handler } = setup();
    const job = makeJob({ request: { text: 'x [fail]', provider: 'elevenlabs' } });
    expect(await handler.submit(job, stepContext())).toMatchObject({
      next: 'failed',
      error: { code: 'provider_error', message: 'test provider failure' },
      rawProviderError: { text: 'x [fail]' },
    });
  });

  it('keeps the provider status of a refusal on the job error', async () => {
    const elevenlabs = providerReturning({
      status: 'failed',
      retryable: false,
      message: 'elevenlabs_sound_effect_http_400',
      raw: { status: 400, snippet: 'bad' },
    });
    const { handler } = setup({ providers: { elevenlabs: elevenlabs.provider } });
    expect(await handler.submit(makeJob(), stepContext())).toMatchObject({
      next: 'failed',
      error: { code: 'provider_error', providerStatus: 400 },
    });
  });

  it('fails a rate limit at once, as a 429 with a Retry-After, instead of retrying past the inline wait', async () => {
    const { handler } = setup();
    const job = makeJob({ request: { text: 'x [retry]', provider: 'elevenlabs' } });
    expect(await handler.submit(job, stepContext())).toEqual({
      next: 'failed',
      error: {
        code: 'provider_error',
        message: 'test provider rate limited',
        providerStatus: 429,
        retryAfterSeconds: 30,
      },
      rawProviderError: { text: 'x [retry]' },
    });
  });

  it('lets a thrown generate propagate, so the engine fails it as an orphaned submit', async () => {
    const { handler } = setup();
    const job = makeJob({ request: { text: 'x [throw]', provider: 'elevenlabs' } });
    await expect(handler.submit(job, stepContext())).rejects.toThrow('test provider transport failure');
  });

  it('fails an output the provider reports as too large', async () => {
    const elevenlabs = providerReturning({ status: 'succeeded', output: clip() });
    elevenlabs.provider.fetchOutput = vi.fn(async () => {
      throw new ProviderOutputTooLargeError(1000, 2000);
    });
    const { handler, deps } = setup({ providers: { elevenlabs: elevenlabs.provider } });
    expect(await handler.submit(makeJob(), stepContext())).toMatchObject({
      next: 'failed',
      error: { code: 'output_too_large' },
    });
    expect(deps.saveToFiles).not.toHaveBeenCalled();
  });

  it('never reaches poll or store: each fails the job and logs', async () => {
    const { handler, deps } = setup();
    const error = vi.spyOn(deps.logger, 'error');
    const job = makeJob();
    expect(await handler.poll(job, stepContext())).toMatchObject({ next: 'failed', error: { code: 'provider_error' } });
    expect(await handler.store(job, stepContext())).toMatchObject({
      next: 'failed',
      error: { code: 'provider_error' },
    });
    expect(error).toHaveBeenCalledWith('sound_effect_job_unexpected_step', expect.objectContaining({ step: 'poll' }));
  });

  it('has nothing to cancel at the provider', async () => {
    const { handler } = setup();
    await expect(handler.cancelAtProvider(makeJob(), stepContext())).resolves.toBeUndefined();
  });
});

describe('sound effect job handler capacity', () => {
  const rateLimited: ProviderTerminalResult = {
    status: 'failed',
    retryable: true,
    message: 'elevenlabs_sound_effect_rate_limited',
    raw: { status: 429, snippet: 'busy' },
  };

  // The real capacity runner, unslotted and without real backoff waits.
  const runWithCapacity: SoundEffectJobDeps['runWithCapacity'] = (_apiKey, attempt) =>
    runWithProviderCapacity(
      {
        provider: 'elevenlabs',
        logger: new Logger({ metadata: { test: 'capacity' } }),
        budgetMs: 45_000,
        maxSlotWaitMs: 15_000,
        minAttemptMs: 15_000,
        maxRetries: 2,
        retryBaseDelayMs: 1_000,
        sleep: async () => undefined,
      },
      attempt
    );

  it('runs the provider call in the capacity slots with the resolved key', async () => {
    const elevenlabs = providerReturning({ status: 'succeeded', output: clip() });
    const wrapped = vi.fn(runWithCapacity);
    const { handler } = setup({ providers: { elevenlabs: elevenlabs.provider }, runWithCapacity: wrapped });
    const step = stepContext();
    expect(await handler.submit(makeJob(), step)).toMatchObject({ next: 'succeeded' });
    expect(wrapped).toHaveBeenCalledWith('key', expect.any(Function));
    // Each attempt is bounded by the wrapper's remaining budget as well as the step.
    const [, , ctx] = elevenlabs.generate.mock.calls[0];
    expect(ctx.signal).not.toBe(step.signal);
  });

  it('retries a 429 inside the wrapper budget', async () => {
    const elevenlabs = providerReturning({ status: 'succeeded', output: clip() });
    elevenlabs.generate.mockResolvedValueOnce(rateLimited);
    const { handler } = setup({ providers: { elevenlabs: elevenlabs.provider }, runWithCapacity });
    expect(await handler.submit(makeJob(), stepContext())).toMatchObject({ next: 'succeeded' });
    expect(elevenlabs.generate).toHaveBeenCalledTimes(2);
  });

  it('fails as rate limited, with the wrapper Retry-After, once the 429s outlast the retries', async () => {
    const elevenlabs = providerReturning(rateLimited);
    const { handler } = setup({ providers: { elevenlabs: elevenlabs.provider }, runWithCapacity });
    const result = await handler.submit(makeJob(), stepContext());
    expect(result).toMatchObject({ next: 'failed', error: { code: 'provider_error', providerStatus: 429 } });
    expect(result).toHaveProperty('error.retryAfterSeconds', expect.any(Number));
    expect(elevenlabs.generate).toHaveBeenCalledTimes(3);
  });

  it('fails as rate limited when no slot frees up, without calling the provider', async () => {
    const elevenlabs = providerReturning({ status: 'succeeded', output: clip() });
    const { handler } = setup({
      providers: { elevenlabs: elevenlabs.provider },
      runWithCapacity: async () => {
        throw new ProviderBusyError('elevenlabs', 'slots_exhausted', 5);
      },
    });
    expect(await handler.submit(makeJob(), stepContext())).toMatchObject({
      next: 'failed',
      error: { code: 'provider_error', providerStatus: 429, retryAfterSeconds: 5 },
    });
    expect(elevenlabs.generate).not.toHaveBeenCalled();
  });

  it('lets any other throw from the wrapper propagate as an unknown outcome', async () => {
    const { handler } = setup({
      runWithCapacity: async () => {
        throw new Error('socket hang up');
      },
    });
    await expect(handler.submit(makeJob(), stepContext())).rejects.toThrow('socket hang up');
  });
});

describe('sound effect job handler onTerminal', () => {
  const succeededJob = (fields: Partial<SoundEffectJob> = {}) =>
    makeJob({}, { state: 'succeeded', creditHold: hold, ...fields });

  it('settles a success at the duration-driven price and records usage', async () => {
    const { handler, deps, recordSettlement } = setup();
    const job = succeededJob();
    await handler.onTerminal(job);
    const { usdCost, billedSeconds } = estimateSoundCredits('elevenlabs', { durationSeconds: 4 });
    const credits = pinnedUsdToCredits(usdCost);
    expect(settleCreditHold).toHaveBeenCalledWith(
      hold,
      credits,
      { type: 'sound_effects_usage', sessionId: 'job1', model: 'elevenlabs' },
      expect.objectContaining({ featureLabel: 'sound generation' }),
      unusedCredits
    );
    expect(recordSettlement).toHaveBeenCalledWith('job1', credits);
    expect(releaseCreditHold).not.toHaveBeenCalled();
    expect(deps.recordUsage).toHaveBeenCalledWith({ job, billedSeconds, creditsCharged: credits, costUsd: usdCost });
  });

  it('keys the ledger entry on the notebook, else the quest, else the job', async () => {
    const { handler } = setup();
    const withSession = makeJob({ sessionId: 's1' }, { state: 'succeeded', creditHold: hold, questId: 'q1' });
    await handler.onTerminal(withSession);
    await handler.onTerminal(succeededJob({ questId: 'q1' }));
    expect(vi.mocked(settleCreditHold).mock.calls[0][2]).toMatchObject({ sessionId: 's1' });
    expect(vi.mocked(settleCreditHold).mock.calls[1][2]).toMatchObject({ sessionId: 'q1' });
  });

  it('settles nothing without a hold, but still records the settlement', async () => {
    const { handler, recordSettlement } = setup();
    await handler.onTerminal(succeededJob({ creditHold: null }));
    expect(settleCreditHold).not.toHaveBeenCalled();
    expect(recordSettlement).toHaveBeenCalledWith('job1', 0);
  });

  it('keeps the full hold and records no usage when pricing fails', async () => {
    const { handler, deps } = setup();
    const error = vi.spyOn(deps.logger, 'error');
    // An unregistered vendor has no cost calculator.
    const job = makeJob(
      { providerId: 'nope' as never, request: { text: 'x', provider: 'nope' as never } },
      { state: 'succeeded', creditHold: hold }
    );
    await handler.onTerminal(job);
    expect(vi.mocked(settleCreditHold).mock.calls[0][1]).toBeNaN();
    expect(error).toHaveBeenCalledWith('sound_effect_job_estimate_failed', expect.objectContaining({ jobId: 'job1' }));
    expect(deps.recordUsage).not.toHaveBeenCalled();
  });

  it('logs a usage-recording failure instead of throwing', async () => {
    const { handler, deps } = setup({
      recordUsage: vi.fn(async () => {
        throw new Error('analytics down');
      }),
    });
    const error = vi.spyOn(deps.logger, 'error');
    await expect(handler.onTerminal(succeededJob())).resolves.toBeUndefined();
    expect(error).toHaveBeenCalledWith(
      'sound_effect_job_record_usage_failed',
      expect.objectContaining({ jobId: 'job1', error: expect.any(Error) })
    );
  });

  it.each(['failed', 'blocked', 'cancelled'] as const)('releases the hold of a %s job', async state => {
    const { handler, deps, recordSettlement } = setup();
    await handler.onTerminal(makeJob({}, { state, creditHold: hold }));
    expect(releaseCreditHold).toHaveBeenCalledWith(hold, unusedCredits);
    expect(settleCreditHold).not.toHaveBeenCalled();
    expect(recordSettlement).toHaveBeenCalledWith('job1', 0);
    expect(deps.recordUsage).not.toHaveBeenCalled();
  });
});
