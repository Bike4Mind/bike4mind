import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// --- Mocks (registered before the SUT import) ---
const findByIdMock = vi.fn();
const findOneAndUpdateMock = vi.fn();
const createMock = vi.fn();

vi.mock('@bike4mind/database', () => ({
  agentExecutionRepository: {
    findById: (...args: unknown[]) => findByIdMock(...args),
  },
  Quest: {
    findOneAndUpdate: (...args: unknown[]) => findOneAndUpdateMock(...args),
    create: (...args: unknown[]) => createMock(...args),
  },
}));

// The naming/summary dispatch is fire-and-forget; stub it so tests don't
// depend on the event bus (which pulls in sst/queue wiring).
const autoNamePublishMock = vi.fn().mockResolvedValue(undefined);
const summarizePublishMock = vi.fn().mockResolvedValue(undefined);
vi.mock('@server/utils/eventBus', () => ({
  SessionEvents: {
    AutoName: { publish: (...args: unknown[]) => autoNamePublishMock(...args) },
    Summarize: { publish: (...args: unknown[]) => summarizePublishMock(...args) },
  },
}));

// Artifact persistence has its own suite; stub it here so this file keeps mocking
// only agentExecutionRepository + Quest out of @bike4mind/database.
const persistAgentArtifactsMock = vi.fn().mockResolvedValue(undefined);
vi.mock('./persistAgentArtifacts', () => ({
  persistAgentArtifacts: (...args: unknown[]) => persistAgentArtifactsMock(...args),
}));

const { persistRunAsQuest } = await import('./persistRunAsQuest');

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } as any;

const EXECUTION_ID = 'exec-1';

function stubExecution(overrides: Record<string, unknown> = {}) {
  findByIdMock.mockResolvedValue({
    sessionId: 's1',
    userId: 'u1',
    query: 'hello',
    ...overrides,
  });
}

beforeEach(() => {
  stubExecution();
});

afterEach(() => {
  vi.clearAllMocks();
});

describe('persistRunAsQuest finishReason (#293)', () => {
  describe('UPDATE branch (existing Quest patched)', () => {
    beforeEach(() => {
      findOneAndUpdateMock.mockResolvedValue({ _id: 'q1' }); // truthy → update path taken
    });

    it('sets promptMeta.finishReason in $set when finishReason is passed', async () => {
      await persistRunAsQuest(EXECUTION_ID, 'reply', logger, undefined, 'end_turn');

      const [, update] = findOneAndUpdateMock.mock.calls[0];
      expect(update.$set['promptMeta.finishReason']).toBe('end_turn');
      expect(update.$set.replies).toEqual(['reply']);
      expect(createMock).not.toHaveBeenCalled();
    });

    it('coexists with promptMeta.context.mementoIds (no clobber)', async () => {
      stubExecution({ usedMementoIds: ['m1', 'm2'] });

      await persistRunAsQuest(EXECUTION_ID, 'reply', logger, undefined, 'end_turn');

      const [, update] = findOneAndUpdateMock.mock.calls[0];
      expect(update.$set['promptMeta.finishReason']).toBe('end_turn');
      expect(update.$set['promptMeta.context.mementoIds']).toEqual(['m1', 'm2']);
    });

    it('omits promptMeta.finishReason when finishReason is absent', async () => {
      stubExecution({ usedMementoIds: ['m1'] });

      await persistRunAsQuest(EXECUTION_ID, 'reply', logger);

      const [, update] = findOneAndUpdateMock.mock.calls[0];
      expect(update.$set).not.toHaveProperty('promptMeta.finishReason');
      // mementoIds untouched by the finishReason change
      expect(update.$set['promptMeta.context.mementoIds']).toEqual(['m1']);
    });
  });

  describe('CREATE branch (no existing Quest)', () => {
    beforeEach(() => {
      findOneAndUpdateMock.mockResolvedValue(null); // falsy → create path taken
    });

    it('writes promptMeta.finishReason on create', async () => {
      await persistRunAsQuest(EXECUTION_ID, 'reply', logger, undefined, 'end_turn');

      const [doc] = createMock.mock.calls[0];
      expect(doc.promptMeta).toEqual({ finishReason: 'end_turn' });
    });

    it('composes finishReason AND mementoIds without either clobbering the other', async () => {
      stubExecution({ usedMementoIds: ['m1', 'm2'] });

      await persistRunAsQuest(EXECUTION_ID, 'reply', logger, undefined, 'max_tokens');

      const [doc] = createMock.mock.calls[0];
      expect(doc.promptMeta).toEqual({ finishReason: 'max_tokens', context: { mementoIds: ['m1', 'm2'] } });
    });

    it('still writes mementoIds when only those are present', async () => {
      stubExecution({ usedMementoIds: ['m1'] });

      await persistRunAsQuest(EXECUTION_ID, 'reply', logger);

      const [doc] = createMock.mock.calls[0];
      expect(doc.promptMeta).toEqual({ context: { mementoIds: ['m1'] } });
    });

    it('omits promptMeta entirely when neither finishReason nor mementoIds are present', async () => {
      await persistRunAsQuest(EXECUTION_ID, 'reply', logger);

      const [doc] = createMock.mock.calls[0];
      expect(doc).not.toHaveProperty('promptMeta');
    });
  });
});

