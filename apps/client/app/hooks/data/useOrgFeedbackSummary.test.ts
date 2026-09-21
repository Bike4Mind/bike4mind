import { describe, it, expect, vi } from 'vitest';

// The hook module pulls the api client and the websocket context in transitively; neither is
// exercised here, and both reach for browser globals at import time.
vi.mock('@client/app/contexts/ApiContext', () => ({ api: { get: vi.fn(), post: vi.fn() } }));
vi.mock('@client/app/contexts/WebsocketContext', () => ({ useWebsocket: () => ({ subscribeToAction: vi.fn() }) }));

import { summaryPollInterval } from './useOrgFeedbackSummary';

/**
 * The dedup path hands a second owner the first requester's job id without enqueuing, and the
 * worker's websocket frame goes to the first requester alone - so the join case has nothing but
 * this poll to tell it the job finished.
 */
describe('summaryPollInterval', () => {
  it('polls while the job is still running', () => {
    expect(summaryPollInterval('pending')).toBeGreaterThan(0);
    expect(summaryPollInterval('processing')).toBeGreaterThan(0);
  });

  it('stops once the job reaches a terminal state or was never asked for', () => {
    expect(summaryPollInterval('completed')).toBe(false);
    expect(summaryPollInterval('failed')).toBe(false);
    expect(summaryPollInterval('none')).toBe(false);
    expect(summaryPollInterval(undefined)).toBe(false);
  });
});
