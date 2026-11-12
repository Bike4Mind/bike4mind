import { describe, it, expect, vi, beforeEach } from 'vitest';

const mocks = vi.hoisted(() => ({ copyTextWithToast: vi.fn() }));

vi.mock('@client/app/utils/copyToClipboard', () => ({ copyTextWithToast: mocks.copyTextWithToast }));

import { copyFeedbackRecordLink, feedbackConversationPath, feedbackReporterMailto } from './feedbackLinks';

describe('copyFeedbackRecordLink', () => {
  beforeEach(() => {
    mocks.copyTextWithToast.mockReset();
  });

  /**
   * The copied link is the one that leaves the app for Slack or a ticket, so it has to be
   * absolute and carry both the tab slug and the record id - a path alone is unusable there.
   */
  it('copies an absolute link that opens the admin tab on this record', () => {
    copyFeedbackRecordLink('fb-1');

    expect(mocks.copyTextWithToast.mock.calls[0][0]).toBe(
      `${window.location.origin}/admin?tab=feedback&feedbackId=fb-1`
    );
  });

  // The slug, not AdminTab's positional number: these links outlive any one deploy.
  it('does not put the tab enum number in the copied link', () => {
    copyFeedbackRecordLink('fb-1');

    expect(mocks.copyTextWithToast.mock.calls[0][0]).toContain('tab=feedback');
    expect(mocks.copyTextWithToast.mock.calls[0][0]).not.toMatch(/tab=\d/);
  });
});

describe('feedbackConversationPath', () => {
  it('links a turn-level report straight at the turn', () => {
    expect(feedbackConversationPath({ sessionId: 'sess-1', questId: 'quest-1' })).toBe(
      '/notebooks/sess-1?questId=quest-1'
    );
  });

  // A session-level report names no turn, so the link degrades to the session rather than
  // building one with an empty questId that ChatHistory would never match.
  it('links a session-level report at the session', () => {
    expect(feedbackConversationPath({ sessionId: 'sess-1' })).toBe('/notebooks/sess-1');
  });

  it('offers no conversation link for a product-level report', () => {
    expect(feedbackConversationPath({})).toBeNull();
  });

  it('escapes ids rather than letting them inject query params', () => {
    expect(feedbackConversationPath({ sessionId: 'sess-1?tab=users', questId: 'q&x=1' })).toBe(
      '/notebooks/sess-1%3Ftab%3Dusers?questId=q%26x%3D1'
    );
  });
});

describe('feedbackReporterMailto', () => {
  // Local noon, so the formatted day is the same in every timezone the suite runs in.
  const createdAt = new Date(2024, 4, 3, 12, 0, 0);
  const report = { userEmail: 'reporter@example.com', content: 'It broke.', createdAt };

  const parse = (mailto: string) => {
    const [target, query = ''] = mailto.replace(/^mailto:/, '').split('?');
    const params = Object.fromEntries(
      query.split('&').map(pair => {
        const [key, value = ''] = pair.split('=');
        return [key, decodeURIComponent(value)];
      })
    );
    return { address: decodeURIComponent(target), subject: params.subject, body: params.body };
  };

  it.each([
    ['empty', ''],
    ['blank', '   '],
    ['missing', undefined],
  ])('offers no draft when the email is %s', (_, userEmail) => {
    expect(feedbackReporterMailto({ ...report, userEmail: userEmail as string })).toBeUndefined();
  });

  it('addresses the reporter, trimmed', () => {
    const mailto = feedbackReporterMailto({ ...report, userEmail: '  reporter@example.com ' });

    expect(mailto).toMatch(/^mailto:reporter%40example\.com\?/);
    expect(parse(mailto!).address).toBe('reporter@example.com');
  });

  it('names the report by the day it was filed', () => {
    expect(parse(feedbackReporterMailto(report)!).subject).toBe('Your Bike4Mind feedback from May 3, 2024');
  });

  it('falls back to a dateless subject when the filing date is unreadable', () => {
    const mailto = feedbackReporterMailto({ ...report, createdAt: 'not a date' as unknown as Date });

    expect(parse(mailto!).subject).toBe('Your Bike4Mind feedback');
  });

  it('quotes every line of the report text', () => {
    const mailto = feedbackReporterMailto({ ...report, content: 'First line.\nSecond line.\r\nThird & last = 100%?' });

    expect(parse(mailto!).body).toBe('> First line.\r\n> Second line.\r\n> Third & last = 100%?');
  });

  it('percent-encodes spaces rather than using plus', () => {
    const mailto = feedbackReporterMailto(report)!;

    expect(mailto).toContain('subject=Your%20Bike4Mind%20feedback%20from%20May%203%2C%202024');
    expect(mailto).not.toContain('+');
  });

  it.each([
    ['missing', undefined],
    ['blank', '  \n '],
  ])('carries no quote when the content is %s', (_, content) => {
    const mailto = feedbackReporterMailto({ ...report, content })!;

    expect(mailto).not.toContain('body=');
    expect(mailto).toContain('subject=');
  });

  // An expired report reads back "[content expired]" in the UI; that is page copy, not the
  // reporter's words, so it must never be quoted to them.
  it('does not quote the expired-content placeholder', () => {
    const mailto = feedbackReporterMailto({ ...report, content: undefined, contentExpired: true } as typeof report);

    expect(mailto).not.toContain('expired');
    expect(mailto).not.toContain('body=');
  });

  it('caps a long report and marks the cut', () => {
    const body = parse(feedbackReporterMailto({ ...report, content: 'a'.repeat(5000) })!).body;

    expect(body).toBe(`> ${'a'.repeat(1500)}\r\n> ...`);
  });

  it('does not mark a cut on a report that fits the cap', () => {
    const body = parse(feedbackReporterMailto({ ...report, content: 'a'.repeat(1500) })!).body;

    expect(body).toBe(`> ${'a'.repeat(1500)}`);
  });

  it('never cuts through a surrogate pair', () => {
    const content = `${'a'.repeat(1499)}\u{1F600}tail`;

    expect(() => feedbackReporterMailto({ ...report, content })).not.toThrow();
    expect(parse(feedbackReporterMailto({ ...report, content })!).body).toBe(`> ${'a'.repeat(1499)}\r\n> ...`);
  });
});
