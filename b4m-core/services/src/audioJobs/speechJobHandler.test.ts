import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  computeTtsUsd,
  CreditHolderType,
  usdToCreditsStochastic as pinnedUsdToCredits,
  type CreditHoldRecord,
} from '@bike4mind/common';
import { Logger } from '@bike4mind/observability';
import { testSpeechProvider } from '@bike4mind/utils/audioProviders';
import {
  ProviderOutputTooLargeError,
  type ProviderOutput,
  type ProviderTerminalResult,
} from '@bike4mind/utils/generationProviders';
import { silentMp3 } from '@bike4mind/utils/musicProviders';
import { createInMemoryGenerationJobRepository } from '../generationJobs/__test__/inMemoryGenerationJobRepository';
import type { CreditHoldAdapters } from '../creditService/creditHold';
import { EXPIRED_KEY_SENTINEL } from '../modelDiscoveryService/credentials';
import { createSpeechJobHandler } from './speechJobHandler';
import type { SpeechJob, SpeechJobDeps, SpeechJobProvider } from './types';

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

const makeJob = (payload: Partial<SpeechJob['payload']> = {}, fields: Partial<SpeechJob> = {}): SpeechJob => ({
  id: 'job1',
  kind: 'speech',
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
    request: { text: 'hello there', provider: 'openai' },
    candidates: ['openai'],
    saveToFiles: true,
    ...payload,
  },
  ...fields,
});

// The test provider with its generate replaced, so a test controls one vendor's outcome.
const providerReturning = (result: ProviderTerminalResult | (() => never)) => {
  const generate = vi.fn<SpeechJobProvider['generate']>(async () => (typeof result === 'function' ? result() : result));
  const provider: SpeechJobProvider = { ...testSpeechProvider, generate };
  return { provider, generate };
};

const testSpeechProviderOutput = (): ProviderOutput => ({
  kind: 'inline',
  base64: silentMp3(1).toString('base64'),
  contentType: 'audio/mpeg',
});

const rejectedKey: ProviderTerminalResult = {
  status: 'failed',
  retryable: false,
  message: 'invalid api key',
  raw: { status: 401 },
};

const setup = (overrides: Partial<SpeechJobDeps> = {}) => {
  const repository = createInMemoryGenerationJobRepository();
  const recordSettlement = vi.spyOn(repository, 'recordSettlement');
  const deps: SpeechJobDeps = {
    repository,
    providers: { openai: testSpeechProvider, elevenlabs: testSpeechProvider },
    getSettings: async () => ({ enforceCredits: true }),
    resolveApiKey: vi.fn(async () => 'key'),
    resolveVoice: vi.fn(async ({ vendor, requestedVoice }) => requestedVoice ?? `${vendor}-default-voice`),
    saveToFiles: vi.fn(async ({ generation: { jobId } }: { generation: { jobId: string } }) => ({
      saved: true as const,
      fileId: `file-${jobId}`,
      s3Key: `files/${jobId}.mp3`,
      fileName: 'clip.mp3',
    })),
    saveToGeneratedBucket: vi.fn(async ({ key }: { key: string }) => ({ s3Key: key })),
    credits: unusedCredits,
    enqueue: vi.fn(async () => undefined),
    recordUsage: vi.fn(async () => undefined),
    now: () => new Date('2026-10-13T00:00:00Z'),
    logger: new Logger({ metadata: { test: 'speechJobHandler' } }),
    ...overrides,
  };
  return { deps, handler: createSpeechJobHandler(deps), recordSettlement };
};

beforeEach(() => {
  vi.clearAllMocks();
});

