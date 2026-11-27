import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Logger } from '@bike4mind/observability';
import { MODEL_REQUIRES_SUBSCRIPTION_ERROR_CODE } from '@bike4mind/common';
import { ForbiddenError } from '@bike4mind/utils';
import type { AudioToolJobs } from '@bike4mind/services/llm/tools';
import type {
  CreateAudioJobInput,
  CreateSoundEffectJobResult,
  CreateSpeechJobResult,
} from '@bike4mind/services/audioJobs';

// The production deps factory pulls in the DB and job wiring; these tests drive the pure halves.
vi.mock('@bike4mind/database', () => ({
  questRepository: {},
  adminSettingsRepository: {},
  scopedSettingsRepository: {},
}));
vi.mock('@bike4mind/server-utils/generationJobs/audioJobWiring', () => ({ buildAudioToolJobs: vi.fn() }));

const { buildAgentAudioToolJobs, limitAudioClipsPerRun } = await import('./agentExecutor.audioToolConfig');

const QUEST_ID = 'quest-1';
const input: CreateAudioJobInput = { user: { id: 'user-1', organizationId: null }, request: {}, source: 'agent' };
const speechJob = { id: 'speech-1' } as unknown as Extract<CreateSpeechJobResult, { ok: true }>['job'];
const soundEffectJob = { id: 'sfx-1' } as unknown as Extract<CreateSoundEffectJobResult, { ok: true }>['job'];
const speechCreated: CreateSpeechJobResult = { ok: true, job: speechJob, created: true };
const soundEffectCreated: CreateSoundEffectJobResult = { ok: true, job: soundEffectJob, created: true };

const makeLogger = () => ({ warn: vi.fn() }) as unknown as Logger & { warn: ReturnType<typeof vi.fn> };

/** In-memory twin of QuestRepository.claimAgentGenerationSlot / releaseAgentGenerationSlot for one kind. */
const makeSlots = () => {
  let claimed = 0;
  return {
    claim: vi.fn(async (_questId: string, limit: number) => (claimed < limit ? (claimed++, true) : false)),
    release: vi.fn(async () => {
      claimed = Math.max(0, claimed - 1);
    }),
    get claimed() {
      return claimed;
    },
  };
};

const makeJobs = (overrides: Partial<AudioToolJobs> = {}): AudioToolJobs => ({
  createSpeechJob: vi.fn(async () => speechCreated),
  createSoundEffectJob: vi.fn(async () => soundEffectCreated),
  runInline: vi.fn(),
  readOutput: vi.fn(),
  cancel: vi.fn(),
  ...overrides,
});

