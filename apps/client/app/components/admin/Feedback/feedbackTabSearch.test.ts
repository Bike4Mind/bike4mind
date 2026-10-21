import { describe, it, expect } from 'vitest';
import { FEEDBACK_LIST_DEFAULT_LIMIT, FeedbackStatus } from '@bike4mind/common';
import {
  DEFAULT_FEEDBACK_VIEW,
  FEEDBACK_SEARCH_PARSERS,
  feedbackViewFromSearch,
  feedbackViewToSearch,
  type FeedbackView,
} from './feedbackTabSearch';

const statusFilters = (...checked: FeedbackStatus[]) => ({
  [FeedbackStatus.New]: checked.includes(FeedbackStatus.New),
  [FeedbackStatus.InProgress]: checked.includes(FeedbackStatus.InProgress),
  [FeedbackStatus.Closed]: checked.includes(FeedbackStatus.Closed),
});

const withoutUndefined = (search: Record<string, unknown>) =>
  Object.fromEntries(Object.entries(search).filter(([, value]) => value !== undefined));

describe('the status param', () => {
  const parseStatus = FEEDBACK_SEARCH_PARSERS.status;

  it('accepts comma-joined statuses and canonicalizes their order', () => {
    expect(parseStatus('Closed,New')).toBe('New,Closed');
    expect(parseStatus('InProgress')).toBe('InProgress');
  });

  it('keeps the explicit no-status token', () => {
    expect(parseStatus('none')).toBe('none');
  });

  it.each([['Bogus'], ['New,Bogus'], [''], [42], [['New']], [undefined]])('rejects %j', value => {
    expect(parseStatus(value)).toBeUndefined();
  });

  it('round-trips every combination of checked boxes', () => {
    const all = [FeedbackStatus.New, FeedbackStatus.InProgress, FeedbackStatus.Closed];
    for (let mask = 0; mask < 2 ** all.length; mask++) {
      const checked = all.filter((_, index) => mask & (1 << index));
      const view = { ...DEFAULT_FEEDBACK_VIEW, statusFilters: statusFilters(...checked) };
      expect(feedbackViewFromSearch(feedbackViewToSearch(view)).statusFilters, checked.join()).toEqual(
        view.statusFilters
      );
    }
  });
});

describe('feedbackViewFromSearch', () => {
  it('is the default view for a bare feedback URL', () => {
    expect(feedbackViewFromSearch({ tab: 'feedback' })).toEqual(DEFAULT_FEEDBACK_VIEW);
    expect(DEFAULT_FEEDBACK_VIEW).toMatchObject({
      statusFilters: statusFilters(FeedbackStatus.New),
      sortAscending: false,
      page: 1,
      limit: FEEDBACK_LIST_DEFAULT_LIMIT,
    });
  });

  it('reads every view param, tolerating quoted numbers and booleans from a hand-typed link', () => {
    expect(
      feedbackViewFromSearch({
        status: 'none',
        subject: 'turn',
        feedbackOrg: 'Acme',
        asc: 'true',
        feedbackPage: '3',
        feedbackLimit: '50',
      })
    ).toEqual({
      statusFilters: statusFilters(),
      subject: 'turn',
      organizations: ['Acme'],
      sortAscending: true,
      page: 3,
      limit: 50,
    });
  });

  it('falls back to the default for each invalid param', () => {
    expect(
      feedbackViewFromSearch({
        status: 'Open',
        subject: 'everything',
        feedbackOrg: [],
        asc: 'yes',
        feedbackPage: 0,
        feedbackLimit: 1000,
      })
    ).toEqual(DEFAULT_FEEDBACK_VIEW);
    expect(feedbackViewFromSearch({ feedbackPage: 1e21 }).page).toBe(1);
  });
});

describe('feedbackViewToSearch', () => {
  it('writes nothing for the default view', () => {
    expect(withoutUndefined(feedbackViewToSearch(DEFAULT_FEEDBACK_VIEW))).toEqual({});
  });

  it('writes only what differs from the default, and round-trips', () => {
    const view: FeedbackView = {
      statusFilters: statusFilters(FeedbackStatus.New, FeedbackStatus.Closed),
      subject: 'product',
      organizations: ['Acme', 'Globex'],
      sortAscending: true,
      page: 2,
      limit: 100,
    };

    const search = feedbackViewToSearch(view);

    expect(withoutUndefined(search)).toEqual({
      status: 'New,Closed',
      subject: 'product',
      feedbackOrg: ['Acme', 'Globex'],
      asc: true,
      feedbackPage: 2,
      feedbackLimit: 100,
    });
    expect(feedbackViewFromSearch(search)).toEqual(view);
  });

  it('sets every default param to undefined so a write removes it from the URL', () => {
    expect(Object.keys(feedbackViewToSearch(DEFAULT_FEEDBACK_VIEW)).sort()).toEqual(
      ['asc', 'feedbackLimit', 'feedbackOrg', 'feedbackPage', 'status', 'subject'].sort()
    );
  });
});
