import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  CREDITS_PER_USD_COST,
  CreditHolderType,
  estimateMusicCostCredits,
  estimateMusicCostUsd,
  MUSIC_MODEL_CATALOG,
  MUSIC_MODEL_IDS,
  type MusicModelId,
  type MusicProviderId,
} from '@bike4mind/common';
import {
  createMusicProviderRegistry,
  ProviderOutputTooLargeError,
  ProviderSubmitError,
  silentMp3,
  TestMusicProvider,
  type MusicProvider,
  type ProviderTerminalResult,
} from '@bike4mind/utils/musicProviders';
import { Logger } from '@bike4mind/observability';
import { createInMemoryGenerationJobRepository } from '../generationJobs/__test__/inMemoryGenerationJobRepository';
import { GenerationJobEngine } from '../generationJobs/engine';
import type { CreditHoldAdapters } from '../creditService/creditHold';
import { createMusicJob } from './createMusicJob';
import { createMusicJobHandler } from './musicJobHandler';
import type { CreateMusicJobDeps, CreateMusicJobResult } from './types';

// The real stochastic rounding with its draw pinned. estimateMusicCostUsd is wrapped so a test can price one
// settlement off-catalog (the catalog's per-second rates never land on a half credit).
const { settlementDraw } = vi.hoisted(() => ({ settlementDraw: vi.fn(() => 0.5) }));
vi.mock('@bike4mind/common', async importOriginal => {
  const actual = await importOriginal<typeof import('@bike4mind/common')>();
  return {
    ...actual,
    estimateMusicCostUsd: vi.fn(actual.estimateMusicCostUsd),
    usdToCreditsStochastic: (usd: number) => actual.usdToCreditsStochastic(usd, () => settlementDraw()),
  };
});

vi.mock('../creditService/creditHold', () => ({
  holdCredits: vi.fn(),
  releaseCreditHold: vi.fn(async () => undefined),
  settleCreditHold: vi.fn(async (_hold: unknown, charged: number) => charged),
}));
import { holdCredits, releaseCreditHold, settleCreditHold } from '../creditService/creditHold';

// creditHold is module-mocked, so the adapters are never touched.
const unusedCredits = {} as CreditHoldAdapters;

const setup = (overrides: Partial<CreateMusicJobDeps> = {}) => {
  let clock = new Date('2026-10-13T00:00:00Z');
  const repository = createInMemoryGenerationJobRepository({ now: () => clock });
  const commit = vi.spyOn(repository, 'commit');
  const queue: string[] = [];
  const deps: CreateMusicJobDeps = {
    assertModelAdmission: vi.fn(async () => {}),
    repository,
    providers: createMusicProviderRegistry([new TestMusicProvider()]),
    getSettings: async () => ({ enforceCredits: true, musicGeneration: undefined }),
    resolveApiKey: async () => 'key',
    checkStorageFor: async () => undefined,
    saveToFiles: vi.fn(async ({ generation: { jobId } }: { generation: { jobId: string } }) => ({
      saved: true as const,
      fileId: `file-${jobId}`,
      s3Key: `files/${jobId}.mp3`,
      fileName: 'song.mp3',
    })),
    saveToGeneratedBucket: vi.fn(async ({ key }: { key: string }) => ({ s3Key: key })),
    credits: unusedCredits,
    enqueue: vi.fn(async (jobId: string) => {
      queue.push(jobId);
    }),
    recordUsage: vi.fn(async () => undefined),
    now: () => clock,
    logger: new Logger({ metadata: { test: 'musicJobHandler' } }),
    engine: { failBeforeStart: (jobId, error) => engine.failBeforeStart(jobId, error) },
    ...overrides,
  };
  const engine = new GenerationJobEngine({
    repository,
    handlers: [createMusicJobHandler(deps)],
    enqueue: deps.enqueue,
    notify: async () => undefined,
    now: () => clock,
    logger: deps.logger,
    leaseMs: 330_000,
  });
  const runToCompletion = async () => {
    for (let i = 0; i < 20 && queue.length; i++) {
      const jobId = queue.shift();
      if (!jobId) break;
      clock = new Date(clock.getTime() + 60_000);
      await engine.step(jobId);
    }
  };
  const jobOf = (created: CreateMusicJobResult) => {
    if (!created.ok) throw new Error(`createMusicJob refused: ${created.code}`);
    const job = repository.jobs.get(created.job.id);
    if (!job || job.kind !== 'music') throw new Error('music job vanished');
    return job;
  };
  return { deps, repository, engine, commit, runToCompletion, jobOf };
};

