import { describe, it, expect } from 'vitest';
import {
  ACCOUNT_BANNED_MESSAGE,
  ACCOUNT_DISPUTE_PENDING_MESSAGE,
  ACCOUNT_SUSPENDED_MESSAGE,
  accountBlockReasons,
  accountBlockedMessage,
  aiAccessDeniedMessage,
  AI_ACCESS_PENDING_REVIEW_MESSAGE,
  AI_ACCESS_REVOKED_MESSAGE,
  entersBlockedState,
  isAiAccessRevoked,
  type AccountStateFields,
} from './accountState';

const clean: AccountStateFields = {};

describe('accountBlockReasons', () => {
  it('returns no reasons for a clean account', () => {
    expect(accountBlockReasons(clean)).toEqual([]);
  });

  it('reports each blocking flag', () => {
    expect(accountBlockReasons({ isBanned: true })).toEqual(['banned']);
    expect(accountBlockReasons({ disputePending: true })).toEqual(['disputePending']);
    expect(accountBlockReasons({ moderation: { status: 'suspended' } })).toEqual(['suspended']);
  });

  it('returns every reason in precedence order when several apply', () => {
    expect(accountBlockReasons({ isBanned: true, disputePending: true, moderation: { status: 'suspended' } })).toEqual([
      'banned',
      'disputePending',
      'suspended',
    ]);
  });

  it.each(['suspend_pending', 'throttled', 'active'] as const)('does not block on moderation status %s', status => {
    expect(accountBlockReasons({ moderation: { status } })).toEqual([]);
  });

  it('does not block on a missing moderation record', () => {
    expect(accountBlockReasons({ moderation: undefined })).toEqual([]);
  });
});

describe('entersBlockedState', () => {
  it.each([
    ['ban', { isBanned: true }],
    ['dispute', { disputePending: true }],
    ['suspension', { moderation: { status: 'suspended' as const } }],
  ])('is true when the account becomes %s', (_label, next) => {
    expect(entersBlockedState(clean, next)).toBe(true);
  });

  it('is true when a new reason lands on an already-blocked account', () => {
    // Per-reason entry, not "was clear, now blocked": the rejected `reasons(next).length > reasons(prev).length`
    // variant returns false here, so this pins the behavior the adminUpdate matrix depends on.
    const banned: AccountStateFields = { isBanned: true };
    expect(entersBlockedState(banned, { isBanned: true, disputePending: true })).toBe(true);
  });

  it.each([
    ['an unrelated change', clean, { isBanned: false }],
    ['re-banning a banned account', { isBanned: true }, { isBanned: true }],
    ['re-flagging a disputed account', { disputePending: true }, { disputePending: true }],
    [
      're-suspending a suspended account',
      { moderation: { status: 'suspended' as const } },
      { moderation: { status: 'suspended' as const } },
    ],
    ['unbanning', { isBanned: true }, { isBanned: false }],
    ['suspend_pending', clean, { moderation: { status: 'suspend_pending' as const } }],
    ['throttled', clean, { moderation: { status: 'throttled' as const } }],
    [
      'lifting a suspension',
      { moderation: { status: 'suspended' as const } },
      { moderation: { status: 'active' as const } },
    ],
  ])('is false on %s', (_label, previous, next) => {
    expect(entersBlockedState(previous, next)).toBe(false);
  });
});

describe('isAiAccessRevoked', () => {
  it('revokes AI access for a moderated user', () => {
    expect(isAiAccessRevoked({ isModerated: true })).toBe(true);
  });

  it.each([false, null, undefined])('keeps AI access when isModerated is %s', isModerated => {
    expect(isAiAccessRevoked({ isModerated })).toBe(false);
  });

  it('is not an account block reason, so a moderated user can still sign in', () => {
    expect(accountBlockReasons({ isModerated: true } as AccountStateFields)).toEqual([]);
  });
});

describe('accountBlockedMessage', () => {
  it('names the first block reason and ignores AI-only restrictions', () => {
    expect(accountBlockedMessage({ disputePending: true })).toBe(ACCOUNT_DISPUTE_PENDING_MESSAGE);
    expect(accountBlockedMessage({ isModerated: true } as AccountStateFields)).toBeNull();
    expect(accountBlockedMessage(clean)).toBeNull();
  });
});

describe('aiAccessDeniedMessage', () => {
  it('holds AI access during signup review without blocking sign-in or revoking manual access', () => {
    const user = { isBanned: false, isModerated: false, riskScore: { reviewState: 'pending' as const } };
    expect(aiAccessDeniedMessage(user)).toBe(AI_ACCESS_PENDING_REVIEW_MESSAGE);
    expect(accountBlockReasons(user)).toEqual([]);
    expect(isAiAccessRevoked(user)).toBe(false);
  });

  it.each(['none', 'approved'] as const)('allows AI access for review state %s', reviewState => {
    expect(aiAccessDeniedMessage({ riskScore: { reviewState } })).toBeNull();
  });

  it.each([null, undefined])('allows existing accounts with riskScore %s', riskScore => {
    expect(aiAccessDeniedMessage({ riskScore })).toBeNull();
  });

  it.each(['pending', 'approved'] as const)('preserves a manual restriction when review is %s', reviewState => {
    expect(aiAccessDeniedMessage({ isModerated: true, riskScore: { reviewState } })).toBe(AI_ACCESS_REVOKED_MESSAGE);
  });

  it.each([
    [{ isBanned: true }, ACCOUNT_BANNED_MESSAGE],
    [{ disputePending: true }, ACCOUNT_DISPUTE_PENDING_MESSAGE],
    [{ moderation: { status: 'suspended' as const } }, ACCOUNT_SUSPENDED_MESSAGE],
  ])('denies AI access to a blocked account %o', (state, message) => {
    expect(aiAccessDeniedMessage(state)).toBe(message);
    expect(aiAccessDeniedMessage({ ...state, riskScore: { reviewState: 'approved' } })).toBe(message);
  });

  it('reports the block reason ahead of a manual restriction, in accountBlockReasons order', () => {
    expect(aiAccessDeniedMessage({ isBanned: true, disputePending: true, isModerated: true })).toBe(
      ACCOUNT_BANNED_MESSAGE
    );
  });

  it.each(['suspend_pending', 'throttled'] as const)('does not deny AI access for moderation status %s', status => {
    expect(aiAccessDeniedMessage({ moderation: { status } })).toBeNull();
  });

  it('allows a clean account', () => {
    expect(aiAccessDeniedMessage({ isBanned: false, disputePending: false, isModerated: false })).toBeNull();
  });
});
