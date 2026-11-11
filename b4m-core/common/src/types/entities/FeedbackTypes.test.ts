import { describe, it, expect } from 'vitest';
import {
  classifyStage,
  feedbackDeliveryFailed,
  FEEDBACK_ROLLUP_MAX_WINDOW_DAYS,
  FeedbackRollupQuerySchema,
  FEEDBACK_CLIENT_CONTEXT_LIMITS,
  FeedbackType,
  hasFeedbackComment,
  isFeedbackTriageNoise,
  NO_FEEDBACK_DETAILS_PLACEHOLDER,
  parseFeedbackClientContext,
  parseFeedbackRollupBound,
  sanitizeFeedbackPagePath,
} from './FeedbackTypes';

describe('classifyStage', () => {
  it('classifies production as production', () => {
    expect(classifyStage('production')).toBe('production');
  });

  it('classifies every other stage as nonprod', () => {
    expect(classifyStage('staging')).toBe('nonprod');
    expect(classifyStage('dev')).toBe('nonprod');
    expect(classifyStage('some-preview-stage')).toBe('nonprod');
  });

  it('classifies undefined as nonprod', () => {
    expect(classifyStage(undefined)).toBe('nonprod');
  });
});

const DAY_MS = 24 * 60 * 60 * 1000;
const BASE = Date.parse('2026-01-01T00:00:00.000Z');
const at = (offsetDays: number) => new Date(BASE + offsetDays * DAY_MS).toISOString();

describe('parseFeedbackRollupBound', () => {
  it('reads an offset-less value as UTC rather than as the host timezone', () => {
    expect(parseFeedbackRollupBound('2026-01-01T00:00:00').toISOString()).toBe('2026-01-01T00:00:00.000Z');
  });

  it('honours an explicit offset', () => {
    expect(parseFeedbackRollupBound('2026-01-01T02:00:00+02:00').toISOString()).toBe('2026-01-01T00:00:00.000Z');
  });
});

describe('FeedbackRollupQuerySchema', () => {
  it('accepts a UTC window', () => {
    expect(FeedbackRollupQuerySchema.safeParse({ from: at(0), to: at(30) }).success).toBe(true);
  });

  it('accepts the offset-less and offset-bearing forms a date picker emits', () => {
    expect(
      FeedbackRollupQuerySchema.safeParse({ from: '2026-01-01T00:00:00', to: '2026-01-31T00:00:00' }).success
    ).toBe(true);
    expect(
      FeedbackRollupQuerySchema.safeParse({ from: '2026-01-01T00:00:00+02:00', to: '2026-01-31T00:00:00+02:00' })
        .success
    ).toBe(true);
  });

  it('rejects a missing bound', () => {
    const missingFrom = FeedbackRollupQuerySchema.safeParse({ to: at(30) });
    const missingTo = FeedbackRollupQuerySchema.safeParse({ from: at(0) });

    expect(missingFrom.success).toBe(false);
    expect(missingFrom.error).not.toBe(undefined);
    expect(missingTo.success).toBe(false);
    expect(missingTo.error).not.toBe(undefined);
  });

  it('rejects a reversed window', () => {
    expect(FeedbackRollupQuerySchema.safeParse({ from: at(30), to: at(0) }).success).toBe(false);
  });

  it('rejects an empty window - the bound comparison is strict, so from === to is not a window', () => {
    expect(FeedbackRollupQuerySchema.safeParse({ from: at(0), to: at(0) }).success).toBe(false);
  });

  it('rejects a non-date string', () => {
    const result = FeedbackRollupQuerySchema.safeParse({ from: 'last tuesday', to: at(30) });
    expect(result.success).toBe(false);
    expect(result.error).not.toBe(undefined);
  });

  it('accepts a window longer than the 90-day text retention - retention is reported, never enforced here', () => {
    expect(FeedbackRollupQuerySchema.safeParse({ from: at(0), to: at(120) }).success).toBe(true);
  });

  // Pinned so a change to the constant's value is caught here rather than silently rescaling
  // the assertions below, which derive their window from a literal day count, not the constant.
  it('pins the window cap at 366 days', () => {
    expect(FEEDBACK_ROLLUP_MAX_WINDOW_DAYS).toBe(366);
  });

  it('accepts the widest window the inclusive bounds allow and rejects one instant more', () => {
    // `to` is included, so 366 whole days of coverage ends one millisecond short of the 366-day
    // gap - a gap of exactly 366 days would cover 366 days plus that final instant.
    const widest = new Date(BASE + 366 * DAY_MS - 1).toISOString();
    expect(FeedbackRollupQuerySchema.safeParse({ from: at(0), to: widest }).success).toBe(true);
    expect(FeedbackRollupQuerySchema.safeParse({ from: at(0), to: at(366) }).success).toBe(false);
    expect(FeedbackRollupQuerySchema.safeParse({ from: at(0), to: at(367) }).success).toBe(false);
  });

  it('strips a userId the caller tried to smuggle in - the principal is never taken from the query', () => {
    const result = FeedbackRollupQuerySchema.safeParse({ from: at(0), to: at(30), userId: 'someone-else' });
    expect(result.success).toBe(true);
    expect(result.data).not.toHaveProperty('userId');
  });
});