const user = { id: 'u1', organizationId: null };
const request = (prompt = 'a folk song', extra: Record<string, unknown> = {}) => ({
  model: 'test-music',
  prompt,
  durationSeconds: 5,
  ...extra,
});

const modelsOf = (provider: MusicProviderId): MusicModelId[] =>
  MUSIC_MODEL_IDS.filter(id => MUSIC_MODEL_CATALOG[id].provider === provider);

// A sync provider whose generate a test controls, registered under any catalog provider id.
type Generate = Extract<MusicProvider, { mode: 'sync' }>['generate'];

const stubProvider = (generate: Generate, id: MusicProviderId = 'test'): MusicProvider => {
  const base = new TestMusicProvider();
  return { mode: 'sync', id, models: modelsOf(id), generate, fetchOutput: base.fetchOutput.bind(base) };
};

const song = (seconds: number, extra: Partial<Extract<ProviderTerminalResult, { status: 'succeeded' }>> = {}) =>
  ({
    status: 'succeeded',
    output: { kind: 'inline', base64: silentMp3(seconds).toString('base64'), contentType: 'audio/mpeg' },
    ...extra,
  }) as const;

beforeEach(() => {
  vi.clearAllMocks();
  settlementDraw.mockReturnValue(0.5);
  vi.mocked(holdCredits).mockImplementation(async params => ({
    ownerId: params.userId,
    ownerType: CreditHolderType.User,
    userId: params.userId,
    organizationId: null,
    reservedCredits: params.requiredCredits,
    balanceAfterHold: 1000,
  }));
});

