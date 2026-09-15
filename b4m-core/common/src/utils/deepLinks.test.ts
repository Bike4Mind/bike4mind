import { describe, expect, it } from 'vitest';
import {
  ADMIN_FEEDBACK_TAB_SLUG,
  ADMIN_TAB_PARAM,
  FEEDBACK_ID_PARAM,
  QUEST_ID_PARAM,
  adminFeedbackRecordPath,
  sessionPath,
  sessionTurnPath,
  toAbsoluteUrl,
} from './deepLinks';

describe('deepLinks', () => {
  it('addresses an admin feedback record by tab slug and id', () => {
    const url = new URL(adminFeedbackRecordPath('fb-1'), 'https://app.example');
    expect(url.pathname).toBe('/admin');
    expect(url.searchParams.get(ADMIN_TAB_PARAM)).toBe(ADMIN_FEEDBACK_TAB_SLUG);
    expect(url.searchParams.get(FEEDBACK_ID_PARAM)).toBe('fb-1');
  });

  it('uses a stable slug rather than the positional AdminTab enum value', () => {
    // A link in a Slack message outlives any reordering of the enum, so the wire format must not
    // be the enum's number.
    expect(adminFeedbackRecordPath('fb-1')).toContain(`${ADMIN_TAB_PARAM}=feedback`);
    expect(adminFeedbackRecordPath('fb-1')).not.toMatch(/tab=\d/);
  });

  it('addresses a session and a turn within it', () => {
    expect(sessionPath('sess-1')).toBe('/notebooks/sess-1');

    const turn = new URL(sessionTurnPath('sess-1', 'quest-1'), 'https://app.example');
    expect(turn.pathname).toBe('/notebooks/sess-1');
    expect(turn.searchParams.get(QUEST_ID_PARAM)).toBe('quest-1');
  });

  it('escapes ids so a crafted id cannot graft extra path or query onto the link', () => {
    const session = new URL(sessionPath('a/../../admin'), 'https://app.example');
    expect(session.pathname).toBe('/notebooks/a%2F..%2F..%2Fadmin');

    const record = new URL(adminFeedbackRecordPath('fb-1&tab=users'), 'https://app.example');
    expect(record.searchParams.get(FEEDBACK_ID_PARAM)).toBe('fb-1&tab=users');
    expect(record.searchParams.get(ADMIN_TAB_PARAM)).toBe(ADMIN_FEEDBACK_TAB_SLUG);
  });

  it('joins an origin whether or not it carries a trailing slash', () => {
    expect(toAbsoluteUrl('https://app.example', '/admin')).toBe('https://app.example/admin');
    expect(toAbsoluteUrl('https://app.example/', '/admin')).toBe('https://app.example/admin');
    expect(toAbsoluteUrl('https://app.example///', '/admin')).toBe('https://app.example/admin');
  });
});