describe('feedbackDeliveryFailed', () => {
  const skipped = (reason: string) => ({ outcome: 'skipped' as const, reason });

  it('is false when every channel was merely skipped - the staging default', () => {
    // Both channels skip with nonprod_unconfigured on any stage an operator has not opted in.
    // This is the case that made every staging send say "we could not notify the team".
    expect(
      feedbackDeliveryFailed({
        delivered: false,
        channels: { slack: skipped('nonprod_unconfigured'), email: skipped('nonprod_unconfigured') },
      })
    ).toBe(false);
  });

  it('is false for the other skip reasons too', () => {
    for (const reason of ['disabled', 'no_recipients', 'unconfigured_webhook']) {
      expect(
        feedbackDeliveryFailed({ delivered: false, channels: { slack: skipped(reason), email: skipped(reason) } })
      ).toBe(false);
    }
  });

  it('is true when a channel actually failed, even beside a skip', () => {
    expect(
      feedbackDeliveryFailed({
        delivered: false,
        channels: { slack: { outcome: 'failed', reason: 'error' }, email: skipped('disabled') },
      })
    ).toBe(true);
  });

  it('is false when a channel failed but another one delivered - the team was still told', () => {
    // Slack throws, the email goes out: `delivered` is true and someone has seen the report, so
    // the submitter must not be told otherwise. The dead channel still reaches ops through the
    // handler's own isIncident alarm.
    expect(
      feedbackDeliveryFailed({
        delivered: true,
        channels: { slack: { outcome: 'delivered' }, email: { outcome: 'failed', reason: 'error' } },
      })
    ).toBe(false);
  });

  it('is true when every channel failed', () => {
    expect(
      feedbackDeliveryFailed({
        delivered: false,
        channels: { slack: { outcome: 'failed', reason: 'error' }, email: { outcome: 'failed', reason: 'error' } },
      })
    ).toBe(true);
  });

  it('is false for the shape the handler sends on a clean send', () => {
    // Both channels present and delivered - the reply a real successful send produces.
    expect(
      feedbackDeliveryFailed({
        delivered: true,
        channels: { slack: { outcome: 'delivered' }, email: { outcome: 'delivered' } },
      })
    ).toBe(false);
  });

  it('is false when a channel delivered', () => {
    expect(
      feedbackDeliveryFailed({
        delivered: true,
        channels: { slack: { outcome: 'delivered' }, email: skipped('disabled') },
      })
    ).toBe(false);
  });

  it('is false for a reply with no delivery field at all - a rolling deploy, not bad news', () => {
    expect(feedbackDeliveryFailed(undefined)).toBe(false);
    expect(feedbackDeliveryFailed({})).toBe(false);
  });
});

describe('sanitizeFeedbackPagePath', () => {
  it('drops the query string and hash', () => {
    expect(sanitizeFeedbackPagePath('/notebooks?token=abc&q=secret#section')).toBe('/notebooks');
    expect(sanitizeFeedbackPagePath('/admin#top')).toBe('/admin');
  });

  it('masks opaque long segments but keeps route names and object ids', () => {
    expect(sanitizeFeedbackPagePath(`/reset/${'a1'.repeat(20)}`)).toBe('/reset/:redacted');
    expect(sanitizeFeedbackPagePath('/share/123e4567-e89b-12d3-a456-426614174000')).toBe('/share/:redacted');
    expect(sanitizeFeedbackPagePath('/notebooks/507f1f77bcf86cd799439011')).toBe('/notebooks/507f1f77bcf86cd799439011');
  });

  it('masks the whole /share/ param whatever its shape', () => {
    expect(sanitizeFeedbackPagePath('/share/507f1f77bcf86cd799439011,507f191e810c19729de860ea')).toBe(
      '/share/:redacted'
    );
    expect(sanitizeFeedbackPagePath(`/share/${'Ab-_'.repeat(11).slice(0, 43)}`)).toBe('/share/:redacted');
    expect(sanitizeFeedbackPagePath('/share/507f1f77bcf86cd799439011')).toBe('/share/:redacted');
    expect(sanitizeFeedbackPagePath('/share/abc/accept')).toBe('/share/:redacted/accept');
    expect(sanitizeFeedbackPagePath('/share')).toBe('/share');
    expect(sanitizeFeedbackPagePath('/shared/abc')).toBe('/shared/abc');
  });

  it('keeps a long kebab-case slug that has no digit', () => {
    const slug = '/help/getting-started-with-notebooks-and-sessions';
    expect(sanitizeFeedbackPagePath(slug)).toBe(slug);
  });

  it('clips to the path limit', () => {
    const long = `/${'a/'.repeat(500)}`;
    expect(sanitizeFeedbackPagePath(long).length).toBe(FEEDBACK_CLIENT_CONTEXT_LIMITS.path);
  });
});