describe('music job end to end with the test provider', () => {
  it('generates and stores the song in one submit step, never committing provider bytes', async () => {
    const generate = vi.spyOn(TestMusicProvider.prototype, 'generate');
    const t = setup();
    const created = await createMusicJob({ user, request: request(), source: 'studio' }, t.deps);
    const job = t.jobOf(created);
    expect(await t.engine.step(job.id)).toBe('terminal');
    const done = t.jobOf(created);
    expect(done.state).toBe('succeeded');
    expect(done.payload.output).toMatchObject({
      location: 'files',
      fileId: `file-${job.id}`,
      contentType: 'audio/mpeg',
    });
    expect(generate).toHaveBeenCalledTimes(1);
    const audio = silentMp3(5).toString('base64');
    for (const [, update] of t.commit.mock.calls) expect(JSON.stringify(update)).not.toContain(audio.slice(0, 64));
    expect(settleCreditHold).toHaveBeenCalledTimes(1);
    expect(releaseCreditHold).not.toHaveBeenCalled();
    generate.mockRestore();
  });

  it('measures the duration from the MP3 when the provider reports none', async () => {
    const t = setup();
    const created = await createMusicJob({ user, request: request(), source: 'studio' }, t.deps);
    await t.runToCompletion();
    const job = t.jobOf(created);
    expect(job.payload.output?.durationSeconds).toBeCloseTo(5, 1);
    expect(job.payload.reportedDurationSeconds).toBeCloseTo(5, 1);
  });

  it('prefers the provider-reported duration over the measured one', async () => {
    const t = setup({
      providers: createMusicProviderRegistry([stubProvider(async () => song(5, { reportedDurationSeconds: 4 }))]),
    });
    const created = await createMusicJob({ user, request: request(), source: 'studio' }, t.deps);
    await t.runToCompletion();
    expect(t.jobOf(created).payload.output?.durationSeconds).toBe(4);
    expect(t.deps.saveToFiles).toHaveBeenCalledWith(
      expect.objectContaining({ generation: expect.objectContaining({ durationSeconds: 4 }) })
    );
  });

  it('stores the validated request with the generation', async () => {
    const t = setup();
    await createMusicJob({ user, request: request(), source: 'studio' }, t.deps);
    await t.runToCompletion();
    expect(t.deps.saveToFiles).toHaveBeenCalledWith(
      expect.objectContaining({
        generation: expect.objectContaining({ request: expect.objectContaining({ model: expect.any(String) }) }),
      })
    );
  });

  it('falls back to the requested duration when the audio cannot be measured', async () => {
    const t = setup({
      providers: createMusicProviderRegistry([
        stubProvider(async () => ({
          status: 'succeeded',
          output: { kind: 'inline', base64: Buffer.from('not audio').toString('base64'), contentType: 'audio/wav' },
        })),
      ]),
    });
    const created = await createMusicJob({ user, request: request(), source: 'studio' }, t.deps);
    await t.runToCompletion();
    const job = t.jobOf(created);
    expect(job.payload.output).toMatchObject({ durationSeconds: 5, contentType: 'audio/wav' });
    expect(job.payload.reportedDurationSeconds).toBeUndefined();
  });

  it('saves the song with its lyrics and notebook link', async () => {
    const t = setup();
    const created = await createMusicJob(
      { user, request: request('a ballad', { lyrics: 'la la la' }), source: 'agent', sessionId: 's1', questId: 'q1' },
      t.deps
    );
    await t.runToCompletion();
    const job = t.jobOf(created);
    expect(t.deps.saveToFiles).toHaveBeenCalledWith(
      expect.objectContaining({
        userId: 'u1',
        contentType: 'audio/mpeg',
        sessionId: 's1',
        questId: 'q1',
        generation: {
          generator: 'music',
          provider: 'test',
          modelId: 'test-music',
          jobId: job.id,
          prompt: 'a ballad',
          lyrics: 'la la la',
          durationSeconds: expect.closeTo(5, 1),
          request: expect.objectContaining({ model: 'test-music', prompt: 'a ballad' }),
        },
      })
    );
    expect(job.payload.output?.lyrics).toBe('la la la');
  });

  it('retries a retryable failure and then succeeds', async () => {
    const generate = vi
      .fn<Extract<MusicProvider, { mode: 'sync' }>['generate']>()
      .mockResolvedValueOnce({ status: 'failed', retryable: true, message: '429', raw: {} })
      .mockResolvedValueOnce(song(5));
    const t = setup({ providers: createMusicProviderRegistry([stubProvider(generate)]) });
    const error = vi.spyOn(t.deps.logger, 'error');
    const created = await createMusicJob({ user, request: request(), source: 'studio' }, t.deps);
    await t.runToCompletion();
    expect(t.jobOf(created).state).toBe('succeeded');
    expect(generate).toHaveBeenCalledTimes(2);
    expect(error).not.toHaveBeenCalledWith('generation_job_orphaned_submit', expect.anything());
  });

  it('retries a failure before the provider call instead of failing it as orphaned_submit', async () => {
    const generate = vi.spyOn(TestMusicProvider.prototype, 'generate');
    const resolveApiKey = vi.fn(async () => 'key');
    const t = setup({ resolveApiKey });
    const error = vi.spyOn(t.deps.logger, 'error');
    const created = await createMusicJob({ user, request: request(), source: 'studio' }, t.deps);
    resolveApiKey.mockRejectedValueOnce(new Error('db blip'));
    await t.runToCompletion();
    expect(t.jobOf(created).state).toBe('succeeded');
    expect(resolveApiKey).toHaveBeenCalledTimes(3);
    expect(generate).toHaveBeenCalledTimes(1);
    expect(error).not.toHaveBeenCalledWith('generation_job_orphaned_submit', expect.anything());
    generate.mockRestore();
  });

  it('fails a job whose provider is not registered after MAX_STEP_ATTEMPTS and releases the hold', async () => {
    const t = setup();
    const created = await createMusicJob({ user, request: request(), source: 'studio' }, t.deps);
    vi.spyOn(t.deps.providers, 'get').mockReturnValue(undefined);
    await t.runToCompletion();
    expect(t.jobOf(created)).toMatchObject({ state: 'failed', error: { code: 'provider_error' }, settledCredits: 0 });
    expect(releaseCreditHold).toHaveBeenCalledTimes(1);
    expect(settleCreditHold).not.toHaveBeenCalled();
  });

  it('fails a non-retryable failure without retrying and releases the hold', async () => {
    const generate = vi.spyOn(TestMusicProvider.prototype, 'generate');
    const t = setup();
    const created = await createMusicJob({ user, request: request('x [fail]'), source: 'studio' }, t.deps);
    await t.runToCompletion();
    const job = t.jobOf(created);
    expect(job).toMatchObject({ state: 'failed', error: { code: 'provider_error' }, settledCredits: 0 });
    expect(generate).toHaveBeenCalledTimes(1);
    expect(releaseCreditHold).toHaveBeenCalledTimes(1);
    expect(settleCreditHold).not.toHaveBeenCalled();
    generate.mockRestore();
  });

  it('fails a thrown generate as orphaned_submit, never calling it again, and releases the hold', async () => {
    const generate = vi.fn<Generate>(async () => {
      throw new ProviderSubmitError('socket hang up', false);
    });
    const t = setup({ providers: createMusicProviderRegistry([stubProvider(generate)]) });
    const created = await createMusicJob({ user, request: request(), source: 'studio' }, t.deps);
    await t.runToCompletion();
    // A redelivered message must not resubmit either.
    await t.engine.step(t.jobOf(created).id);
    expect(t.jobOf(created)).toMatchObject({ state: 'failed', error: { code: 'orphaned_submit' } });
    expect(generate).toHaveBeenCalledTimes(1);
    expect(releaseCreditHold).toHaveBeenCalledTimes(1);
    expect(t.deps.saveToFiles).not.toHaveBeenCalled();
  });

  it('fails a job whose last step crashed mid-generate as orphaned_submit without generating again', async () => {
    const generate = vi.spyOn(TestMusicProvider.prototype, 'generate');
    const t = setup();
    const created = await createMusicJob({ user, request: request(), source: 'studio' }, t.deps);
    const job = t.jobOf(created);
    // A worker that died inside generate left the job running with the submit marker, and nothing else.
    await t.repository.markSubmitAttempted(job.id, new Date(), { markRunning: true });
    await t.engine.step(job.id);
    expect(t.jobOf(created)).toMatchObject({ state: 'failed', error: { code: 'orphaned_submit' } });
    expect(generate).not.toHaveBeenCalled();
    generate.mockRestore();
  });

  it('releases an unbilled block', async () => {
    const t = setup();
    const created = await createMusicJob({ user, request: request('x [blocked]'), source: 'studio' }, t.deps);
    await t.runToCompletion();
    expect(t.jobOf(created)).toMatchObject({ state: 'blocked', error: { code: 'content_blocked' } });
    expect(releaseCreditHold).toHaveBeenCalledTimes(1);
    expect(settleCreditHold).not.toHaveBeenCalled();
  });

  it('settles a billed block at the requested length and records it as a refusal', async () => {
    const t = setup({
      providers: createMusicProviderRegistry([
        stubProvider(async () => ({ status: 'blocked', billed: true, raw: {} }), 'elevenlabs'),
      ]),
    });
    const created = await createMusicJob(
      { user, request: { model: 'music_v2', prompt: 'x', durationSeconds: 60 }, source: 'studio' },
      t.deps
    );
    await t.runToCompletion();
    const job = t.jobOf(created);
    expect(job).toMatchObject({ state: 'blocked', payload: { billedBlock: true } });
    const [, charged] = vi.mocked(settleCreditHold).mock.calls[0];
    expect(charged).toBe(job.creditHold?.reservedCredits);
    expect(t.deps.recordUsage).toHaveBeenCalledWith(
      expect.objectContaining({ status: 'refusal', durationSeconds: 60, costUsd: expect.closeTo(0.15, 10) })
    );
  });

  it('falls back to the generated bucket when Files refuses', async () => {
    const t = setup({ saveToFiles: vi.fn(async () => ({ saved: false as const, reason: 'storage_limit' as const })) });
    const created = await createMusicJob({ user, request: request(), source: 'studio' }, t.deps);
    await t.runToCompletion();
    const job = t.jobOf(created);
    expect(job.payload.output).toMatchObject({ location: 'generated', s3Key: `generated-audio/u1/${job.id}.mp3` });
    expect(job.payload.output?.fileId).toBeUndefined();
  });

  it('falls back to the generated bucket when the Files save throws', async () => {
    const t = setup({ saveToFiles: vi.fn(async () => Promise.reject(new Error('dedup lookup failed'))) });
    const created = await createMusicJob({ user, request: request(), source: 'studio' }, t.deps);
    await t.runToCompletion();
    expect(t.jobOf(created).payload.output).toMatchObject({ location: 'generated' });
  });

  it('saves to the generated bucket with a live signal when the step signal aborted the Files save', async () => {
    const abortedStep = AbortSignal.abort();
    const saveToFiles = vi.fn(async ({ signal }: { signal: AbortSignal }) => {
      signal.throwIfAborted();
      throw new Error('unreachable');
    });
    // The provider work finished before the step's signal fired, so it ignores the signal here.
    const liveProvider: MusicProvider = {
      ...stubProvider(async () => song(5)),
      fetchOutput: async () => silentMp3(5),
    };
    const t = setup({ saveToFiles, providers: createMusicProviderRegistry([liveProvider]) });
    const created = await createMusicJob({ user, request: request(), source: 'studio' }, t.deps);
    const result = await createMusicJobHandler(t.deps).submit(t.jobOf(created), { signal: abortedStep });
    expect(result).toMatchObject({ next: 'succeeded', payload: { output: { location: 'generated' } } });
    const [{ signal }] = vi.mocked(t.deps.saveToGeneratedBucket).mock.calls[0];
    expect(signal.aborted).toBe(false);
  });

  it('normalizes the content type for the MP3 measurement and the saves', async () => {
    const t = setup({
      providers: createMusicProviderRegistry([
        stubProvider(async () => ({
          status: 'succeeded',
          output: { kind: 'inline', base64: silentMp3(5).toString('base64'), contentType: 'Audio/MPEG; codecs=mp3' },
        })),
      ]),
    });
    const created = await createMusicJob({ user, request: request(), source: 'studio' }, t.deps);
    await t.runToCompletion();
    const job = t.jobOf(created);
    expect(job.payload.output).toMatchObject({ contentType: 'audio/mpeg' });
    expect(job.payload.reportedDurationSeconds).toBeCloseTo(5, 1);
    expect(t.deps.saveToFiles).toHaveBeenCalledWith(expect.objectContaining({ contentType: 'audio/mpeg' }));
  });

  it('maps audio/mp3 to audio/mpeg', async () => {
    const t = setup({
      providers: createMusicProviderRegistry([
        stubProvider(async () => ({
          status: 'succeeded',
          output: { kind: 'inline', base64: silentMp3(5).toString('base64'), contentType: 'audio/mp3' },
        })),
      ]),
    });
    const created = await createMusicJob({ user, request: request(), source: 'studio' }, t.deps);
    await t.runToCompletion();
    expect(t.jobOf(created).payload.output).toMatchObject({ contentType: 'audio/mpeg' });
  });

  it('bounds a huge raw provider payload before committing it', async () => {
    const raw = { echoed: Buffer.alloc(750_000, 1).toString('base64') };
    const t = setup({
      providers: createMusicProviderRegistry([
        stubProvider(async () => ({ status: 'failed', retryable: false, message: 'boom', raw })),
      ]),
    });
    const created = await createMusicJob({ user, request: request(), source: 'studio' }, t.deps);
    await t.runToCompletion();
    const stored = t.jobOf(created).rawProviderError;
    expect(typeof stored).toBe('string');
    expect(String(stored).length).toBeLessThan(17 * 1024 + 100);
    expect(String(stored)).toContain('truncated');
  });

  it('keeps a small raw provider payload as is', async () => {
    const raw = { reason: 'policy' };
    const t = setup({
      providers: createMusicProviderRegistry([stubProvider(async () => ({ status: 'blocked', billed: false, raw }))]),
    });
    const created = await createMusicJob({ user, request: request(), source: 'studio' }, t.deps);
    await t.runToCompletion();
    expect(t.jobOf(created).rawProviderError).toEqual(raw);
  });

  it('fails, without retrying, a job whose model left the catalog', async () => {
    const t = setup();
    const created = await createMusicJob({ user, request: request(), source: 'studio' }, t.deps);
    const job = t.jobOf(created);
    job.payload.request.model = 'removed-music-model' as MusicModelId;
    const result = await createMusicJobHandler(t.deps).submit(job, { signal: new AbortController().signal });
    expect(result).toMatchObject({ next: 'failed', error: { code: 'provider_error' } });
  });

  it('fails as orphaned_submit when the song cannot be saved anywhere', async () => {
    const t = setup({
      saveToFiles: vi.fn(async () => Promise.reject(new Error('files down'))),
      saveToGeneratedBucket: vi.fn(async () => Promise.reject(new Error('s3 down'))),
    });
    const error = vi.spyOn(t.deps.logger, 'error');
    const created = await createMusicJob({ user, request: request(), source: 'studio' }, t.deps);
    await t.runToCompletion();
    expect(t.jobOf(created)).toMatchObject({ state: 'failed', error: { code: 'orphaned_submit' } });
    expect(error).toHaveBeenCalledWith(
      'music_job_output_unsaved',
      expect.objectContaining({ jobId: expect.any(String) })
    );
  });

  it('fails an oversized output as output_too_large', async () => {
    const provider = stubProvider(async () => song(5));
    const t = setup({
      providers: createMusicProviderRegistry([
        {
          ...provider,
          fetchOutput: async () => {
            throw new ProviderOutputTooLargeError(10, 20);
          },
        },
      ]),
    });
    const created = await createMusicJob({ user, request: request(), source: 'studio' }, t.deps);
    await t.runToCompletion();
    expect(t.jobOf(created)).toMatchObject({ state: 'failed', error: { code: 'output_too_large' } });
  });

  it('cancels a job before its submit without generating', async () => {
    const generate = vi.spyOn(TestMusicProvider.prototype, 'generate');
    const t = setup();
    const created = await createMusicJob({ user, request: request(), source: 'studio' }, t.deps);
    await t.engine.requestCancel(t.jobOf(created));
    await t.runToCompletion();
    expect(t.jobOf(created)).toMatchObject({ state: 'cancelled', settledCredits: 0 });
    expect(generate).not.toHaveBeenCalled();
    expect(releaseCreditHold).toHaveBeenCalledTimes(1);
    generate.mockRestore();
  });

  it('reports running while generating and refuses a cancel then, charging the song the provider billed', async () => {
    const t = setup();
    const created = await createMusicJob({ user, request: request(), source: 'studio' }, t.deps);
    const job = t.jobOf(created);
    const original = TestMusicProvider.prototype.generate;
    let stateDuringGenerate: string | undefined;
    let cancel: Awaited<ReturnType<typeof t.engine.requestCancel>> | undefined;
    const generate = vi.spyOn(TestMusicProvider.prototype, 'generate').mockImplementationOnce(async function (
      this: TestMusicProvider,
      ...args
    ) {
      stateDuringGenerate = t.jobOf(created).state;
      cancel = await t.engine.requestCancel(job);
      return original.apply(this, args);
    });
    await t.runToCompletion();
    expect(stateDuringGenerate).toBe('running');
    expect(cancel).toMatchObject({ status: 'not_cancellable' });
    expect(t.jobOf(created).state).toBe('succeeded');
    expect(settleCreditHold).toHaveBeenCalledTimes(1);
    generate.mockRestore();
  });

  it('refuses an async music provider at submit instead of driving it', async () => {
    const t = setup({
      providers: createMusicProviderRegistry([
        { ...stubProvider(async () => song(5)), mode: 'async', submit: vi.fn(), poll: vi.fn() } as MusicProvider,
      ]),
    });
    const created = await createMusicJob({ user, request: request(), source: 'studio' }, t.deps);
    await t.runToCompletion();
    expect(t.jobOf(created)).toMatchObject({ state: 'failed', error: { code: 'provider_error' } });
  });
});