describe('persistRunAsQuest creditsUsed persistence', () => {
  it('copies execution.totalCreditsUsed into the $set on the update branch', async () => {
    findOneAndUpdateMock.mockResolvedValue({ _id: 'q1' });
    stubExecution({ totalCreditsUsed: 42 });

    await persistRunAsQuest(EXECUTION_ID, 'reply', logger);

    const [, update] = findOneAndUpdateMock.mock.calls[0];
    expect(update.$set.creditsUsed).toBe(42);
  });

  it('copies execution.totalCreditsUsed onto the created doc', async () => {
    findOneAndUpdateMock.mockResolvedValue(null);
    stubExecution({ totalCreditsUsed: 42 });

    await persistRunAsQuest(EXECUTION_ID, 'reply', logger);

    const [doc] = createMock.mock.calls[0];
    expect(doc.creditsUsed).toBe(42);
  });

  it('defaults to 0 when the execution has no recorded credits', async () => {
    findOneAndUpdateMock.mockResolvedValue({ _id: 'q1' });

    await persistRunAsQuest(EXECUTION_ID, 'reply', logger);

    const [, update] = findOneAndUpdateMock.mock.calls[0];
    expect(update.$set.creditsUsed).toBe(0);
  });
});

describe('persistRunAsQuest agent artifact persistence', () => {
  const CREATED_AT = new Date(1700000000000);

  it('hands the persisted quest and the reply text to the artifact writer (update branch)', async () => {
    findOneAndUpdateMock.mockResolvedValue({ _id: 'q1', createdAt: CREATED_AT });

    await persistRunAsQuest(EXECUTION_ID, 'reply with <artifact>', logger);

    expect(persistAgentArtifactsMock).toHaveBeenCalledTimes(1);
    const [args] = persistAgentArtifactsMock.mock.calls[0];
    expect(args).toMatchObject({
      replyText: 'reply with <artifact>',
      questId: 'q1',
      questCreatedAtMs: CREATED_AT.getTime(),
      sessionId: 's1',
      userId: 'u1',
      executionId: EXECUTION_ID,
    });
  });

  it('uses the newly created quest on the create branch', async () => {
    findOneAndUpdateMock.mockResolvedValue(null);
    createMock.mockResolvedValue({ _id: 'q2', createdAt: CREATED_AT });

    await persistRunAsQuest(EXECUTION_ID, 'reply', logger);

    const [args] = persistAgentArtifactsMock.mock.calls[0];
    expect(args.questId).toBe('q2');
  });

  it('falls back to a zero timestamp for a quest with no createdAt', async () => {
    findOneAndUpdateMock.mockResolvedValue({ _id: 'q1' });

    await persistRunAsQuest(EXECUTION_ID, 'reply', logger);

    const [args] = persistAgentArtifactsMock.mock.calls[0];
    expect(args.questCreatedAtMs).toBe(0);
  });

  it('does not run when the execution is missing', async () => {
    findByIdMock.mockResolvedValue(null);

    await persistRunAsQuest(EXECUTION_ID, 'reply', logger);

    expect(persistAgentArtifactsMock).not.toHaveBeenCalled();
  });

  it('does not run when the execution has no sessionId', async () => {
    stubExecution({ sessionId: undefined });

    await persistRunAsQuest(EXECUTION_ID, 'reply', logger);

    expect(persistAgentArtifactsMock).not.toHaveBeenCalled();
  });

  it('still dispatches session naming and summarization afterwards', async () => {
    findOneAndUpdateMock.mockResolvedValue({ _id: 'q1', createdAt: CREATED_AT });

    await persistRunAsQuest(EXECUTION_ID, 'reply', logger);

    expect(autoNamePublishMock).toHaveBeenCalled();
    expect(summarizePublishMock).toHaveBeenCalled();
  });
});