describe('limitAudioClipsPerRun', () => {
  let speechSlots: ReturnType<typeof makeSlots>;
  let soundEffectSlots: ReturnType<typeof makeSlots>;
  let logger: ReturnType<typeof makeLogger>;

  const limit = (jobs: AudioToolJobs, speechLimit = 2, soundEffectLimit = 2) =>
    limitAudioClipsPerRun(jobs, {
      questId: QUEST_ID,
      speechLimit,
      soundEffectLimit,
      speechSlots,
      soundEffectSlots,
      logger,
    });

  beforeEach(() => {
    speechSlots = makeSlots();
    soundEffectSlots = makeSlots();
    logger = makeLogger();
  });

  it('starts speech up to the limit, then returns a speech_limit_reached tool error without calling createSpeechJob', async () => {
    const base = makeJobs();
    const jobs = limit(base);

    await expect(jobs.createSpeechJob(input)).resolves.toBe(speechCreated);
    await expect(jobs.createSpeechJob(input)).resolves.toBe(speechCreated);
    const third = await jobs.createSpeechJob(input);

    expect(third).toMatchObject({ ok: false, status: 403, code: 'speech_limit_reached' });
    expect(third.ok === false && third.message).toContain('limit of 2 speech clips');
    expect(third.ok === false && third.message).toContain('Do not retry');
    expect(base.createSpeechJob).toHaveBeenCalledTimes(2);
    expect(speechSlots.claim).toHaveBeenCalledWith(QUEST_ID, 2);
  });

  it('caps sound effects on their own counter, independent of speech', async () => {
    const base = makeJobs();
    const jobs = limit(base, 1, 1);

    await expect(jobs.createSpeechJob(input)).resolves.toBe(speechCreated);
    await expect(jobs.createSoundEffectJob(input)).resolves.toBe(soundEffectCreated);
    const second = await jobs.createSoundEffectJob(input);

    expect(second).toMatchObject({ ok: false, status: 403, code: 'sound_effect_limit_reached' });
    expect(second.ok === false && second.message).toContain('limit of 1 sound effect.');
    expect(base.createSoundEffectJob).toHaveBeenCalledTimes(1);
    expect(speechSlots.claimed).toBe(1);
    expect(soundEffectSlots.claimed).toBe(1);
  });

  it('refuses every call of a kind whose limit is 0, leaving the other kind usable', async () => {
    const base = makeJobs();
    const jobs = limit(base, 0, 1);

    const refused = await jobs.createSpeechJob(input);
    expect(refused).toMatchObject({ ok: false, status: 403, code: 'speech_limit_reached' });
    expect(refused.ok === false && refused.message).toContain('Do not retry');
    expect(base.createSpeechJob).not.toHaveBeenCalled();
    await expect(jobs.createSoundEffectJob(input)).resolves.toBe(soundEffectCreated);
  });

  it('gives the slot back when createSpeechJob refuses', async () => {
    const refusal: CreateSpeechJobResult = { ok: false, status: 402, code: 'insufficient_credits', message: 'no' };
    const jobs = limit(makeJobs({ createSpeechJob: async () => refusal }), 1);

    await expect(jobs.createSpeechJob(input)).resolves.toBe(refusal);
    expect(speechSlots.claimed).toBe(0);
  });

  // The tool retries a full Files quota without the saved copy; the retry must still fit a limit of 1.
  it('gives the slot back on a storage-quota refusal so the tool retry fits the cap', async () => {
    const quota: CreateSoundEffectJobResult = {
      ok: false,
      status: 400,
      code: 'storage_quota_exceeded',
      message: 'full',
      storage: {} as Extract<CreateSoundEffectJobResult, { code: 'storage_quota_exceeded' }>['storage'],
    };
    const createSoundEffectJob = vi
      .fn<AudioToolJobs['createSoundEffectJob']>()
      .mockResolvedValueOnce(quota)
      .mockResolvedValueOnce(soundEffectCreated);
    const jobs = limit(makeJobs({ createSoundEffectJob }), 1, 1);

    await expect(jobs.createSoundEffectJob(input)).resolves.toBe(quota);
    await expect(jobs.createSoundEffectJob({ ...input, saveToFiles: false })).resolves.toBe(soundEffectCreated);
    expect(soundEffectSlots.claimed).toBe(1);
  });

  it('gives the slot back on an idempotent replay, which starts no new clip', async () => {
    const replay: CreateSpeechJobResult = { ok: true, job: speechJob, created: false };
    const jobs = limit(makeJobs({ createSpeechJob: async () => replay }), 1);

    await jobs.createSpeechJob(input);
    expect(speechSlots.claimed).toBe(0);
  });

  // createXJob can throw after persisting the job, so a released slot could overshoot the cap.
  it('keeps the slot and rethrows when createSoundEffectJob throws', async () => {
    const jobs = limit(
      makeJobs({
        createSoundEffectJob: async () => {
          throw new Error('enqueue failed');
        },
      }),
      1,
      1
    );

    await expect(jobs.createSoundEffectJob(input)).rejects.toThrow('enqueue failed');
    expect(soundEffectSlots.claimed).toBe(1);
    expect(soundEffectSlots.release).not.toHaveBeenCalled();
  });

  // Model admission runs before the job is persisted, so this refusal never started a clip.
  it('gives the slot back and rethrows when createSpeechJob throws the free-tier model refusal', async () => {
    const refusal = new ForbiddenError('paid plan required', { errorCode: MODEL_REQUIRES_SUBSCRIPTION_ERROR_CODE });
    const jobs = limit(
      makeJobs({
        createSpeechJob: async () => {
          throw refusal;
        },
      }),
      1
    );

    await expect(jobs.createSpeechJob(input)).rejects.toBe(refusal);
    expect(speechSlots.claimed).toBe(0);
  });

  it('keeps the slot on a ForbiddenError that is not the free-tier model refusal', async () => {
    const jobs = limit(
      makeJobs({
        createSpeechJob: async () => {
          throw new ForbiddenError('other');
        },
      }),
      1
    );

    await expect(jobs.createSpeechJob(input)).rejects.toThrow('other');
    expect(speechSlots.claimed).toBe(1);
  });

  it('warns rather than masking the result when the release fails', async () => {
    speechSlots.release.mockRejectedValueOnce(new Error('db down'));
    const refusal: CreateSpeechJobResult = { ok: false, status: 400, code: 'invalid_request', message: 'bad' };
    const jobs = limit(makeJobs({ createSpeechJob: async () => refusal }), 1);

    await expect(jobs.createSpeechJob(input)).resolves.toBe(refusal);
    expect(logger.warn).toHaveBeenCalledWith(
      expect.stringContaining('release'),
      expect.objectContaining({ questId: QUEST_ID })
    );
  });

  it('keeps runInline, readOutput and cancel so the tool can still finish or cancel clips', () => {
    const base = makeJobs();
    const jobs = limit(base);
    expect(jobs.runInline).toBe(base.runInline);
    expect(jobs.readOutput).toBe(base.readOutput);
    expect(jobs.cancel).toBe(base.cancel);
  });
});