describe('speech job handler submit', () => {
  it('synthesizes, stores in Files and succeeds with the output and producedBy', async () => {
    const { handler, deps } = setup();
    const job = makeJob();
    const result = await handler.submit(job, stepContext());
    expect(result).toMatchObject({
      next: 'succeeded',
      payload: {
        producedBy: { provider: 'openai', model: 'gpt-4o-mini-tts' },
        output: { location: 'files', fileId: 'file-job1', contentType: 'audio/mpeg' },
      },
    });
    if (result.next !== 'succeeded') throw new Error('expected success');
    expect(result.payload.output?.durationSeconds).toBeCloseTo(1, 1);
    expect(deps.saveToFiles).toHaveBeenCalledWith(
      expect.objectContaining({
        userId: 'u1',
        contentType: 'audio/mpeg',
        generation: expect.objectContaining({
          generator: 'speech',
          provider: 'openai',
          modelId: 'gpt-4o-mini-tts',
          jobId: 'job1',
          prompt: 'hello there',
        }),
      })
    );
  });

  it('bills the requested model when the requested vendor serves the call', async () => {
    const { handler } = setup();
    const job = makeJob({ request: { text: 'hello there', provider: 'openai', model: 'tts-1' } });
    expect(await handler.submit(job, stepContext())).toMatchObject({
      next: 'succeeded',
      payload: { producedBy: { provider: 'openai', model: 'tts-1' } },
    });
  });

  it('forwards the requested voice, model and format to the requested vendor', async () => {
    const openai = providerReturning({ status: 'blocked', reason: 'stop', raw: {} });
    const { handler } = setup({ providers: { openai: openai.provider } });
    const job = makeJob({
      request: { text: 'hello there', provider: 'openai', model: 'tts-1', voice: 'nova', format: 'wav' },
    });
    await handler.submit(job, stepContext());
    expect(openai.generate).toHaveBeenCalledWith(
      expect.objectContaining({ text: 'hello there', voice: 'nova', model: 'tts-1', format: 'wav' }),
      {},
      expect.objectContaining({ apiKey: 'key' })
    );
  });

  it('passes the stored voice preference to the voice resolver', async () => {
    const { handler, deps } = setup();
    await handler.submit(makeJob({ preferredVoice: 'marin' }), stepContext());
    expect(deps.resolveVoice).toHaveBeenCalledWith({ vendor: 'openai', userId: 'u1', preferredVoice: 'marin' });
  });

  describe('fallback to the next candidate', () => {
    const fallbackPayload = (request: Partial<SpeechJob['payload']['request']> = {}) => ({
      request: { text: 'hello there', provider: 'openai' as const, model: 'tts-1', voice: 'nova', ...request },
      candidates: ['openai' as const, 'elevenlabs' as const],
    });

    it('skips a requested vendor without a key and attributes the clip to the alternate', async () => {
      const elevenlabs = providerReturning({
        status: 'succeeded',
        output: testSpeechProviderOutput(),
      });
      const { handler, deps } = setup({
        providers: { openai: testSpeechProvider, elevenlabs: elevenlabs.provider },
        resolveApiKey: vi.fn(async vendor => (vendor === 'openai' ? null : 'el-key')),
      });
      const result = await handler.submit(makeJob(fallbackPayload()), stepContext());
      expect(result).toMatchObject({
        next: 'succeeded',
        payload: { producedBy: { provider: 'elevenlabs', model: 'eleven_multilingual_v2' } },
      });
      expect(deps.saveToFiles).toHaveBeenCalledWith(
        expect.objectContaining({
          generation: expect.objectContaining({ provider: 'elevenlabs', modelId: 'eleven_multilingual_v2' }),
        })
      );
    });

    it('does not forward the requested voice or model to the alternate, and drops an unsupported format', async () => {
      const elevenlabs = providerReturning({ status: 'blocked', reason: 'stop', raw: {} });
      const { handler, deps } = setup({
        providers: { openai: testSpeechProvider, elevenlabs: elevenlabs.provider },
        resolveApiKey: vi.fn(async vendor => (vendor === 'openai' ? null : 'el-key')),
      });
      await handler.submit(makeJob(fallbackPayload({ format: 'wav' })), stepContext());
      expect(deps.resolveVoice).toHaveBeenCalledWith({ vendor: 'elevenlabs', userId: 'u1' });
      const [sent] = elevenlabs.generate.mock.calls[0];
      expect(sent.model).toBeUndefined();
      expect(sent.format).toBeUndefined();
      expect(sent.voice).toBe('elevenlabs-default-voice');
    });

    it('keeps a format the alternate supports', async () => {
      const elevenlabs = providerReturning({ status: 'blocked', reason: 'stop', raw: {} });
      const { handler } = setup({
        providers: { openai: testSpeechProvider, elevenlabs: elevenlabs.provider },
        resolveApiKey: vi.fn(async vendor => (vendor === 'openai' ? null : 'el-key')),
      });
      await handler.submit(makeJob(fallbackPayload({ format: 'opus' })), stepContext());
      expect(elevenlabs.generate.mock.calls[0][0].format).toBe('opus');
    });

    it('omits the requested voice from the saved generation once an alternate stood in', async () => {
      const { handler, deps } = setup({
        resolveApiKey: vi.fn(async vendor => (vendor === 'openai' ? null : 'el-key')),
      });
      await handler.submit(makeJob(fallbackPayload()), stepContext());
      const [{ generation }] = vi.mocked(deps.saveToFiles).mock.calls[0];
      expect(generation).not.toHaveProperty('voice');
    });

    it('falls back when the requested vendor rejects its credential, without blocking on the 401', async () => {
      const openai = providerReturning(rejectedKey);
      const { handler } = setup({ providers: { openai: openai.provider, elevenlabs: testSpeechProvider } });
      const result = await handler.submit(makeJob(fallbackPayload()), stepContext());
      expect(openai.generate).toHaveBeenCalledTimes(1);
      expect(result).toMatchObject({ next: 'succeeded', payload: { producedBy: { provider: 'elevenlabs' } } });
    });

    it('treats a 403 as a credential rejection too', async () => {
      const openai = providerReturning({ ...rejectedKey, raw: { status: 403 } });
      const { handler } = setup({ providers: { openai: openai.provider, elevenlabs: testSpeechProvider } });
      const result = await handler.submit(makeJob(fallbackPayload()), stepContext());
      expect(result).toMatchObject({ next: 'succeeded', payload: { producedBy: { provider: 'elevenlabs' } } });
    });

    it('skips a candidate whose provider is not registered', async () => {
      const { handler } = setup({ providers: { elevenlabs: testSpeechProvider } });
      const result = await handler.submit(makeJob(fallbackPayload()), stepContext());
      expect(result).toMatchObject({ next: 'succeeded', payload: { producedBy: { provider: 'elevenlabs' } } });
    });

    it('does not try the alternate after the requested vendor blocked the text', async () => {
      const openai = providerReturning({ status: 'blocked', reason: 'stop', raw: { flagged: true } });
      const elevenlabs = providerReturning({ status: 'blocked', reason: 'stop', raw: {} });
      const { handler } = setup({ providers: { openai: openai.provider, elevenlabs: elevenlabs.provider } });
      await handler.submit(makeJob(fallbackPayload()), stepContext());
      expect(elevenlabs.generate).not.toHaveBeenCalled();
    });

    it('fails with the first candidate failure when every candidate is unusable', async () => {
      const { handler } = setup({ resolveApiKey: vi.fn(async () => null) });
      expect(await handler.submit(makeJob(fallbackPayload()), stepContext())).toMatchObject({
        next: 'failed',
        error: { code: 'provider_error', message: 'No API key configured for openai' },
      });
    });

    it('fails with the first rejection when every candidate rejects its key', async () => {
      const openai = providerReturning({ ...rejectedKey, message: 'openai key bad' });
      const elevenlabs = providerReturning({ ...rejectedKey, message: 'elevenlabs key bad' });
      const { handler } = setup({ providers: { openai: openai.provider, elevenlabs: elevenlabs.provider } });
      expect(await handler.submit(makeJob(fallbackPayload()), stepContext())).toMatchObject({
        next: 'failed',
        error: { code: 'provider_error', message: 'openai key bad' },
        rawProviderError: { status: 401 },
      });
    });

    it('treats an expired key sentinel as no key', async () => {
      const { handler } = setup({
        resolveApiKey: vi.fn(async vendor => (vendor === 'openai' ? EXPIRED_KEY_SENTINEL : 'el-key')),
      });
      expect(await handler.submit(makeJob(fallbackPayload()), stepContext())).toMatchObject({
        next: 'succeeded',
        payload: { producedBy: { provider: 'elevenlabs' } },
      });
    });
  });

  it('fails when the job has no candidates at all', async () => {
    const { handler } = setup();
    expect(await handler.submit(makeJob({ candidates: [] }), stepContext())).toMatchObject({
      next: 'failed',
      error: { code: 'provider_error', message: 'No text-to-speech provider is available' },
    });
  });

  it('ends a blocked outcome as content_blocked with the bounded raw payload', async () => {
    const { handler } = setup();
    const job = makeJob({ request: { text: 'x [blocked]', provider: 'openai' } });
    expect(await handler.submit(job, stepContext())).toMatchObject({
      next: 'blocked',
      error: { code: 'content_blocked' },
      rawProviderError: { text: 'x [blocked]' },
    });
  });

  it('bounds a huge raw provider payload', async () => {
    const huge = providerReturning({ status: 'blocked', reason: 'stop', raw: { echoed: 'a'.repeat(50_000) } });
    const { handler } = setup({ providers: { openai: huge.provider } });
    const result = await handler.submit(makeJob(), stepContext());
    if (result.next !== 'blocked') throw new Error('expected a block');
    expect(String(result.rawProviderError)).toContain('truncated');
  });

  it('fails a non-retryable failure as provider_error', async () => {
    const { handler } = setup();
    const job = makeJob({ request: { text: 'x [fail]', provider: 'openai' } });
    expect(await handler.submit(job, stepContext())).toMatchObject({
      next: 'failed',
      error: { code: 'provider_error', message: 'test provider failure' },
      rawProviderError: { text: 'x [fail]' },
    });
  });

  it('does not fall back after a non-credential failure', async () => {
    const elevenlabs = providerReturning({ status: 'blocked', reason: 'stop', raw: {} });
    const { handler } = setup({ providers: { openai: testSpeechProvider, elevenlabs: elevenlabs.provider } });
    const job = makeJob({
      request: { text: 'x [fail]', provider: 'openai' },
      candidates: ['openai', 'elevenlabs'],
    });
    await handler.submit(job, stepContext());
    expect(elevenlabs.generate).not.toHaveBeenCalled();
  });

  it('retries a retryable failure', async () => {
    const { handler } = setup();
    const job = makeJob({ request: { text: 'x [retry]', provider: 'openai' } });
    expect(await handler.submit(job, stepContext())).toEqual({
      next: 'retry',
      reason: 'test provider rate limited',
    });
  });

  it('lets a thrown generate propagate, so the engine fails it as an orphaned submit', async () => {
    const { handler } = setup();
    const job = makeJob({ request: { text: 'x [throw]', provider: 'openai' } });
    await expect(handler.submit(job, stepContext())).rejects.toThrow('test provider transport failure');
  });

  it('retries when preparing the call throws, before anything reaches a provider', async () => {
    const openai = providerReturning({ status: 'blocked', reason: 'stop', raw: {} });
    const { handler } = setup({
      providers: { openai: openai.provider },
      resolveApiKey: vi.fn(async () => {
        throw new Error('db blip');
      }),
    });
    expect(await handler.submit(makeJob(), stepContext())).toEqual({ next: 'retry', reason: 'db blip' });
    expect(openai.generate).not.toHaveBeenCalled();
  });

  it('retries when the voice lookup throws', async () => {
    const { handler } = setup({
      resolveVoice: vi.fn(async () => {
        throw new Error('voice lookup down');
      }),
    });
    expect(await handler.submit(makeJob(), stepContext())).toEqual({ next: 'retry', reason: 'voice lookup down' });
  });

  it('fails an output the provider reports as too large', async () => {
    const openai = providerReturning({ status: 'succeeded', output: testSpeechProviderOutput() });
    openai.provider.fetchOutput = vi.fn(async () => {
      throw new ProviderOutputTooLargeError(1000, 2000);
    });
    const { handler, deps } = setup({ providers: { openai: openai.provider } });
    expect(await handler.submit(makeJob(), stepContext())).toMatchObject({
      next: 'failed',
      error: { code: 'output_too_large', message: 'provider output exceeds 1000 bytes (got at least 2000)' },
    });
    expect(deps.saveToFiles).not.toHaveBeenCalled();
  });

  describe('storage', () => {
    it('stores only in the generated bucket, keyed by owner and job, when saveToFiles is false', async () => {
      const { handler, deps } = setup();
      const result = await handler.submit(makeJob({ saveToFiles: false }), stepContext());
      expect(result).toMatchObject({
        next: 'succeeded',
        payload: { output: { location: 'generated', s3Key: 'generated-audio/u1/job1.mp3', contentType: 'audio/mpeg' } },
      });
      expect(deps.saveToFiles).not.toHaveBeenCalled();
      expect(deps.saveToGeneratedBucket).toHaveBeenCalledWith(
        expect.objectContaining({ key: 'generated-audio/u1/job1.mp3', contentType: 'audio/mpeg' })
      );
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
    expect(error).toHaveBeenCalledWith('speech_job_unexpected_step', expect.objectContaining({ step: 'poll' }));
    expect(error).toHaveBeenCalledWith('speech_job_unexpected_step', expect.objectContaining({ step: 'store' }));
  });

  it('has nothing to cancel at the provider', async () => {
    const { handler } = setup();
    await expect(handler.cancelAtProvider(makeJob(), stepContext())).resolves.toBeUndefined();
  });
});

describe('speech job handler onTerminal', () => {
  const succeededJob = (fields: Partial<SpeechJob> = {}, payload: Partial<SpeechJob['payload']> = {}) =>
    makeJob(
      { producedBy: { provider: 'openai', model: 'tts-1-hd' }, ...payload },
      { state: 'succeeded', creditHold: hold, ...fields }
    );

  it('settles a success at the produced model price against the hold and records usage', async () => {
    const { handler, deps, recordSettlement } = setup();
    const job = succeededJob();
    await handler.onTerminal(job);
    const usd = computeTtsUsd('openai', 'tts-1-hd', 'hello there'.length);
    const credits = pinnedUsdToCredits(usd);
    expect(settleCreditHold).toHaveBeenCalledWith(
      hold,
      credits,
      { type: 'text_to_speech_usage', sessionId: 'job1', model: 'tts-1-hd' },
      expect.objectContaining({ featureLabel: 'text-to-speech' }),
      unusedCredits
    );
    expect(recordSettlement).toHaveBeenCalledWith('job1', credits);
    expect(releaseCreditHold).not.toHaveBeenCalled();
    expect(deps.recordUsage).toHaveBeenCalledWith({
      job,
      provider: 'openai',
      model: 'tts-1-hd',
      characters: 'hello there'.length,
      creditsCharged: credits,
      costUsd: usd,
    });
  });

  it('keys the ledger entry on the notebook, else the quest, else the job', async () => {
    const { handler } = setup();
    await handler.onTerminal(succeededJob({ questId: 'q1' }, { sessionId: 's1' }));
    await handler.onTerminal(succeededJob({ questId: 'q1' }));
    expect(vi.mocked(settleCreditHold).mock.calls[0][2]).toMatchObject({ sessionId: 's1' });
    expect(vi.mocked(settleCreditHold).mock.calls[1][2]).toMatchObject({ sessionId: 'q1' });
  });

  it('prices an alternate vendor on its own default model', async () => {
    const { handler, deps } = setup();
    await handler.onTerminal(
      succeededJob({}, { producedBy: { provider: 'elevenlabs', model: 'eleven_multilingual_v2' } })
    );
    expect(deps.recordUsage).toHaveBeenCalledWith(
      expect.objectContaining({
        provider: 'elevenlabs',
        costUsd: computeTtsUsd('elevenlabs', 'eleven_multilingual_v2', 'hello there'.length),
      })
    );
  });

  it('keeps the full hold when a success carries no producedBy, and records no usage', async () => {
    const { handler, deps, recordSettlement } = setup();
    await handler.onTerminal(succeededJob({}, { producedBy: undefined }));
    expect(vi.mocked(settleCreditHold).mock.calls[0][1]).toBeNaN();
    expect(recordSettlement).toHaveBeenCalledTimes(1);
    expect(deps.recordUsage).not.toHaveBeenCalled();
  });

  it('settles nothing without a hold, but still records the settlement and usage', async () => {
    const { handler, deps, recordSettlement } = setup();
    await handler.onTerminal(succeededJob({ creditHold: null }));
    expect(settleCreditHold).not.toHaveBeenCalled();
    expect(recordSettlement).toHaveBeenCalledWith('job1', 0);
    expect(deps.recordUsage).toHaveBeenCalledWith(expect.objectContaining({ creditsCharged: 0 }));
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
      'speech_job_record_usage_failed',
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

  it('records a zero settlement for a failed job that never held credits', async () => {
    const { handler, recordSettlement } = setup();
    await handler.onTerminal(makeJob({}, { state: 'failed' }));
    expect(releaseCreditHold).not.toHaveBeenCalled();
    expect(recordSettlement).toHaveBeenCalledWith('job1', 0);
  });
});
