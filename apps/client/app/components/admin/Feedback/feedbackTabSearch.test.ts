import { describe, it, expect } from 'vitest';
import { FeedbackStatus, FeedbackType } from '@bike4mind/common';
import { FEEDBACK_DEFAULT_PAGE_SIZE, FEEDBACK_PAGE_SIZE_OPTIONS } from './constants';
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

  // The chip can no longer leave the filter empty, so the `none` token an older link may carry is dropped.
  it('reads the retired no-status token as the default', () => {
    expect(parseStatus('none')).toBeUndefined();
    expect(feedbackViewFromSearch({ feedbackStatus: 'none' }).statusFilters).toEqual(
      DEFAULT_FEEDBACK_VIEW.statusFilters
    );
  });

  it.each([['Bogus'], ['New,Bogus'], [''], [42], [['New']], [undefined]])('rejects %j', value => {
    expect(parseStatus(value)).toBeUndefined();
  });

  it('round-trips every non-empty combination of checked boxes', () => {
    const all = [FeedbackStatus.New, FeedbackStatus.InProgress, FeedbackStatus.Closed];
    for (let mask = 1; mask < 2 ** all.length; mask++) {
      const checked = all.filter((_, index) => mask & (1 << index));
      const view = { ...DEFAULT_FEEDBACK_VIEW, statusFilters: statusFilters(...checked) };
      expect(feedbackViewFromSearch(feedbackViewToSearch(view)).statusFilters, checked.join()).toEqual(
        view.statusFilters
      );
    }
  });

  it('writes nothing for an empty status set, which reads back as the default', () => {
    const search = feedbackViewToSearch({ ...DEFAULT_FEEDBACK_VIEW, statusFilters: statusFilters() });

    expect(search.feedbackStatus).toBeUndefined();
    expect(feedbackViewFromSearch(search).statusFilters).toEqual(DEFAULT_FEEDBACK_VIEW.statusFilters);
  });
});

describe('the subject param', () => {
  // `all` was the old subject menu's no-filter entry, never a subject the server knows.
  it('reads all as every subject', () => {
    expect(FEEDBACK_SEARCH_PARSERS.feedbackSubject('all')).toBeUndefined();
    expect(feedbackViewFromSearch({ feedbackSubject: 'all' }).subject).toBeUndefined();
  });
});

describe('the type param', () => {
  it('keeps known types in severity order and drops the rest', () => {
    expect(FEEDBACK_SEARCH_PARSERS.feedbackType(['Thumbs Up', 'Spam', 'Bug'])).toEqual([
      FeedbackType.BUG,
      FeedbackType.THUMBS_UP,
    ]);
  });

  it('reads no known type as every type', () => {
    expect(FEEDBACK_SEARCH_PARSERS.feedbackType(['Spam'])).toBeUndefined();
    expect(feedbackViewFromSearch({ feedbackType: ['Spam'] }).types).toEqual([]);
  });

  it('round-trips a picked type and writes nothing for none', () => {
    const view = { ...DEFAULT_FEEDBACK_VIEW, types: [FeedbackType.THUMBS_DOWN] };
    expect(feedbackViewFromSearch(feedbackViewToSearch(view)).types).toEqual([FeedbackType.THUMBS_DOWN]);
    expect(feedbackViewToSearch(DEFAULT_FEEDBACK_VIEW).feedbackType).toBeUndefined();
  });
});

describe('the limit param', () => {
  const parseLimit = FEEDBACK_SEARCH_PARSERS.feedbackLimit;

  it('accepts every size the table footer offers', () => {
    for (const size of FEEDBACK_PAGE_SIZE_OPTIONS) {
      expect(parseLimit(size)).toBe(size);
      expect(feedbackViewFromSearch({ feedbackLimit: String(size) }).limit).toBe(size);
    }
  });

  // 10 and 20 were page sizes before the list moved onto the admin table, so older links carry them.
  it.each([[10], [20], ['10'], ['20']])('reads the retired page size %j as the default of 25', value => {
    expect(parseLimit(value)).toBeUndefined();
    expect(feedbackViewFromSearch({ feedbackLimit: value }).limit).toBe(FEEDBACK_DEFAULT_PAGE_SIZE);
    expect(FEEDBACK_DEFAULT_PAGE_SIZE).toBe(25);
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
      limit: FEEDBACK_DEFAULT_PAGE_SIZE,
    });
  });

  it('reads every view param, tolerating quoted numbers from a hand-typed link', () => {
    expect(
      feedbackViewFromSearch({
        feedbackStatus: 'Closed,InProgress',
        feedbackSubject: 'turn',
        feedbackType: ['Bug'],
        feedbackOrg: 'Acme',
        feedbackOrder: 'asc',
        feedbackPage: '3',
        feedbackLimit: '50',
      })
    ).toEqual({
      statusFilters: statusFilters(FeedbackStatus.InProgress, FeedbackStatus.Closed),
      subject: 'turn',
      types: [FeedbackType.BUG],
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
        feedbackType: ['Spam'],
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
      types: [FeedbackType.BUG, FeedbackType.THUMBS_DOWN],
      organizations: ['Acme', 'Globex'],
      sortAscending: true,
      page: 2,
      limit: 100,
    };

    const search = feedbackViewToSearch(view);

    expect(withoutUndefined(search)).toEqual({
      feedbackStatus: 'New,Closed',
      feedbackSubject: 'product',
      feedbackType: [FeedbackType.BUG, FeedbackType.THUMBS_DOWN],
      feedbackOrg: ['Acme', 'Globex'],
      feedbackOrder: 'asc',
      feedbackPage: 2,
      feedbackLimit: 100,
    });
    expect(feedbackViewFromSearch(search)).toEqual(view);
  });

  it('sets every default param to undefined so a write removes it from the URL', () => {
    expect(Object.keys(feedbackViewToSearch(DEFAULT_FEEDBACK_VIEW)).sort()).toEqual(
      [
        'feedbackLimit',
        'feedbackOrder',
        'feedbackOrg',
        'feedbackPage',
        'feedbackStatus',
        'feedbackSubject',
        'feedbackType',
      ].sort()
    );
  });
});
