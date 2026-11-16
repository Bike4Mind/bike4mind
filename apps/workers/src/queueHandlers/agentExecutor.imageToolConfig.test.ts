import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Logger } from '@bike4mind/observability';
import type { ImageToolJobsResult } from '@bike4mind/services/llm/tools';
import type { CreateImageJobsInput, ImageJob } from '@bike4mind/services/imageJobs';

// The production deps factory pulls in the DB and job wiring; these tests drive the pure half.
vi.mock('@bike4mind/database', () => ({
  questRepository: {},
  adminSettingsRepository: {},
  scopedSettingsRepository: {},
}));
vi.mock('@bike4mind/server-utils/generationJobs/wiring', () => ({ getCreateImageJobsDeps: vi.fn() }));

const { buildAgentImageToolConfig } = await import('./agentExecutor.imageToolConfig');

const QUEST_ID = 'quest-1';
const inputOf = (count: number): CreateImageJobsInput => ({
  user: { id: 'user-1', organizationId: null },
  request: {},
  count,
  source: 'agent',
});
const created = (count: number): ImageToolJobsResult => ({
  ok: true,
  groupId: 'g1',
  jobs: Array.from({ length: count }, (_, index) => ({ id: `job-${index}` }) as unknown as ImageJob),
  created: true,
});

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

const baseInput = {
  userId: 'user-1',
  questId: QUEST_ID,
  selection: { model: 'gpt-image-2' },
  toolEnabled: true,
} as const;

describe('buildAgentImageToolConfig', () => {
  let slots: ReturnType<typeof makeSlots>;
  let logger: ReturnType<typeof makeLogger>;

  beforeEach(() => {
    slots = makeSlots();
    logger = makeLogger();
  });

  const build = async (
    createJobs: (input: CreateImageJobsInput) => Promise<ImageToolJobsResult>,
    limit = 5,
    overrides: Partial<Parameters<typeof buildAgentImageToolConfig>[0]> = {}
  ) =>
    buildAgentImageToolConfig(
      { ...baseInput, ...overrides },
      { createJobs, resolveImageLimit: async () => limit, slots, logger }
    );

  it('carries the selection and claims one slot per image in the batch', async () => {
    const createJobs = vi.fn(async (input: CreateImageJobsInput) => created(input.count));
    const config = await build(createJobs, 5);
    expect(config?.selection).toEqual({ model: 'gpt-image-2' });

    await config?.createJobs(inputOf(3));
    expect(slots.claimed).toBe(3);
    expect(slots.claim).toHaveBeenCalledWith(QUEST_ID, 5);
  });

  it('refuses a batch that would pass the cap without starting any of it, and gives back what it claimed', async () => {
    const createJobs = vi.fn(async (input: CreateImageJobsInput) => created(input.count));
    const config = await build(createJobs, 4);
    await config?.createJobs(inputOf(3));

    const refused = await config?.createJobs(inputOf(2));
    expect(refused).toMatchObject({ ok: false, code: 'image_limit_reached' });
    expect(createJobs).toHaveBeenCalledTimes(1);
    expect(slots.claimed).toBe(3);

    await expect(config?.createJobs(inputOf(1))).resolves.toMatchObject({ ok: true });
    expect(slots.claimed).toBe(4);
  });

  it('gives every slot back when createJobs refuses or replays', async () => {
    const refusal: ImageToolJobsResult = { ok: false, status: 402, code: 'insufficient_credits', message: 'no' };
    const config = await build(async () => refusal, 4);
    await config?.createJobs(inputOf(2));
    expect(slots.claimed).toBe(0);

    const replaying = await build(async () => ({ ...created(2), created: false }), 4);
    await replaying?.createJobs(inputOf(2));
    expect(slots.claimed).toBe(0);
  });

  it.each([
    ['the tools are not in the toolbelt', { toolEnabled: false }],
    ['an API key started the run', { apiKeyId: 'key-1' }],
    ['the run has no Quest', { questId: undefined }],
  ])('keeps the in-process tools when %s', async (_label, overrides) => {
    expect(await build(vi.fn(), 5, overrides)).toBeNull();
  });

  it('keeps the in-process tools when the limit cannot be read', async () => {
    const config = await buildAgentImageToolConfig(baseInput, {
      createJobs: vi.fn(),
      resolveImageLimit: async () => {
        throw new Error('settings down');
      },
      slots,
      logger,
    });
    expect(config).toBeNull();
    expect(logger.warn).toHaveBeenCalled();
  });
});
