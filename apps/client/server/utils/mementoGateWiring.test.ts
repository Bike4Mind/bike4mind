/**
 * Wiring tests for the two composed entry points the agent surface actually calls.
 *
 * These exist because the helpers being correct was never the weak link. Before the composition, each
 * of the three call sites resolved gates itself and then passed the value on, and replacing that value
 * with a hardcoded `{ v1: true, v2: true }` at ALL THREE sites left the entire suite green - the whole
 * opt-out could be reverted with CI none the wiser. The composition removed the fabrication
 * opportunity; these tests pin the composition itself (#1337).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const resolveExecutionMementoGatesMock = vi.fn();
const publishMock = vi.fn();
const recallMementosV2Mock = vi.fn();
const getRelevantMementosMock = vi.fn();

vi.mock('./resolveExecutionMementoGates', () => ({
  resolveExecutionMementoGates: (...args: unknown[]) => resolveExecutionMementoGatesMock(...args),
}));
vi.mock('@server/utils/eventBus', () => ({
  LLMEvents: { CompletionCompleted: { publish: (...args: unknown[]) => publishMock(...args) } },
}));
vi.mock('@server/memory/recallMementosV2', () => ({
  recallMementosV2: (...args: unknown[]) => recallMementosV2Mock(...args),
}));
vi.mock('@bike4mind/services', () => ({
  mementoService: { getRelevantMementos: (...args: unknown[]) => getRelevantMementosMock(...args) },
}));

const { resolveAndPublishMementoCompletion } = await import('./publishMementoCompletion');
const { resolveAndBuildMementosPreamble } = await import('./getFirstIterationMementosPreamble');

const makeLogger = () => ({ warn: vi.fn(), info: vi.fn(), error: vi.fn(), log: vi.fn(), debug: vi.fn() }) as never;

const EXECUTION = {
  id: 'exec-1',
  userId: 'user-1',
  sessionId: 'session-1',
  questId: 'quest-1',
  query: 'what is the weather',
  model: 'gpt-5.4',
  enableMementos: false as boolean | undefined,
  parentExecutionId: undefined,
  spawnedByExecutionId: undefined,
};

const ADAPTERS = {
  db: {
    mementos: {} as never,
    apiKeys: {} as never,
    adminSettings: { getSettingsValue: vi.fn() } as never,
  },
};

describe('memento gate wiring (composed entry points, #1337)', () => {
  beforeEach(() => {
    resolveExecutionMementoGatesMock.mockReset();
    publishMock.mockReset();
    recallMementosV2Mock.mockReset();
    getRelevantMementosMock.mockReset();
  });

  describe('resolveAndPublishMementoCompletion', () => {
    it('publishes the gates the resolver returned - not a fabricated set', async () => {
      // The resolver is the only source of truth. If the write path ever hardcodes gates again, the
      // resolver's verdict stops reaching the payload and this fails.
      resolveExecutionMementoGatesMock.mockResolvedValue({ v1: true, v2: false, v2OptInLookupFailed: false });

      await resolveAndPublishMementoCompletion(EXECUTION, ADAPTERS, makeLogger());

      expect(resolveExecutionMementoGatesMock).toHaveBeenCalledTimes(1);
      expect(publishMock).toHaveBeenCalledWith(
        expect.objectContaining({ enableMementos: true, enableMementosV2: false })
      );
    });

    it('an opt-out resolved by the resolver reaches the write path and suppresses the event entirely', async () => {
      // The actual #1337 guarantee, end to end through the composition: resolver says both gates off,
      // nothing is published. A call site that fabricated gates would publish here.
      resolveExecutionMementoGatesMock.mockResolvedValue({ v1: false, v2: false, v2OptInLookupFailed: false });

      await resolveAndPublishMementoCompletion(EXECUTION, ADAPTERS, makeLogger());

      expect(resolveExecutionMementoGatesMock).toHaveBeenCalledTimes(1);
      expect(publishMock).not.toHaveBeenCalled();
    });

    it('forwards the resolver failure signal so a blip is not published as an opt-out', async () => {
      resolveExecutionMementoGatesMock.mockResolvedValue({ v1: true, v2: false, v2OptInLookupFailed: true });

      await resolveAndPublishMementoCompletion(EXECUTION, ADAPTERS, makeLogger());

      const payload = publishMock.mock.calls[0][0];
      expect('enableMementosV2' in payload).toBe(false);
    });
  });

  describe('resolveAndBuildMementosPreamble', () => {
    it('an opt-out resolved by the resolver suppresses BOTH recall pipelines', async () => {
      resolveExecutionMementoGatesMock.mockResolvedValue({ v1: false, v2: false, v2OptInLookupFailed: false });

      const { preamble, mementoIds } = await resolveAndBuildMementosPreamble(EXECUTION, ADAPTERS, makeLogger());

      expect(resolveExecutionMementoGatesMock).toHaveBeenCalledTimes(1);
      expect(preamble).toBe('');
      expect(mementoIds).toEqual([]);
      expect(recallMementosV2Mock).not.toHaveBeenCalled();
      expect(getRelevantMementosMock).not.toHaveBeenCalled();
    });

    it('a V2 gate from the resolver reaches the V2 recall path', async () => {
      // Positive control: proves the suppression above is the gate doing work, not the mocks being inert.
      resolveExecutionMementoGatesMock.mockResolvedValue({ v1: false, v2: true, v2OptInLookupFailed: false });
      recallMementosV2Mock.mockResolvedValue([{ fact: 'user prefers dark mode' }]);

      const { preamble } = await resolveAndBuildMementosPreamble(EXECUTION, ADAPTERS, makeLogger());

      expect(recallMementosV2Mock).toHaveBeenCalledTimes(1);
      expect(preamble).toContain('dark mode');
    });
  });
});
