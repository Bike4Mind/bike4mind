import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Logger } from '@bike4mind/observability';
import type { MusicToolConfig } from '@bike4mind/services/llm/tools';
import type { CreateMusicJobInput, CreateMusicJobResult } from '@bike4mind/services/musicJobs';

// The production deps factory pulls in the DB and job wiring; these tests drive the pure halves.
vi.mock('@bike4mind/database', () => ({
  questRepository: {},
  adminSettingsRepository: {},
  scopedSettingsRepository: {},
}));
vi.mock('@server/generationJobs/wiring', () => ({ getMusicJobDeps: vi.fn(), getCreateMusicJobDeps: vi.fn() }));
vi.mock('@server/musicGenerations/buildMusicToolConfig', () => ({ buildMusicToolConfig: vi.fn() }));

const { buildAgentMusicToolConfig, limitMusicTracksPerRun } = await import('./agentExecutor.musicToolConfig');

const QUEST_ID = 'quest-1';
const input: CreateMusicJobInput = { user: { id: 'user-1', organizationId: null }, request: {}, source: 'agent' };
const job = { id: 'job-1' } as unknown as Extract<CreateMusicJobResult, { ok: true }>['job'];
const createdResult: CreateMusicJobResult = { ok: true, job, created: true };

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

const makeBaseConfig = (createJob: MusicToolConfig['createJob']): MusicToolConfig => ({
  usableModels: ['test-music'] as unknown as MusicToolConfig['usableModels'],
  createJob,
});

describe('limitMusicTracksPerRun', () => {
  let slots: ReturnType<typeof makeSlots>;
  let logger: ReturnType<typeof makeLogger>;

  beforeEach(() => {
    slots = makeSlots();
    logger = makeLogger();
  });

  it('starts jobs up to the limit, then returns a track_limit_reached tool error without calling createJob', async () => {
    const createJob = vi.fn(async () => createdResult);
    const config = limitMusicTracksPerRun(makeBaseConfig(createJob), { questId: QUEST_ID, limit: 2, slots, logger });

    await expect(config.createJob(input)).resolves.toBe(createdResult);
    await expect(config.createJob(input)).resolves.toBe(createdResult);
    const third = await config.createJob(input);

    expect(third).toMatchObject({ ok: false, status: 403, code: 'track_limit_reached' });
    expect(third.ok === false && third.message).toContain('limit of 2 songs');
    expect(createJob).toHaveBeenCalledTimes(2);
    expect(slots.claim).toHaveBeenCalledWith(QUEST_ID, 2);
  });

  it('gives the slot back when createJob refuses', async () => {
    const refusal: CreateMusicJobResult = { ok: false, status: 402, code: 'insufficient_credits', message: 'no' };
    const config = limitMusicTracksPerRun(
      makeBaseConfig(async () => refusal),
      { questId: QUEST_ID, limit: 1, slots, logger }
    );

    await expect(config.createJob(input)).resolves.toBe(refusal);
    expect(slots.claimed).toBe(0);
  });

  it('gives the slot back on an idempotent replay, which starts no new song', async () => {
    const replay: CreateMusicJobResult = { ok: true, job, created: false };
    const config = limitMusicTracksPerRun(
      makeBaseConfig(async () => replay),
      { questId: QUEST_ID, limit: 1, slots, logger }
    );

    await config.createJob(input);
    expect(slots.claimed).toBe(0);
  });

  // createJob can throw after persisting the job, so a released slot could overshoot the cap.
  it('keeps the slot and rethrows when createJob throws', async () => {
    const config = limitMusicTracksPerRun(
      makeBaseConfig(async () => {
        throw new Error('enqueue failed');
      }),
      { questId: QUEST_ID, limit: 1, slots, logger }
    );

    await expect(config.createJob(input)).rejects.toThrow('enqueue failed');
    expect(slots.claimed).toBe(1);
    expect(slots.release).not.toHaveBeenCalled();
  });

  it('warns rather than masking the result when the release fails', async () => {
    slots.release.mockRejectedValueOnce(new Error('db down'));
    const refusal: CreateMusicJobResult = { ok: false, status: 400, code: 'invalid_request', message: 'bad' };
    const config = limitMusicTracksPerRun(
      makeBaseConfig(async () => refusal),
      { questId: QUEST_ID, limit: 1, slots, logger }
    );

    await expect(config.createJob(input)).resolves.toBe(refusal);
    expect(logger.warn).toHaveBeenCalledWith(
      expect.stringContaining('release'),
      expect.objectContaining({ questId: QUEST_ID })
    );
  });
});

describe('buildAgentMusicToolConfig', () => {
  const caller = { userId: 'user-1', organizationId: 'org-1', questId: QUEST_ID, toolEnabled: true };

  const makeDeps = (overrides: { limit?: number; base?: MusicToolConfig | null } = {}) => ({
    buildBaseConfig: vi.fn(async () =>
      overrides.base === undefined ? makeBaseConfig(async () => createdResult) : overrides.base
    ),
    resolveTrackLimit: vi.fn(async () => overrides.limit ?? 2),
    slots: makeSlots(),
    logger: makeLogger(),
  });

  it('wraps the base config with the resolved per-run limit, scoped to the run org', async () => {
    const deps = makeDeps({ limit: 1 });
    const config = await buildAgentMusicToolConfig(caller, deps);

    expect(config).not.toBeNull();
    expect(deps.resolveTrackLimit).toHaveBeenCalledWith({ userId: 'user-1', organizationId: 'org-1' });
    expect(deps.buildBaseConfig).toHaveBeenCalledWith('user-1');
    await config!.createJob(input);
    await expect(config!.createJob(input)).resolves.toMatchObject({ ok: false, code: 'track_limit_reached' });
  });

  it.each([
    ['the tool is not in the toolbelt', { toolEnabled: false }],
    ['an API key started the run (same exclusion as chat)', { apiKeyId: 'key-1' }],
    ['the run has no Quest to count on', { questId: undefined }],
  ])('offers nothing when %s, without reading settings or keys', async (_case, override) => {
    const deps = makeDeps();
    await expect(buildAgentMusicToolConfig({ ...caller, ...override }, deps)).resolves.toBeNull();
    expect(deps.resolveTrackLimit).not.toHaveBeenCalled();
    expect(deps.buildBaseConfig).not.toHaveBeenCalled();
  });

  it('a limit of 0 removes the tool without touching music availability', async () => {
    const deps = makeDeps({ limit: 0 });
    await expect(buildAgentMusicToolConfig(caller, deps)).resolves.toBeNull();
    expect(deps.buildBaseConfig).not.toHaveBeenCalled();
  });

  it('does not offer the tool when the user has no usable music model', async () => {
    await expect(buildAgentMusicToolConfig(caller, makeDeps({ base: null }))).resolves.toBeNull();
  });

  it.each([
    ['the limit read', 'resolveTrackLimit'],
    ['the base config', 'buildBaseConfig'],
  ] as const)('fails closed and warns when %s throws', async (_case, dep) => {
    const deps = makeDeps();
    deps[dep].mockRejectedValueOnce(new Error('read failed'));
    await expect(buildAgentMusicToolConfig(caller, deps)).resolves.toBeNull();
    expect(deps.logger.warn).toHaveBeenCalled();
  });
});
