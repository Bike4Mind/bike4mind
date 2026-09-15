import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const handlers = vi.hoisted(() => ({
  createMemento: vi.fn(),
  sessionAutoNaming: vi.fn(),
  sessionSummarization: vi.fn(),
  sessionContextSummarization: vi.fn(),
  sessionTagging: vi.fn(),
}));

vi.mock('@server/events/createMemento', () => ({ handler: handlers.createMemento }));
vi.mock('@server/events/sessionAutoNaming', () => ({ handler: handlers.sessionAutoNaming }));
vi.mock('@server/events/sessionSummarization', () => ({ handler: handlers.sessionSummarization }));
vi.mock('@server/events/sessionContextSummarization', () => ({ handler: handlers.sessionContextSummarization }));
vi.mock('@server/events/sessionTagging', () => ({ handler: handlers.sessionTagging }));

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

  it('debug-logs and ignores an unknown detail type', async () => {
    const debug = vi.fn();
    await expect(dispatchSelfHostEvent('spider.progress', { x: 1 }, { debug })).resolves.toBeUndefined();
    expect(debug).toHaveBeenCalledWith(expect.stringContaining('spider.progress'));
    for (const fn of Object.values(handlers)) expect(fn).not.toHaveBeenCalled();
  });
});
