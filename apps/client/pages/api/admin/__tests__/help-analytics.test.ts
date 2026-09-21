import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createMocks } from 'node-mocks-http';

/**
 * `dateFrom`/`dateTo` are validated by `parseDate`, but the shifts applied afterwards can
 * still push an already-valid Date out of range into an Invalid Date, which casts against the
 * Date-typed `createdAt` on the eight schema-casting queries below - a 500 where the blanket
 * CastError mapping used to answer 404. Two independent routes to that overflow, so two
 * defences, and the tests below pin them separately:
 *   - an absurd `tzOffset`, bounded by the clamp on `validOffset`
 *   - a parseable date at the edge of the JS Date range, which overflows under ANY offset
 *     (including an absent one, via the end-of-day shift) and so cannot be clamped away;
 *     `shiftedDate` asserts the constructed date instead.
 */

const mocks = vi.hoisted(() => ({
  getHandler: null as null | ((req: any, res: any) => unknown),
  countDocuments: vi.fn(),
  // Per-test fixtures for the stitch below. Empty by default so the date tests stay about dates.
  helpEvents: [] as unknown[],
  feedbackReports: [] as unknown[],
  feedbackTexts: [] as unknown[],
}));

vi.mock('@server/middlewares/baseApi', () => {
  const chain: any = {
    use: () => chain,
    get: (fn: any) => {
      mocks.getHandler = fn;
      return chain;
    },
  };
  return { baseApi: () => chain };
});

vi.mock('@server/middlewares/rateLimit', () => ({ rateLimit: () => () => {} }));

// FeedbackModel/FeedbackTextModel are reached through stitchRoutedComments, which the route calls
// to stitch routed comments back onto the events. Omitting them here does not fail loudly:
// vitest throws "No FeedbackModel export is defined" only once a row actually reaches the stitch,
// so with an empty HelpEventModel.find the whole read path would be skipped and the mock would
// look complete while covering nothing.
vi.mock('@bike4mind/database', () => ({
  HelpEventModel: {
    aggregate: () => Promise.resolve([]),
    countDocuments: (...a: unknown[]) => {
      mocks.countDocuments(...a);
      return Promise.resolve(0);
    },
    distinct: () => Promise.resolve([]),
    find: () => ({
      sort: () => ({ limit: () => ({ select: () => ({ lean: () => Promise.resolve(mocks.helpEvents) }) }) }),
    }),
  },
  FeedbackModel: {
    find: () => ({ select: () => ({ lean: () => Promise.resolve(mocks.feedbackReports) }) }),
  },
  FeedbackTextModel: {
    find: () => ({ lean: () => Promise.resolve(mocks.feedbackTexts) }),
  },
}));

import '@pages/api/admin/help-analytics';

const run = (query: Record<string, string>) => {
  const { req, res } = createMocks({ method: 'GET', query });
  (req as any).user = { isAdmin: true };
  return { res, promise: mocks.getHandler!(req, res) as Promise<unknown> };
};

// Every filter handed to a casting query shares one createdAt object; read it off the first.
const filterDates = (): Date[] => {
  const filter = mocks.countDocuments.mock.calls[0]?.[0] as { createdAt?: Record<string, Date> };
  return Object.values(filter?.createdAt ?? {});
};

beforeEach(() => {
  mocks.countDocuments.mockClear();
  mocks.helpEvents = [];
  mocks.feedbackReports = [];
  mocks.feedbackTexts = [];
});

describe('GET /api/admin/help-analytics - tzOffset clamp', () => {
  it.each([
    ['a huge positive offset', '999999999999999999'],
    ['a huge negative offset', '-999999999999999999'],
  ])('clamps %s rather than shifting the date out of range', async (_label, tzOffset) => {
    const { promise } = run({ dateFrom: '2026-01-01', dateTo: '2026-02-01', tzOffset });
    await promise;

    const dates = filterDates();
    expect(dates).toHaveLength(2);
    for (const d of dates) {
      expect(Number.isNaN(d.getTime())).toBe(false);
    }
  });

  it('applies a real offset unchanged', async () => {
    // 480 = PST. Shifts UTC midnight to the caller's local midnight.
    const { promise } = run({ dateFrom: '2026-01-01', tzOffset: '480' });
    await promise;
    expect(filterDates()[0].toISOString()).toBe('2026-01-01T08:00:00.000Z');
  });

  it('treats a non-numeric offset as no shift', async () => {
    const { promise } = run({ dateFrom: '2026-01-01', tzOffset: 'abc' });
    await promise;
    expect(filterDates()[0].toISOString()).toBe('2026-01-01T00:00:00.000Z');
  });

  it('still rejects an unparseable date itself', async () => {
    const { promise } = run({ dateFrom: 'not-a-date' });
    await expect(promise).rejects.toMatchObject({ statusCode: 400 });
    expect(mocks.countDocuments).not.toHaveBeenCalled();
  });
});

describe('GET /api/admin/help-analytics - extreme-year dates', () => {
  // Each of these parses cleanly and only overflows once a shift lands, so the clamp above is
  // structurally unable to prevent them - the -840 case uses an offset inside the clamp, and
  // the first needs no offset at all because the end-of-day shift overflows on its own.
  it.each([
    ['dateTo at the high edge, no offset at all', { dateTo: '+275760-09-13' }],
    ['dateFrom at the low edge, offset inside the clamp', { dateFrom: '-271821-04-20', tzOffset: '-840' }],
    ['dateFrom at the high edge, offset inside the clamp', { dateFrom: '+275760-09-13', tzOffset: '840' }],
  ])('rejects %s with a 400 before any query runs', async (_label, query) => {
    const { promise } = run(query);
    await expect(promise).rejects.toMatchObject({ statusCode: 400 });
    expect(mocks.countDocuments).not.toHaveBeenCalled();
  });

  it('still accepts a date near the edge that survives the shift', async () => {
    const { promise } = run({ dateFrom: '+275760-09-10' });
    await promise;
    expect(Number.isNaN(filterDates()[0].getTime())).toBe(false);
  });
});

/**
 * The comment an admin triages on this tab no longer lives on the help event it is rendered from -
 * it is stitched back from the routed Feedback report. That stitch is a convention each read site
 * has to remember rather than something the type system enforces, and forgetting it renders every
 * row commentless with no error, so it is asserted here against the route's own projection.
 */
describe('GET /api/admin/help-analytics - routed comment stitch', () => {
  it('surfaces a routed comment on the event it was written against', async () => {
    mocks.helpEvents = [{ _id: 'event-1', slug: 'getting-started', rating: 'not_helpful', userId: 'u1' }];
    mocks.feedbackReports = [{ _id: 'report-1', helpContext: { eventId: 'event-1' }, contentStored: true }];
    mocks.feedbackTexts = [{ _id: 'report-1', content: 'the second step is wrong', contentTruncated: false }];

    const { res, promise } = run({});
    await promise;

    expect(res._getJSONData().recentFeedback[0].comment).toBe('the second step is wrong');
  });

  it('leaves the comment absent once the text sibling has aged out from under the report', async () => {
    mocks.helpEvents = [{ _id: 'event-1', slug: 'getting-started', userId: 'u1' }];
    mocks.feedbackReports = [{ _id: 'report-1', helpContext: { eventId: 'event-1' }, contentStored: true }];

    const { res, promise } = run({});
    await promise;

    // An empty string here would render as a comment the user never wrote.
    expect(res._getJSONData().recentFeedback[0].comment).toBeUndefined();
  });
});
