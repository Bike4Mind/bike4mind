import { render, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { IChatHistoryItem } from '@bike4mind/common';

const logEvent = vi.hoisted(() => vi.fn());
vi.mock('@client/app/hooks/data/analytics', () => ({ useLogEvent: () => ({ mutateAsync: logEvent }) }));

import FirstAnswerCreditsAnalytics, { firstAnswerCredits } from './FirstAnswerCreditsAnalytics';

const answer = (credits: number, timestamp: string) =>
  ({ status: 'done', creditsUsed: credits, timestamp }) as IChatHistoryItem;

describe('FirstAnswerCreditsAnalytics', () => {
  beforeEach(() => {
    localStorage.clear();
    logEvent.mockReset();
    logEvent.mockResolvedValue({ status: 204 });
  });

  it('selects the earliest completed answer without sorting the history', () => {
    expect(firstAnswerCredits([answer(40, '2026-01-02T00:00:00Z'), answer(12, '2026-01-01T00:00:00Z')])).toBe(12);
  });

  it('logs once and persists deduplication only after the server write succeeds', async () => {
    const history = [answer(12, '2026-01-01T00:00:00Z')];
    const { unmount } = render(<FirstAnswerCreditsAnalytics userId="u1" history={history} />);
    await waitFor(() =>
      expect(logEvent).toHaveBeenCalledWith({ type: 'first_answer_credits', metadata: { credits: 12 } })
    );
    await waitFor(() => expect(localStorage.getItem('firstAnswerCreditsLogged:u1')).toBe('1'));
    unmount();
    render(<FirstAnswerCreditsAnalytics userId="u1" history={history} />);
    expect(logEvent).toHaveBeenCalledTimes(1);
  });

  it('does not suppress a later retry when logging fails', async () => {
    logEvent.mockResolvedValueOnce(null).mockResolvedValueOnce({ status: 204 });
    const history = [answer(12, '2026-01-01T00:00:00Z')];
    const first = render(<FirstAnswerCreditsAnalytics userId="u1" history={history} />);
    await waitFor(() => expect(logEvent).toHaveBeenCalledTimes(1));
    first.unmount();
    render(<FirstAnswerCreditsAnalytics userId="u1" history={history} />);
    await waitFor(() => expect(logEvent).toHaveBeenCalledTimes(2));
  });
});
