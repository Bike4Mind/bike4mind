import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { IGenerationJobDocument } from '@bike4mind/common';
import type { Logger } from '@bike4mind/observability';
import type { VideoToolConfig } from '@bike4mind/services/llm/tools';
import type { CreateVideoJobInput, CreateVideoJobResult } from '@bike4mind/services/videoJobs';

// The production deps factory pulls in the DB and job wiring; these tests drive the pure halves.
vi.mock('@bike4mind/database', () => ({
  questRepository: {},
  adminSettingsRepository: {},
  scopedSettingsRepository: {},
}));
vi.mock('@server/generationJobs/wiring', () => ({ getVideoJobDeps: vi.fn(), getCreateVideoJobDeps: vi.fn() }));
vi.mock('@server/videoGenerations/buildVideoToolConfig', () => ({ buildVideoToolConfig: vi.fn() }));

const { buildAgentVideoToolConfig, limitVideoClipsPerRun } = await import('./agentExecutor.videoToolConfig');

const QUEST_ID = 'quest-1';
const input: CreateVideoJobInput = { user: { id: 'user-1', organizationId: null }, request: {}, source: 'agent' };
const job = { id: 'job-1' } as unknown as IGenerationJobDocument;
const createdResult: CreateVideoJobResult = { ok: true, job, created: true };

const makeLogger = () => ({ warn: vi.fn() }) as unknown as Logger & { warn: ReturnType<typeof vi.fn> };

/** In-memory twin of QuestRepository.claimAgentVideoClip / releaseAgentVideoClip. */
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

const makeBaseConfig = (createJob: VideoToolConfig['createJob']): VideoToolConfig => ({
  usableModels: ['veo-3'] as unknown as VideoToolConfig['usableModels'],
  createJob,
});

describe('limitVideoClipsPerRun', () => {
  let slots: ReturnType<typeof makeSlots>;
  let logger: ReturnType<typeof makeLogger>;

  beforeEach(() => {
    slots = makeSlots();
    logger = makeLogger();
  });

  it('starts jobs up to the limit, then returns a clip_limit_reached tool error without calling createJob', async () => {
    const createJob = vi.fn(async () => createdResult);
    const config = limitVideoClipsPerRun(makeBaseConfig(createJob), { questId: QUEST_ID, limit: 2, slots, logger });

    await expect(config.createJob(input)).resolves.toBe(createdResult);
    await expect(config.createJob(input)).resolves.toBe(createdResult);
    const third = await config.createJob(input);

    expect(third).toMatchObject({ ok: false, code: 'clip_limit_reached' });
    expect(third.ok === false && third.message).toContain('limit of 2 video clips');
    expect(createJob).toHaveBeenCalledTimes(2);
    expect(slots.claim).toHaveBeenCalledWith(QUEST_ID, 2);
  });

  it('gives the slot back when createJob refuses', async () => {
    const refusal: CreateVideoJobResult = { ok: false, status: 402, code: 'insufficient_credits', message: 'no' };
    const config = limitVideoClipsPerRun(
      makeBaseConfig(async () => refusal),
      {
        questId: QUEST_ID,
        limit: 1,
        slots,
        logger,
      }
    );

    await expect(config.createJob(input)).resolves.toBe(refusal);
    expect(slots.claimed).toBe(0);
  });

  it('gives the slot back on an idempotent replay, which starts no new clip', async () => {
    const replay: CreateVideoJobResult = { ok: true, job, created: false };
    const config = limitVideoClipsPerRun(
      makeBaseConfig(async () => replay),
      {
        questId: QUEST_ID,
        limit: 1,
        slots,
        logger,
      }
    );

    await config.createJob(input);
    expect(slots.claimed).toBe(0);
  });

  it('gives the slot back and rethrows when createJob throws', async () => {
    const config = limitVideoClipsPerRun(
      makeBaseConfig(async () => {
        throw new Error('enqueue failed');
      }),
      { questId: QUEST_ID, limit: 1, slots, logger }
    );

    await expect(config.createJob(input)).rejects.toThrow('enqueue failed');
    expect(slots.claimed).toBe(0);
  });

  it('warns rather than masking the result when the release fails', async () => {
    slots.release.mockRejectedValueOnce(new Error('db down'));
    const refusal: CreateVideoJobResult = { ok: false, status: 400, code: 'invalid_request', message: 'bad' };
    const config = limitVideoClipsPerRun(
      makeBaseConfig(async () => refusal),
      {
        questId: QUEST_ID,
        limit: 1,
        slots,
        logger,
      }
    );

    await expect(config.createJob(input)).resolves.toBe(refusal);
    expect(logger.warn).toHaveBeenCalledWith(
      expect.stringContaining('release'),
      expect.objectContaining({ questId: QUEST_ID })
    );
  });
});

describe('buildAgentVideoToolConfig', () => {
  const caller = { userId: 'user-1', organizationId: 'org-1', questId: QUEST_ID };

  const makeDeps = (overrides: { limit?: number; base?: VideoToolConfig | null } = {}) => ({
    buildBaseConfig: vi.fn(async () =>
      overrides.base === undefined ? makeBaseConfig(async () => createdResult) : overrides.base
    ),
    resolveClipLimit: vi.fn(async () => overrides.limit ?? 2),
    slots: makeSlots(),
    logger: makeLogger(),
  });

  it('wraps the base config with the resolved per-run limit, scoped to the run org', async () => {
    const deps = makeDeps({ limit: 1 });
    const config = await buildAgentVideoToolConfig(caller, deps);

    expect(config).not.toBeNull();
    expect(deps.resolveClipLimit).toHaveBeenCalledWith({ userId: 'user-1', organizationId: 'org-1' });
    expect(deps.buildBaseConfig).toHaveBeenCalledWith('user-1');
    await config!.createJob(input);
    await expect(config!.createJob(input)).resolves.toMatchObject({ ok: false, code: 'clip_limit_reached' });
  });

  it('never offers the tool to an API-key run (same exclusion as chat)', async () => {
    const deps = makeDeps();
    await expect(buildAgentVideoToolConfig({ ...caller, apiKeyId: 'key-1' }, deps)).resolves.toBeNull();
    expect(deps.resolveClipLimit).not.toHaveBeenCalled();
    expect(deps.buildBaseConfig).not.toHaveBeenCalled();
  });

  it('does not offer the tool without a Quest to count on', async () => {
    const deps = makeDeps();
    await expect(buildAgentVideoToolConfig({ ...caller, questId: undefined }, deps)).resolves.toBeNull();
  });

  it('a limit of 0 removes the tool without touching video availability', async () => {
    const deps = makeDeps({ limit: 0 });
    await expect(buildAgentVideoToolConfig(caller, deps)).resolves.toBeNull();
    expect(deps.buildBaseConfig).not.toHaveBeenCalled();
  });

  it('does not offer the tool when the user has no usable video model', async () => {
    await expect(buildAgentVideoToolConfig(caller, makeDeps({ base: null }))).resolves.toBeNull();
  });

  it('fails closed and warns when a dependency throws', async () => {
    const deps = makeDeps();
    deps.resolveClipLimit.mockRejectedValueOnce(new Error('settings read failed'));
    await expect(buildAgentVideoToolConfig(caller, deps)).resolves.toBeNull();
    expect(deps.logger.warn).toHaveBeenCalled();
  });
});