describe('music job settlement', () => {
  it('charges a per-song model its flat price whatever the length', async () => {
    const caps = MUSIC_MODEL_CATALOG['lyria-3.5'];
    const t = setup({
      providers: createMusicProviderRegistry([
        stubProvider(async () => song(30, { reportedDurationSeconds: 95 }), 'gemini-lyria'),
      ]),
    });
    const created = await createMusicJob({ user, request: { model: 'lyria-3.5', prompt: 'x' }, source: 'api' }, t.deps);
    await t.runToCompletion();
    const job = t.jobOf(created);
    const [, charged, entry] = vi.mocked(settleCreditHold).mock.calls[0];
    expect(charged).toBe(estimateMusicCostCredits(caps, { durationSeconds: 120 }));
    expect(charged).toBe(job.creditHold?.reservedCredits);
    expect(entry).toEqual({ type: 'music_generation_usage', sessionId: job.id, model: 'lyria-3.5' });
    expect(job.settledCredits).toBe(charged);
    expect(t.deps.recordUsage).toHaveBeenCalledWith(
      expect.objectContaining({ creditsCharged: charged, costUsd: 0.08, durationSeconds: 95, status: 'ok' })
    );
  });

  it('records the API key that created the job on its settlement row', async () => {
    const t = setup({
      providers: createMusicProviderRegistry([
        stubProvider(async () => song(30, { reportedDurationSeconds: 95 }), 'gemini-lyria'),
      ]),
    });
    const created = await createMusicJob(
      { user, request: { model: 'lyria-3.5', prompt: 'x' }, source: 'api', apiKeyId: 'key-1' },
      t.deps
    );
    await t.runToCompletion();

    expect(t.jobOf(created).apiKeyId).toBe('key-1');
    const [, , entry] = vi.mocked(settleCreditHold).mock.calls[0];
    expect(entry).toMatchObject({ type: 'music_generation_usage', apiKeyId: 'key-1' });
  });

  it('charges a per-second model the seconds it delivered, capped at the hold', async () => {
    const caps = MUSIC_MODEL_CATALOG.music_v2_5;
    const reported = [42, 75];
    const t = setup({
      providers: createMusicProviderRegistry([
        stubProvider(async () => song(60, { reportedDurationSeconds: reported.shift() }), 'elevenlabs'),
      ]),
    });
    const short = await createMusicJob(
      { user, request: { model: 'music_v2_5', prompt: 'x', durationSeconds: 60 }, source: 'api' },
      t.deps
    );
    const long = await createMusicJob(
      { user, request: { model: 'music_v2_5', prompt: 'y', durationSeconds: 60 }, source: 'api' },
      t.deps
    );
    await t.runToCompletion();
    const [[, shortCharged], [, longCharged]] = vi.mocked(settleCreditHold).mock.calls;
    expect(shortCharged).toBe(estimateMusicCostCredits(caps, { durationSeconds: 42 }));
    expect(longCharged).toBe(t.jobOf(long).creditHold?.reservedCredits);
    expect(t.jobOf(short).settledCredits).toBe(shortCharged);
    expect(t.deps.recordUsage).toHaveBeenCalledWith(
      expect.objectContaining({ durationSeconds: 42, costUsd: estimateMusicCostUsd(caps, { durationSeconds: 42 }) })
    );
  });

  it('records the delivered seconds uncapped while credits stay at the hold', async () => {
    const caps = MUSIC_MODEL_CATALOG.music_v2_5;
    const t = setup({
      providers: createMusicProviderRegistry([
        stubProvider(async () => song(60, { reportedDurationSeconds: 75 }), 'elevenlabs'),
      ]),
    });
    const created = await createMusicJob(
      { user, request: { model: 'music_v2_5', prompt: 'x', durationSeconds: 60 }, source: 'api' },
      t.deps
    );
    await t.runToCompletion();
    const [, charged] = vi.mocked(settleCreditHold).mock.calls[0];
    expect(charged).toBe(t.jobOf(created).creditHold?.reservedCredits);
    expect(t.deps.recordUsage).toHaveBeenCalledWith(
      expect.objectContaining({ durationSeconds: 75, costUsd: estimateMusicCostUsd(caps, { durationSeconds: 75 }) })
    );
  });

  describe('final charge rounding', () => {
    // A per-second ElevenLabs song, so the hold is a real round-up and the settlement a smaller draw.
    const settleOne = async (billedUsd: number) => {
      const t = setup({
        providers: createMusicProviderRegistry([stubProvider(async () => song(60), 'elevenlabs')]),
      });
      const created = await createMusicJob(
        { user, request: { model: 'music_v2_5', prompt: 'x', durationSeconds: 60 }, source: 'api' },
        t.deps
      );
      vi.mocked(estimateMusicCostUsd).mockReturnValueOnce(billedUsd);
      await t.runToCompletion();
      return { t, job: t.jobOf(created) };
    };

    it.each([
      [0.25, 41],
      [0.75, 40],
    ])(
      'charges N or N+1 for a cost of N + 0.5 credits, against the full hold (draw %s -> %s)',
      async (draw, expected) => {
        settlementDraw.mockReturnValue(draw);

        const { t, job } = await settleOne(40.5 / CREDITS_PER_USD_COST);

        const [hold, charged] = vi.mocked(settleCreditHold).mock.calls[0];
        expect(charged).toBe(expected);
        // The hold stays the round-up of the full request; settleCreditHold releases the difference.
        expect(hold).toEqual(job.creditHold);
        expect(charged).toBeLessThan(job.creditHold?.reservedCredits ?? 0);
        expect(job.settledCredits).toBe(expected);
        expect(t.deps.recordUsage).toHaveBeenCalledWith(expect.objectContaining({ creditsCharged: expected }));
      }
    );

    it.each([Number.NaN, Number.POSITIVE_INFINITY])(
      'keeps the full hold when the price lookup returns %s',
      async billedUsd => {
        const { t, job } = await settleOne(billedUsd);

        // Without the finiteness guard the draw reads a non-finite price as free and refunds the hold.
        expect(vi.mocked(settleCreditHold).mock.calls[0][1]).toBeNaN();
        expect(job.settledCredits).toBeNaN();
        expect(t.deps.recordUsage).toHaveBeenCalledTimes(1);
      }
    );

    it('can charge 0 for a tiny cost: the whole hold is released and usage is still recorded', async () => {
      const { t, job } = await settleOne(0.00001);

      expect(vi.mocked(settleCreditHold).mock.calls[0][1]).toBe(0);
      expect(job.settledCredits).toBe(0);
      expect(t.deps.recordUsage).toHaveBeenCalledWith(expect.objectContaining({ creditsCharged: 0, status: 'ok' }));
    });
  });

  it('keys the ledger entry to the notebook when the song was made in one', async () => {
    const t = setup();
    await createMusicJob({ user, request: request(), source: 'agent', sessionId: 's1', questId: 'q1' }, t.deps);
    await t.runToCompletion();
    expect(vi.mocked(settleCreditHold).mock.calls[0][2]).toEqual({
      type: 'music_generation_usage',
      sessionId: 's1',
      model: 'test-music',
    });
  });

  it('keeps the full hold when the price lookup fails', async () => {
    const t = setup();
    const error = vi.spyOn(t.deps.logger, 'error');
    const created = await createMusicJob({ user, request: request(), source: 'studio' }, t.deps);
    await t.runToCompletion();
    const job = t.jobOf(created);
    // Settlement re-read after a catalog removal, as the sweep would.
    job.payload.request.model = 'removed-music-model' as MusicModelId;
    await createMusicJobHandler(t.deps).onTerminal(job);
    expect(vi.mocked(settleCreditHold).mock.calls[1][1]).toBeNaN();
    expect(error).toHaveBeenCalledWith('music_job_estimate_failed', expect.objectContaining({ jobId: job.id }));
  });
});