describe('parseFeedbackClientContext', () => {
  it('keeps known fields, strips unknown ones and ignores a client-supplied userAgent', () => {
    expect(
      parseFeedbackClientContext(
        { path: '/a?b=c', platform: 'ios', appVersion: ' 1.0.0 ', userAgent: 'forged', other: 1 },
        'real'
      )
    ).toEqual({ path: '/a', platform: 'ios', appVersion: '1.0.0', userAgent: 'real' });
  });

  it('clips the request user agent', () => {
    const parsed = parseFeedbackClientContext({}, 'u'.repeat(1000));
    expect(parsed?.userAgent).toHaveLength(FEEDBACK_CLIENT_CONTEXT_LIMITS.userAgent);
  });

  it('degrades a malformed object to the user agent alone', () => {
    expect(parseFeedbackClientContext({ platform: 'toaster' }, 'real')).toEqual({ userAgent: 'real' });
    expect(parseFeedbackClientContext('not an object', 'real')).toEqual({ userAgent: 'real' });
  });

  it('drops an invalid field and keeps the rest', () => {
    expect(
      parseFeedbackClientContext({ platform: 'tablet', viewport: { width: -1, height: 10 }, appVersion: '1.0.0' })
    ).toEqual({ appVersion: '1.0.0' });
    expect(parseFeedbackClientContext({ appVersion: 'v'.repeat(51), path: '/a' })).toEqual({ path: '/a' });
  });

  it('treats a blank or non-string field as absent', () => {
    expect(parseFeedbackClientContext({ model: '   ', path: '?only=query' })).toBeUndefined();
    expect(parseFeedbackClientContext({ path: 42 })).toBeUndefined();
  });

  it('returns undefined when there is nothing to store', () => {
    expect(parseFeedbackClientContext(undefined)).toBeUndefined();
    expect(parseFeedbackClientContext({})).toBeUndefined();
  });
});

describe('isFeedbackTriageNoise', () => {
  it('treats a comment-less thumbs-up as noise but keeps one with a comment', () => {
    expect(isFeedbackTriageNoise({ type: FeedbackType.THUMBS_UP, hasContent: false })).toBe(true);
    expect(isFeedbackTriageNoise({ type: FeedbackType.THUMBS_UP, hasContent: true })).toBe(false);
  });

  it('keeps a comment-less thumbs-down and other report types in the queue', () => {
    expect(isFeedbackTriageNoise({ type: FeedbackType.THUMBS_DOWN, hasContent: false })).toBe(false);
    expect(isFeedbackTriageNoise({ type: FeedbackType.BUG, hasContent: false })).toBe(false);
    expect(isFeedbackTriageNoise({ hasContent: false, tags: [] })).toBe(false);
  });

  it('treats an untyped waitlist-tagged signup as noise, but not a typed report carrying the tag', () => {
    expect(isFeedbackTriageNoise({ hasContent: true, tags: ['comingSoon', 'marketing'] })).toBe(true);
    expect(isFeedbackTriageNoise({ type: FeedbackType.BUG, hasContent: true, tags: ['comingSoon'] })).toBe(false);
  });

  it('treats an empty-string type like a missing one for the waitlist tag', () => {
    expect(isFeedbackTriageNoise({ type: '', hasContent: true, tags: ['comingSoon'] })).toBe(true);
  });
});

describe('hasFeedbackComment', () => {
  it('rejects blank text and the legacy placeholder, accepts real text', () => {
    expect(hasFeedbackComment('')).toBe(false);
    expect(hasFeedbackComment('   ')).toBe(false);
    expect(hasFeedbackComment(` ${NO_FEEDBACK_DETAILS_PLACEHOLDER} `)).toBe(false);
    expect(hasFeedbackComment('nice')).toBe(true);
  });
});
