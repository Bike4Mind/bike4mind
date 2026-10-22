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
  const parseStatus = FEEDBACK_SEARCH_PARSERS.feedbackStatus;

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

describe('the order param', () => {
  const parseOrder = FEEDBACK_SEARCH_PARSERS.feedbackOrder;

  it('reads asc as ascending and desc as the default direction', () => {
    expect(feedbackViewFromSearch({ feedbackOrder: 'asc' }).sortAscending).toBe(true);
    expect(feedbackViewFromSearch({ feedbackOrder: 'desc' }).sortAscending).toBe(false);
  });

  it.each([['true'], [true], ['ASC'], [''], [1], [undefined]])('rejects %j', value => {
    expect(parseOrder(value)).toBeUndefined();
    expect(feedbackViewFromSearch({ feedbackOrder: value }).sortAscending).toBe(false);
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

  it('reads every view param, tolerating quoted numbers from a hand-typed link', () => {
    expect(
      feedbackViewFromSearch({
        feedbackStatus: 'none',
        feedbackSubject: 'turn',
        feedbackOrg: 'Acme',
        feedbackOrder: 'asc',
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
        feedbackStatus: 'Open',
        feedbackSubject: 'everything',
        feedbackOrg: [],
        feedbackOrder: 'yes',
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
      feedbackStatus: 'New,Closed',
      feedbackSubject: 'product',
      feedbackOrg: ['Acme', 'Globex'],
      feedbackOrder: 'asc',
      feedbackPage: 2,
      feedbackLimit: 100,
    });
    expect(feedbackViewFromSearch(search)).toEqual(view);
  });

  it('sets every default param to undefined so a write removes it from the URL', () => {
    expect(Object.keys(feedbackViewToSearch(DEFAULT_FEEDBACK_VIEW)).sort()).toEqual(
      ['feedbackLimit', 'feedbackOrder', 'feedbackOrg', 'feedbackPage', 'feedbackStatus', 'feedbackSubject'].sort()
    );
  });
});
