import { describe, it, expect, vi, beforeEach } from 'vitest';

const mocks = vi.hoisted(() => ({ copyTextWithToast: vi.fn() }));

vi.mock('@client/app/utils/copyToClipboard', () => ({ copyTextWithToast: mocks.copyTextWithToast }));

import { copyFeedbackRecordLink, feedbackConversationPath } from './feedbackLinks';

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
