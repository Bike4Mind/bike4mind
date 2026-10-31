import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const handlers = vi.hoisted(() => ({
  createMemento: vi.fn(),
  sessionAutoNaming: vi.fn(),
  sessionSummarization: vi.fn(),
  sessionContextSummarization: vi.fn(),
  sessionTagging: vi.fn(),
  notebookCuration: vi.fn(),
}));

vi.mock('@workers/events/createMemento', () => ({ handler: handlers.createMemento }));
vi.mock('@workers/events/sessionAutoNaming', () => ({ handler: handlers.sessionAutoNaming }));
vi.mock('@workers/events/sessionSummarization', () => ({ handler: handlers.sessionSummarization }));
vi.mock('@workers/events/sessionContextSummarization', () => ({ handler: handlers.sessionContextSummarization }));
vi.mock('@workers/events/sessionTagging', () => ({ handler: handlers.sessionTagging }));

vi.mock('@workers/events/notebookCuration', () => ({ handler: handlers.notebookCuration }));

const { requestRiskEvidenceRefresh } = vi.hoisted(() => ({ requestRiskEvidenceRefresh: vi.fn() }));
vi.mock('@server/auth/riskEvidence', () => ({ requestRiskEvidenceRefresh }));

const { dispatchSelfHostEvent } = await import('./eventDispatch');

describe('dispatchSelfHostEvent', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    Object.values(handlers).forEach(h => h.mockResolvedValue(undefined));
  });
  afterEach(() => vi.restoreAllMocks());

  it.each([
    ['completion.completed', 'createMemento'],
    ['session.auto_name', 'sessionAutoNaming'],
    ['session.summarize', 'sessionSummarization'],
    ['session.context_summarize', 'sessionContextSummarization'],
    ['session.tag', 'sessionTagging'],
    ['notebook.curation.start', 'notebookCuration'],
  ] as const)('routes %s to the matching handler with an EventBridge-shaped event', async (detailType, key) => {
    const detail = { sessionId: 's1' };
    await dispatchSelfHostEvent(detailType, detail);

    expect(handlers[key]).toHaveBeenCalledTimes(1);
    const event = handlers[key].mock.calls[0][0];
    expect(event['detail-type']).toBe(detailType);
    expect(event.detail).toEqual(detail);
    // No other handler fired.
    for (const [otherKey, fn] of Object.entries(handlers)) {
      if (otherKey !== key) expect(fn).not.toHaveBeenCalled();
    }
  });

  it('requests a risk evidence refresh alongside memento creation for a valid completion userId', async () => {
    const userId = 'a'.repeat(24);
    await dispatchSelfHostEvent('completion.completed', { userId });
    expect(requestRiskEvidenceRefresh).toHaveBeenCalledWith(userId, 'completion', console);
    expect(handlers.createMemento).toHaveBeenCalledTimes(1);
  });

  it.each([[{ userId: 'not-an-object-id' }], [{ userId: 42 }], [{}], [null]])(
    'skips the risk evidence refresh but still creates the memento for detail %j',
    async detail => {
      await dispatchSelfHostEvent('completion.completed', detail);
      expect(requestRiskEvidenceRefresh).not.toHaveBeenCalled();
      expect(handlers.createMemento).toHaveBeenCalledTimes(1);
    }
  );

  it('debug-logs and ignores an unknown detail type', async () => {
    const debug = vi.fn();
    await expect(dispatchSelfHostEvent('spider.progress', { x: 1 }, { debug })).resolves.toBeUndefined();
    expect(debug).toHaveBeenCalledWith(expect.stringContaining('spider.progress'));
    for (const fn of Object.values(handlers)) expect(fn).not.toHaveBeenCalled();
  });
});