describe('buildAgentAudioToolJobs', () => {
  const caller = { userId: 'user-1', organizationId: 'org-1', questId: QUEST_ID, toolEnabled: true };

  const makeDeps = (overrides: { speechLimit?: number; soundEffectLimit?: number; limitError?: Error } = {}) => {
    const base = makeJobs();
    const readLimit = (value: number) =>
      vi.fn(async () => {
        if (overrides.limitError) throw overrides.limitError;
        return value;
      });
    return {
      base,
      deps: {
        buildBaseJobs: vi.fn(() => base),
        resolveSpeechLimit: readLimit(overrides.speechLimit ?? 3),
        resolveSoundEffectLimit: readLimit(overrides.soundEffectLimit ?? 3),
        speechSlots: makeSlots(),
        soundEffectSlots: makeSlots(),
        logger: makeLogger(),
      },
    };
  };

  it('caps both kinds on the run Quest with the limits resolved for the run org', async () => {
    const { base, deps } = makeDeps({ speechLimit: 4, soundEffectLimit: 5 });
    const jobs = await buildAgentAudioToolJobs(caller, deps);

    expect(deps.resolveSpeechLimit).toHaveBeenCalledWith({ userId: 'user-1', organizationId: 'org-1' });
    expect(deps.resolveSoundEffectLimit).toHaveBeenCalledWith({ userId: 'user-1', organizationId: 'org-1' });
    await jobs.createSpeechJob(input);
    await jobs.createSoundEffectJob(input);
    expect(deps.speechSlots.claim).toHaveBeenCalledWith(QUEST_ID, 4);
    expect(deps.soundEffectSlots.claim).toHaveBeenCalledWith(QUEST_ID, 5);
    expect(jobs).not.toBe(base);
  });

  it.each([
    ['the tool is not in the toolbelt', { toolEnabled: false }],
    ['an API key started the run', { apiKeyId: 'key-1' }],
    ['the run has no Quest', { questId: undefined }],
  ])('returns the uncapped job functions without reading settings when %s', async (_label, override) => {
    const { base, deps } = makeDeps();
    await expect(buildAgentAudioToolJobs({ ...caller, ...override }, deps)).resolves.toBe(base);
    expect(deps.resolveSpeechLimit).not.toHaveBeenCalled();
    expect(deps.resolveSoundEffectLimit).not.toHaveBeenCalled();
  });

  it('refuses both kinds (fail closed) when a limit read throws', async () => {
    const { base, deps } = makeDeps({ limitError: new Error('settings down') });
    const jobs = await buildAgentAudioToolJobs(caller, deps);

    await expect(jobs.createSpeechJob(input)).resolves.toMatchObject({ ok: false, code: 'speech_limit_reached' });
    await expect(jobs.createSoundEffectJob(input)).resolves.toMatchObject({
      ok: false,
      code: 'sound_effect_limit_reached',
    });
    expect(base.createSpeechJob).not.toHaveBeenCalled();
    expect(deps.logger.warn).toHaveBeenCalled();
  });
});
