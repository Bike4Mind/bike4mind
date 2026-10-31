import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { AuthStrategy, PENDING_FREE_CREDITS_TAG } from '@bike4mind/common';
import { ACCOUNT_LINK_VERIFICATION_REQUIRED, ACCOUNT_LINK_EMAIL_MISMATCH } from './oauthAccountLink';
import { ForbiddenError } from '@bike4mind/server-utils/utils/errors';

// Linking an account that promotes emailVerified runs applyEmailVerifiedGrants, which rescores.
const { refreshSignupRiskScore } = vi.hoisted(() => ({ refreshSignupRiskScore: vi.fn(async () => undefined) }));
vi.mock('@server/auth/riskEvidence', () => ({ requestRiskEvidenceRefresh: vi.fn(async () => 'queued') }));
vi.mock('@server/auth/signupRiskScore', () => ({ refreshSignupRiskScore }));

const mockFindOne = vi.fn();
const mockUpdateOne = vi.fn();
const mockCreate = vi.fn();
const mockRevokeAllByUserId = vi.fn();
const mockUserRepositoryUpdate = vi.fn();
const mockClearPending = vi.fn();
const mockClaimFreeCreditGrant = vi.fn();
const mockEndConnections = vi.fn();

// Pulled in transitively by signupDomainGrant; these tests never reach a rule with a subscription.
vi.mock('@server/subscriptions/grantIndividualAdminSubscription', () => ({
  grantIndividualAdminSubscription: vi.fn(),
}));
vi.mock('@bike4mind/database', () => ({
  User: {
    findOne: (...args: unknown[]) => mockFindOne(...args),
    updateOne: (...args: unknown[]) => mockUpdateOne(...args),
    create: (...args: unknown[]) => mockCreate(...args),
  },
  authSessionRepository: { revokeAllByUserId: (...args: unknown[]) => mockRevokeAllByUserId(...args) },
  realtimeConnectionRepository: { endConnections: (...args: unknown[]) => mockEndConnections(...args) },
  adminSettingsRepository: { findBySettingName: async () => null },
  creditTransactionRepository: {},
  creditLotRepository: {},
  organizationRepository: {},
  userRepository: {
    update: (...args: unknown[]) => mockUserRepositoryUpdate(...args),
    clearPendingFreeCreditGrant: (...args: unknown[]) => mockClearPending(...args),
    // The domain grant claims the one-grant-per-inbox entitlement before crediting; these tests
    // are about the callback, so the inbox is always free here.
    claimFreeCreditGrant: (...args: unknown[]) => mockClaimFreeCreditGrant(...args),
  },
}));

const mockEmitVerifiedFunnel = vi.fn();
vi.mock('@server/analytics/funnel', () => ({
  emitEmailVerifiedFunnelEvents: (...args: unknown[]) => mockEmitVerifiedFunnel(...args),
}));

const mockReleasePending = vi.fn();
const mockShouldBlockDisposableEmail = vi.fn();
const mockAddCredits = vi.fn();
const mockApplyPartnerRuleMembership = vi.fn();
const mockRevokeAllUserSessions = vi.hoisted(() => vi.fn());
vi.mock('@bike4mind/services', async importOriginal => {
  const actual = await importOriginal<typeof import('@bike4mind/services')>();
  // The real primitive runs against the repository mocks above, so the best-effort end of the
  // realtime connections is exercised for real; the spy only records the adapters it was given.
  mockRevokeAllUserSessions.mockImplementation(actual.authSessionService.revokeAllUserSessions);
  return {
    authSessionService: {
      revokeAllUserSessions: (...args: Parameters<typeof actual.authSessionService.revokeAllUserSessions>) =>
        mockRevokeAllUserSessions(...args),
    },
    userService: {
      releasePendingFreeCredits: (...args: unknown[]) => mockReleasePending(...args),
      shouldBlockDisposableEmail: (...args: unknown[]) => mockShouldBlockDisposableEmail(...args),
    },
    creditService: { addCredits: (...args: unknown[]) => mockAddCredits(...args) },
    organizationService: {
      applyPartnerRuleMembership: (...args: unknown[]) => mockApplyPartnerRuleMembership(...args),
    },
  };
});

// The real signupDomainGrant helper runs; only its rule lookup and side-effect leaves are stubbed.
const mockPartnerGrant = vi.fn();
vi.mock('@server/entitlements/partnerRules', () => ({
  partnerSignupGrantForEmail: (...args: unknown[]) => mockPartnerGrant(...args),
}));
vi.mock('@server/entitlements/invalidate', () => ({ pushEntitlementInvalidation: vi.fn() }));
vi.mock('@server/organizations/notifySeatCeilingRaised', () => ({
  notifySeatCeilingRaised: vi.fn(),
  notifyPartnerSignupBlockedAtCapacity: vi.fn(),
}));

vi.mock('@server/auth/requireNonSystemUser', () => ({
  requireNonSystemUser: (u: unknown) => u,
}));

// The invite gate reads admin settings; drive it directly instead of stubbing the
// settings repository (the @bike4mind/database mock above deliberately carries only User).
const mockIsOpenRegistrationAllowed = vi.fn();
vi.mock('./openRegistration', () => ({
  isOpenRegistrationAllowed: () => mockIsOpenRegistrationAllowed(),
}));

const mockIsSignupNetworkOverLimit = vi.fn();
const mockCreateSignupRiskCollector = vi.fn();
vi.mock('@server/auth/signupNetworkLimits', () => ({
  isSignupNetworkOverLimit: (...args: unknown[]) => mockIsSignupNetworkOverLimit(...args),
  createSignupRiskCollector: (...args: unknown[]) => mockCreateSignupRiskCollector(...args),
}));
vi.mock('@bike4mind/server-utils/auth/signupGrantRisk', () => ({
  createSignupGrantRiskCollector: (...args: unknown[]) => mockCreateSignupRiskCollector(...args),
}));

import { authSessionRepository, realtimeConnectionRepository } from '@bike4mind/database';
import { selfServeVerifyCallback, verifyCallback } from './verifyCallback';
import { recordTurnstileVerification } from '@server/auth/signupChallenge';

const runStandard = (
  strategy: AuthStrategy,
  profile: Record<string, unknown>
): Promise<{ err: unknown; user: unknown; info: unknown }> =>
  new Promise(resolve => {
    const done = (err: unknown, user?: unknown, info?: unknown) => resolve({ err, user, info });
    verifyCallback(strategy)('access-tok', 'refresh-tok', profile, done);
  });

beforeEach(() => {
  mockFindOne.mockReset();
  mockUpdateOne.mockReset();
  mockCreate.mockReset();
  mockRevokeAllByUserId.mockReset();
  mockRevokeAllByUserId.mockResolvedValue(0);
  mockEndConnections.mockReset();
  mockEndConnections.mockResolvedValue({ connectionIds: [] });
  mockRevokeAllUserSessions.mockClear();
  mockUserRepositoryUpdate.mockReset();
  mockUserRepositoryUpdate.mockResolvedValue(undefined);
  mockClearPending.mockReset();
  mockClearPending.mockImplementation(async (id: string) => ({ id, tags: [] }));
  mockClaimFreeCreditGrant.mockReset();
  // This inbox has not claimed its free-credit grant anywhere else, so the domain grant pays.
  mockClaimFreeCreditGrant.mockResolvedValue(true);
  mockEmitVerifiedFunnel.mockReset();
  mockReleasePending.mockReset();
  mockReleasePending.mockImplementation(async (user: { tags?: string[] | null }) =>
    user.tags?.includes(PENDING_FREE_CREDITS_TAG)
      ? {
          released: true,
          creditsGranted: 100,
          currentCredits: 100,
          patch: { tags: user.tags.filter(tag => tag !== PENDING_FREE_CREDITS_TAG), pendingCreditGrant: null },
        }
      : { released: false, creditsGranted: 0, currentCredits: null, patch: {} }
  );
  mockShouldBlockDisposableEmail.mockReset();
  mockShouldBlockDisposableEmail.mockResolvedValue(false);
  mockAddCredits.mockReset();
  mockAddCredits.mockResolvedValue({ currentCredits: 500 });
  mockApplyPartnerRuleMembership.mockReset();
  mockApplyPartnerRuleMembership.mockResolvedValue({ added: true, reason: 'added' });
  mockPartnerGrant.mockReset();
  mockPartnerGrant.mockResolvedValue({
    matched: false,
    entitlements: new Set(),
    signupCredits: 0,
    organizationId: null,
  });
  // Open by default so the pre-existing create-path tests keep exercising creation.
  mockIsOpenRegistrationAllowed.mockReset();
  mockIsOpenRegistrationAllowed.mockResolvedValue(true);
  mockIsSignupNetworkOverLimit.mockReset();
  mockIsSignupNetworkOverLimit.mockResolvedValue(false);
  mockCreateSignupRiskCollector.mockReset();
  mockCreateSignupRiskCollector.mockImplementation(network => ({ collectorFor: network ?? null }));
});

// Failure-safe restore of any vi.spyOn() (e.g. console.error) so a throwing
// assertion can't leak a spy into later tests in this file.
afterEach(() => {
  vi.restoreAllMocks();
});

// Helper: build a stage-2 mock - stage-1 ($elemMatch by provider id) misses,
// stage-2 ($or by email/username) returns the user.
const stage2Hit = (user: Record<string, unknown>) =>
  mockFindOne.mockResolvedValueOnce(null).mockResolvedValueOnce(user);

describe('verifyCallback - existing user auto-link safety gate', () => {
  const baseProfile = {
    id: 'google-sub-attacker',
    emails: [{ value: 'victim@example.com', verified: true }],
  };

  it('refuses to link when local user emailVerified is false AND the account has a password', async () => {
    // Password present -> reverse-takeover risk retained -> gate stays closed.
    stage2Hit({
      _id: 'u1',
      email: 'victim@example.com',
      emailVerified: false,
      hasUsablePassword: true,
      authProviders: [],
    });

    const { err, user } = await runStandard(AuthStrategy.Google, baseProfile);

    expect(err).toBe(ACCOUNT_LINK_VERIFICATION_REQUIRED);
    expect(user).toBeUndefined();
    expect(mockUpdateOne).not.toHaveBeenCalled();
    expect(mockFindOne).toHaveBeenCalledTimes(2);
  });

  it('links AND promotes emailVerified when local user has no password (pure-OAuth shell)', async () => {
    // No password -> can't be a password-squatter's account -> the provider's
    // verified-email assertion is sufficient; link and promote in one write.
    stage2Hit({
      _id: 'u1',
      email: 'victim@example.com',
      emailVerified: false,
      hasUsablePassword: false,
      authProviders: [],
    });

    const { err, user } = await runStandard(AuthStrategy.Google, baseProfile);

    expect(err).toBeNull();
    expect(user).toBeDefined();
    expect((user as { emailVerified?: boolean }).emailVerified).toBe(true);
    expect(mockUpdateOne).toHaveBeenCalledTimes(1);
    const updateArg = mockUpdateOne.mock.calls[0][1];
    expect(updateArg.$set.emailVerified).toBe(true);
    expect(updateArg.$set.emailVerifiedAt).toBeInstanceOf(Date);
    expect(updateArg.$inc).toEqual({ tokenVersion: 1 });
    expect(mockEmitVerifiedFunnel).toHaveBeenCalledWith({
      user: expect.objectContaining({ _id: 'u1' }),
      method: AuthStrategy.Google,
      creditsGranted: 0,
    });
  });

  it('does NOT promote emailVerified when it was already true (no-op on the happy path)', async () => {
    stage2Hit({
      _id: 'u1',
      email: 'user@example.com',
      emailVerified: true,
      hasUsablePassword: false,
      authProviders: [],
    });

    await runStandard(AuthStrategy.Google, {
      id: 'google-sub-real',
      emails: [{ value: 'user@example.com', verified: true }],
    });

    const updateArg = mockUpdateOne.mock.calls[0][1];
    expect(updateArg.$set.emailVerified).toBeUndefined();
    expect(updateArg.$set.emailVerifiedAt).toBeUndefined();
  });

  it('refuses to promote/link on a username-only match with a null local email (takeover guard)', async () => {
    // Matched by username, not email (local email is null). A cross-provider username
    // collision is NOT an identity assertion, so promoting + backfilling the provider's
    // email onto the emailless passwordless shell would be an account takeover. The link
    // is refused - promotion requires a real verified-email match (present and equal).
    stage2Hit({
      _id: 'u1',
      email: null,
      username: 'victim',
      emailVerified: false,
      hasUsablePassword: false,
      authProviders: [],
    });

    const { err, user } = await runStandard(AuthStrategy.Google, {
      id: 'google-sub-real',
      username: 'victim',
      emails: [{ value: 'attacker@example.com', verified: true }],
    });

    expect(err).toBe(ACCOUNT_LINK_VERIFICATION_REQUIRED);
    expect(user).toBeUndefined();
    expect(mockUpdateOne).not.toHaveBeenCalled();
  });

  it('refuses to link when provider email_verified is false', async () => {
    stage2Hit({ _id: 'u1', email: 'victim@example.com', emailVerified: true, authProviders: [] });

    const { err, user } = await runStandard(AuthStrategy.Google, {
      id: 'google-sub-attacker',
      emails: [{ value: 'victim@example.com', verified: false }],
    });

    expect(err).toBe(ACCOUNT_LINK_VERIFICATION_REQUIRED);
    expect(user).toBeUndefined();
    expect(mockUpdateOne).not.toHaveBeenCalled();
  });

  it('refuses to link when provider gives no verification signal', async () => {
    stage2Hit({ _id: 'u1', email: 'victim@example.com', emailVerified: true, authProviders: [] });

    const { err } = await runStandard(AuthStrategy.Google, {
      id: 'google-sub-attacker',
      emails: [{ value: 'victim@example.com' }],
    });

    expect(err).toBe(ACCOUNT_LINK_VERIFICATION_REQUIRED);
    expect(mockUpdateOne).not.toHaveBeenCalled();
  });

  it('links when BOTH local and provider emails are verified and equal', async () => {
    stage2Hit({ _id: 'u1', email: 'user@example.com', emailVerified: true, authProviders: [] });

    const { err, user } = await runStandard(AuthStrategy.Google, {
      id: 'google-sub-real',
      emails: [{ value: 'user@example.com', verified: true }],
    });

    expect(err).toBeNull();
    expect(user).toBeDefined();
    expect(mockUpdateOne).toHaveBeenCalledTimes(1);
    // Linking a NEW provider bumps tokenVersion: the write nests the
    // provider list under $set and increments tokenVersion to revoke other sessions.
    const updateArg = mockUpdateOne.mock.calls[0][1];
    expect(updateArg.$set.authProviders).toHaveLength(1);
    expect(updateArg.$set.authProviders[0].strategy).toBe(AuthStrategy.Google);
    expect(updateArg.$set.authProviders[0].id).toBe('google-sub-real');
    expect(updateArg.$inc).toEqual({ tokenVersion: 1 });
    expect(mockFindOne).toHaveBeenCalledTimes(2);
    // The tokenVersion bump must be paired with a session revoke, else an opaque refresh token
    // (never checked against tokenVersion) would rotate past the bump and survive.
    expect(mockRevokeAllUserSessions).toHaveBeenCalledWith(
      'u1',
      {},
      { db: { authSessions: authSessionRepository, realtimeConnections: realtimeConnectionRepository } }
    );
    expect(mockRevokeAllByUserId).toHaveBeenCalledWith('u1', {});
    expect(mockEndConnections).toHaveBeenCalledWith({ userId: 'u1', sessionsOnly: true });
  });

  it('still completes the link when ending realtime connections fails', async () => {
    mockEndConnections.mockRejectedValueOnce(new Error('prune failed'));
    stage2Hit({ _id: 'u1', email: 'user@example.com', emailVerified: true, authProviders: [] });

    const { err, user } = await runStandard(AuthStrategy.Google, {
      id: 'google-sub-real',
      emails: [{ value: 'user@example.com', verified: true }],
    });

    expect(err).toBeNull();
    expect(user).toBeDefined();
    expect(mockRevokeAllByUserId).toHaveBeenCalledWith('u1', {});
    expect(mockEndConnections).toHaveBeenCalledTimes(1);
  });

  it('refuses when existing provider entry has DIFFERENT sub (impersonation via takeover of same strategy)', async () => {
    // Stage-1 queries by (strategy, 'google-sub-attacker') - stored id is different so it misses.
    // Password present so the passwordless-shell relaxation doesn't mask this case.
    stage2Hit({
      _id: 'u1',
      email: 'victim@example.com',
      emailVerified: false,
      hasUsablePassword: true,
      authProviders: [{ strategy: AuthStrategy.Google, id: 'google-sub-original' }],
    });

    const { err } = await runStandard(AuthStrategy.Google, {
      id: 'google-sub-attacker',
      emails: [{ value: 'victim@example.com', verified: true }],
    });

    expect(err).toBe(ACCOUNT_LINK_VERIFICATION_REQUIRED);
    expect(mockUpdateOne).not.toHaveBeenCalled();
  });

  it('re-links a DIFFERENT sub for an already-linked strategy and promotes when passwordless (stage-1 miss recovery)', async () => {
    // Same shape as the impersonation test above, but no password: the legacy stored
    // sub no longer matches (e.g. a changed Google sub) - AC2's "stage-1 match missed"
    // dead-end. This is the existingProviderIndex!==-1 branch, whose update call is NOT
    // wrapped in $set (unlike the new-provider path), so it exercises a distinct write shape.
    stage2Hit({
      _id: 'u1',
      email: 'victim@example.com',
      emailVerified: false,
      hasUsablePassword: false,
      authProviders: [{ strategy: AuthStrategy.Google, id: 'google-sub-old' }],
    });

    const { err, user } = await runStandard(AuthStrategy.Google, {
      id: 'google-sub-new',
      emails: [{ value: 'victim@example.com', verified: true }],
    });

    expect(err).toBeNull();
    expect((user as { emailVerified?: boolean }).emailVerified).toBe(true);
    expect(mockUpdateOne).toHaveBeenCalledTimes(1);
    const updateArg = mockUpdateOne.mock.calls[0][1];
    expect(updateArg.authProviders[0].id).toBe('google-sub-new');
    expect(updateArg.emailVerified).toBe(true);
    expect(updateArg.emailVerifiedAt).toBeInstanceOf(Date);
    // Replacing an existing strategy entry is not a NEW link -> no tokenVersion bump.
    expect(updateArg.$inc).toBeUndefined();
    // ...and with no bump there is nothing to pair a session revoke with.
    expect(mockRevokeAllByUserId).not.toHaveBeenCalled();
  });

  it('refreshes tokens without gate when SAME sub re-authenticates (stage-1 hit)', async () => {
    // Stage-1 hits directly - user found via $elemMatch (strategy, id) - one findOne call.
    mockFindOne.mockResolvedValueOnce({
      _id: 'u1',
      email: 'user@example.com',
      emailVerified: false, // gate would fire on stage-2; stage-1 hit bypasses it
      authProviders: [{ strategy: AuthStrategy.Google, id: 'google-sub-stable', accessToken: 'old' }],
    });

    const { err, user } = await runStandard(AuthStrategy.Google, {
      id: 'google-sub-stable',
      emails: [{ value: 'user@example.com' }],
    });

    expect(err).toBeNull();
    expect(user).toBeDefined();
    expect(mockFindOne).toHaveBeenCalledTimes(1); // stage-1 hit — stage-2 never runs
    expect(mockUpdateOne).toHaveBeenCalledTimes(1);
    const updateArg = mockUpdateOne.mock.calls[0][1];
    expect(updateArg.authProviders).toHaveLength(1);
    expect(updateArg.authProviders[0].accessToken).toBe('access-tok');
  });

  it('stage-1 hit resolves user even when handle/email changed (fixes duplicate-account on rename)', async () => {
    // User changed their GitHub handle; stage-1 finds them by (strategy, id) regardless.
    mockFindOne.mockResolvedValueOnce({
      _id: 'u1',
      email: 'old-email@example.com',
      username: 'old-handle',
      emailVerified: false,
      authProviders: [{ strategy: AuthStrategy.Github, id: 'github-id-stable', accessToken: 'old' }],
    });

    const { err, user } = await runStandard(AuthStrategy.Github, {
      id: 'github-id-stable',
      username: 'new-handle', // changed handle
      emails: [{ value: 'new-email@example.com', verified: true }], // changed email
    });

    expect(err).toBeNull();
    expect(user).toBeDefined();
    expect(mockFindOne).toHaveBeenCalledTimes(1); // stage-1 hit only — no stage-2
    expect(mockUpdateOne).toHaveBeenCalledTimes(1);
    // Same provider identity -> no tokenVersion bump (existing provider update, not new link)
    const updateArg = mockUpdateOne.mock.calls[0][1];
    expect(updateArg.$inc).toBeUndefined();
  });

  it('creates a new user on first-time OAuth signup (no existing match)', async () => {
    mockFindOne.mockResolvedValueOnce(null).mockResolvedValueOnce(null);
    mockCreate.mockResolvedValueOnce({
      _id: 'new-user-id',
      email: 'new@example.com',
      emailVerified: false,
    });

    const { err, user } = await runStandard(AuthStrategy.Google, {
      id: 'google-sub-new',
      displayName: 'New User',
      emails: [{ value: 'new@example.com', verified: true }],
    });

    expect(err).toBeNull();
    expect(user).toBeDefined();
    expect(mockCreate).toHaveBeenCalledTimes(1);
    expect(mockUpdateOne).not.toHaveBeenCalled();
  });

  it('SAML profile (verified:true wrapper) passes the gate', async () => {
    stage2Hit({ _id: 'u1', email: 'saml-user@example.com', emailVerified: true, authProviders: [] });

    const { err, user } = await runStandard(AuthStrategy.SAML, {
      id: 'saml-nameid',
      emails: [{ value: 'saml-user@example.com', verified: true }],
    });

    expect(err).toBeNull();
    expect(user).toBeDefined();
    expect(mockUpdateOne).toHaveBeenCalledTimes(1);
  });

  it('rejects when neither email nor username present', async () => {
    // id = null -> stage-1 skipped; no email/username -> Missing Identifier before stage-2
    const { err } = await runStandard(AuthStrategy.Google, {});
    expect(err).toBe('Missing Identifier');
    expect(mockFindOne).not.toHaveBeenCalled();
  });

  it('forwards the target email to passport info so the auth-fail log can record it', async () => {
    // Password present so this exercises the retained (password-account) refusal path.
    stage2Hit({
      _id: 'u1',
      email: 'victim@example.com',
      emailVerified: false,
      hasUsablePassword: true,
      authProviders: [],
    });

    const { err, info } = await runStandard(AuthStrategy.Google, {
      id: 'google-sub-attacker',
      emails: [{ value: 'victim@example.com', verified: true }],
    });

    expect(err).toBe(ACCOUNT_LINK_VERIFICATION_REQUIRED);
    expect(info).toEqual({ email: 'victim@example.com' });
  });

  it('does NOT bypass gate when both stored and incoming id are null (legacy row safety)', async () => {
    // Profile has neither id nor sub -> incoming id = null -> stage-1 guard skips it entirely.
    // Stage-2 finds the user by email/username. The null-id guard on existingSameIdentity
    // then prevents the null===null bypass. Password present so the passwordless-shell
    // relaxation doesn't mask the bypass this test is guarding against.
    mockFindOne.mockResolvedValueOnce({
      _id: 'u1',
      email: 'victim@example.com',
      emailVerified: false,
      hasUsablePassword: true,
      authProviders: [{ strategy: AuthStrategy.Google, id: null }],
    });

    const { err } = await runStandard(AuthStrategy.Google, {
      emails: [{ value: 'victim@example.com', verified: true }],
      username: 'victim',
    });

    expect(err).toBe(ACCOUNT_LINK_VERIFICATION_REQUIRED);
    expect(mockUpdateOne).not.toHaveBeenCalled();
    expect(mockFindOne).toHaveBeenCalledTimes(1); // only stage-2 (stage-1 skipped for null id)
  });

  it('refuses auto-link when provider email differs from local email (takeover-close, Change B)', async () => {
    // Both emails verified but they belong to DIFFERENT people - the email-equality gate
    // must block this. Without it, an attacker with a verified email could link into a victim
    // account via a colliding username.
    stage2Hit({
      _id: 'u1',
      email: 'victim@example.com',
      emailVerified: true,
      authProviders: [],
    });

    const { err, info } = await runStandard(AuthStrategy.Google, {
      id: 'google-sub-attacker',
      emails: [{ value: 'attacker@different.com', verified: true }],
    });

    expect(err).toBe(ACCOUNT_LINK_EMAIL_MISMATCH);
    expect((info as { email: string }).email).toBe('attacker@different.com');
    expect(mockUpdateOne).not.toHaveBeenCalled();
  });

  it('emailless auto-link still refused by verification check (no regression from Change B)', async () => {
    // Provider gives no email; local account has one. The existing verification gate must
    // still fire before we ever reach the email-equality check.
    stage2Hit({
      _id: 'u1',
      email: 'local@example.com',
      emailVerified: true,
      authProviders: [],
    });

    const { err } = await runStandard(AuthStrategy.Github, {
      id: 'github-id-999',
      username: 'no-public-email',
      // no emails array
    });

    // isProviderEmailVerified returns false -> ACCOUNT_LINK_VERIFICATION_REQUIRED
    expect(err).toBe(ACCOUNT_LINK_VERIFICATION_REQUIRED);
    expect(mockUpdateOne).not.toHaveBeenCalled();
  });

  it('selects primary+verified email for match/gate when emails[0] is unverified (Change C)', async () => {
    // emails[0] is unverified secondary; primary is the verified one.
    // selectProviderEmail picks the primary. Gate uses same selected email, so
    // both verified+equal check must pass.
    stage2Hit({
      _id: 'u1',
      email: 'primary@example.com',
      emailVerified: true,
      authProviders: [],
    });

    const { err, user } = await runStandard(AuthStrategy.Google, {
      id: 'google-sub-primary',
      emails: [
        { value: 'secondary@example.com', verified: false },
        { value: 'primary@example.com', verified: true, primary: true },
      ],
    });

    expect(err).toBeNull();
    expect(user).toBeDefined();
    expect(mockUpdateOne).toHaveBeenCalledTimes(1);
  });
});

describe('verifyCallback - SAML identity is scoped to the asserting IDP', () => {
  // A nameID is unique inside one IDP, never across them, and for SAML the stage-1 lookup
  // key IS the nameID. The email-domain bind in server/auth/auth.ts cannot cover this: the
  // attacker's assertion carries an email genuinely inside their own registered domain and
  // puts the victim's identifier in nameID, which stage 1 matches on and the bind never
  // inspects. So the IDP has to be part of the match itself.
  const VICTIM = {
    _id: 'victim-id',
    email: 'victim@acme.com',
    emailVerified: true,
    hasUsablePassword: true,
    authProviders: [{ strategy: AuthStrategy.SAML, id: 'victim@acme.com', samlIdentityProviderId: 'idp-acme' }],
  };

  // Stands in for Mongo: an $elemMatch matches only when EVERY clause matches the stored
  // entry, which is the whole point of adding the IDP clause. Without it the mock returns
  // the victim, exactly as the database would.
  const mongoLikeFindOne = () =>
    mockFindOne.mockImplementation((query: Record<string, any>) => {
      const elemMatch = query?.authProviders?.$elemMatch;
      if (!elemMatch) return Promise.resolve(null); // stage 2: nothing owns the attacker's email
      const entry = VICTIM.authProviders[0] as Record<string, unknown>;
      const matches = Object.entries(elemMatch).every(([field, value]) => entry[field] === value);
      return Promise.resolve(matches ? { ...VICTIM } : null);
    });

  const runSaml = (profile: Record<string, unknown>, samlIdentityProviderId: string) =>
    new Promise<{ err: unknown; user: any; info: unknown }>(resolve => {
      const done = (err: unknown, user?: unknown, info?: unknown) => resolve({ err, user, info });
      verifyCallback(AuthStrategy.SAML)('access-tok', 'refresh-tok', profile, done, {
        strategy: AuthStrategy.SAML,
        samlNameId: profile.id as string,
        samlIdentityProviderId,
      });
    });

  it("refuses to resolve another IDP's user from a colliding nameID", async () => {
    mongoLikeFindOne();
    mockCreate.mockImplementation(async (doc: Record<string, unknown>) => ({ _id: 'new-id', ...doc }));

    // partner.com's IDP asserts an email inside its OWN domain (so the domain bind passes)
    // while naming the acme.com victim in nameID.
    const { user } = await runSaml(
      { id: 'victim@acme.com', emails: [{ value: 'attacker@partner.com', verified: true }] },
      'idp-partner'
    );

    // The victim must not be the resolved account, and must not be touched.
    expect(user?._id).not.toBe('victim-id');
    expect(user?.email).not.toBe('victim@acme.com');
    expect(mockUpdateOne).not.toHaveBeenCalled();

    // And the reason it cannot be: the IDP is part of the stage-1 match.
    expect(mockFindOne).toHaveBeenCalledWith({
      authProviders: {
        $elemMatch: expect.objectContaining({
          strategy: AuthStrategy.SAML,
          id: 'victim@acme.com',
          samlIdentityProviderId: 'idp-partner',
        }),
      },
    });
  });

  it('still resolves the user when the same IDP re-asserts its own nameID', async () => {
    mongoLikeFindOne();

    const { err, user } = await runSaml(
      { id: 'victim@acme.com', emails: [{ value: 'victim@acme.com', verified: true }] },
      'idp-acme'
    );

    expect(err).toBeNull();
    expect(user?._id).toBe('victim-id');
    // Same (nameID, IDP) identity, so this is a refresh: no re-linking gate, no revoke.
    expect(mockUpdateOne).toHaveBeenCalledTimes(1);
    expect(mockUpdateOne.mock.calls[0][1].$inc).toBeUndefined();
  });

  it('leaves strategies without a per-IDP discriminator unscoped', async () => {
    mockFindOne.mockResolvedValueOnce({
      _id: 'u1',
      email: 'user@example.com',
      emailVerified: true,
      authProviders: [{ strategy: AuthStrategy.Google, id: 'google-sub' }],
    });

    await runStandard(AuthStrategy.Google, {
      id: 'google-sub',
      emails: [{ value: 'user@example.com', verified: true }],
    });

    // No samlIdentityProviderId clause smuggled into a Google lookup.
    expect(mockFindOne).toHaveBeenCalledWith({
      authProviders: { $elemMatch: { strategy: AuthStrategy.Google, id: 'google-sub' } },
    });
  });
});

describe('verifyCallback - new user creation username field', () => {
  it('stores the provider username (handle) not the displayName so second login finds the user', async () => {
    mockFindOne.mockResolvedValueOnce(null).mockResolvedValueOnce(null);
    mockCreate.mockResolvedValueOnce({ _id: 'new-id', username: 'aanderson' });

    await runStandard(AuthStrategy.Github, {
      id: 'github-id-123',
      username: 'aanderson',
      displayName: 'Alice Anderson',
      emails: [{ value: 'alice@example.com', verified: true }],
    });

    expect(mockCreate).toHaveBeenCalledTimes(1);
    const createArg = mockCreate.mock.calls[0][0];
    expect(createArg.username).toBe('aanderson');
    expect(createArg.name).toBe('Alice Anderson');
  });

  it('falls back to displayName when provider returns no username', async () => {
    mockFindOne.mockResolvedValueOnce(null).mockResolvedValueOnce(null);
    mockCreate.mockResolvedValueOnce({ _id: 'new-id', username: 'Pat Smith' });

    await runStandard(AuthStrategy.Github, {
      id: 'github-id-456',
      displayName: 'Pat Smith',
      emails: [{ value: 'pat@example.com', verified: true }],
    });

    expect(mockCreate).toHaveBeenCalledTimes(1);
    const createArg = mockCreate.mock.calls[0][0];
    expect(createArg.username).toBe('Pat Smith');
    expect(createArg.name).toBe('Pat Smith');
  });
});

describe('verifyCallback - catch block surfaces the error', () => {
  it("logs the exception and attaches a canonical duplicate_account code - raw E11000 text (which can embed another user's identifier) stays in info.message for CloudWatch only, never as the reason itself", async () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    mockFindOne.mockResolvedValueOnce(null).mockResolvedValueOnce(null);
    mockCreate.mockRejectedValueOnce(
      Object.assign(new Error('E11000 duplicate key error: dup key: { username: "victim@example.com" }'), {
        code: 11000,
      })
    );

    const { err, user, info } = await runStandard(AuthStrategy.Github, {
      id: 'github-id-789',
      username: 'dupe-handle',
      emails: [{ value: 'dupe@example.com', verified: true }],
    });

    // done(null, undefined, { code, message }) - no user, but a canonical reason
    expect(err).toBeNull();
    expect(user).toBeUndefined();
    expect((info as { code: string }).code).toBe('duplicate_account');
    expect((info as { message: string }).message).toContain('E11000');
    expect(errorSpy).toHaveBeenCalledWith('[verifyCallback] authenticateUser threw:', expect.any(Error));
    // Spy restored failure-safely by the file-level afterEach.
  });

  it('attaches forbidden_system_user for a ForbiddenError thrown mid-authentication', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    mockFindOne.mockResolvedValueOnce(null).mockResolvedValueOnce(null);
    mockCreate.mockRejectedValueOnce(new ForbiddenError('Cannot authenticate as a system account'));

    const { err, info } = await runStandard(AuthStrategy.Github, {
      id: 'github-id-sys',
      username: 'system-handle',
      emails: [{ value: 'sys@example.com', verified: true }],
    });

    expect(err).toBeNull();
    expect((info as { code: string }).code).toBe('forbidden_system_user');
  });

  it('default-denies any other thrown error to internal', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    mockFindOne.mockResolvedValueOnce(null).mockResolvedValueOnce(null);
    mockCreate.mockRejectedValueOnce(new Error('connection reset'));

    const { err, info } = await runStandard(AuthStrategy.Github, {
      id: 'github-id-other',
      username: 'other-handle',
      emails: [{ value: 'other@example.com', verified: true }],
    });

    expect(err).toBeNull();
    expect((info as { code: string }).code).toBe('internal');
  });
});

describe('verifyCallback - OAuth create: username dedupe on collision', () => {
  // Real MongoDB E11000 shape includes `code`, `keyPattern`, `keyValue` directly on
  // the thrown error (verified against a live duplicate-key error during the incident
  // this fix closes).
  const usernameDupErr = () =>
    Object.assign(new Error('E11000 duplicate key error collection: dev.users index: username_1'), {
      code: 11000,
      keyPattern: { username: 1 },
      keyValue: { username: 'Ken Wallace' },
    });

  it('dedupes with a numeric suffix when the base username is already taken', async () => {
    mockFindOne.mockResolvedValueOnce(null).mockResolvedValueOnce(null);
    mockCreate
      .mockRejectedValueOnce(usernameDupErr())
      .mockResolvedValueOnce({ _id: 'new-id', username: 'Ken Wallace 2' });

    const { err, user } = await runStandard(AuthStrategy.Google, {
      id: 'google-sub-kw',
      displayName: 'Ken Wallace',
      emails: [{ value: 'ken@bike4mind.com', verified: true }],
    });

    expect(err).toBeNull();
    expect(user).toBeDefined();
    expect(mockCreate).toHaveBeenCalledTimes(2);
    expect(mockCreate.mock.calls[0][0].username).toBe('Ken Wallace');
    expect(mockCreate.mock.calls[1][0].username).toBe('Ken Wallace 2');
  });

  it('retries through multiple numeric suffixes, then a short random suffix, before giving up', async () => {
    mockFindOne.mockResolvedValueOnce(null).mockResolvedValueOnce(null);
    // 5 collisions (base, base 2, base 3, base 4, base 5); the 6th attempt (random suffix) succeeds.
    for (let i = 0; i < 5; i++) mockCreate.mockRejectedValueOnce(usernameDupErr());
    mockCreate.mockResolvedValueOnce({ _id: 'new-id', username: 'taken-abc123' });

    const { err, user } = await runStandard(AuthStrategy.Google, {
      id: 'google-sub-taken',
      displayName: 'taken',
      emails: [{ value: 'taken@example.com', verified: true }],
    });

    expect(err).toBeNull();
    expect(user).toBeDefined();
    expect(mockCreate).toHaveBeenCalledTimes(6);
    expect(mockCreate.mock.calls.map(c => c[0].username)).toEqual([
      'taken',
      'taken 2',
      'taken 3',
      'taken 4',
      'taken 5',
      expect.stringMatching(/^taken-[a-f0-9]{6}$/),
    ]);
  });

  it('fails clean after exhausting all retries instead of looping forever', async () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    mockFindOne.mockResolvedValueOnce(null).mockResolvedValueOnce(null);
    for (let i = 0; i < 6; i++) mockCreate.mockRejectedValueOnce(usernameDupErr());

    const { err, user, info } = await runStandard(AuthStrategy.Google, {
      id: 'google-sub-alwaystaken',
      displayName: 'alwaystaken',
      emails: [{ value: 'alwaystaken@example.com', verified: true }],
    });

    expect(mockCreate).toHaveBeenCalledTimes(6); // bounded - never retries forever
    expect(err).toBeNull();
    expect(user).toBeUndefined();
    expect((info as { message: string }).message).toContain('E11000');
    expect(errorSpy).toHaveBeenCalled();
  });

  it('does NOT retry on an email-index collision - fails clean rather than risking a duplicate-email account', async () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    mockFindOne.mockResolvedValueOnce(null).mockResolvedValueOnce(null);
    const emailDupErr = Object.assign(new Error('E11000 duplicate key error collection: dev.users index: email_1'), {
      code: 11000,
      keyPattern: { email: 1 },
      keyValue: { email: 'race@example.com' },
    });
    mockCreate.mockRejectedValueOnce(emailDupErr);

    const { err, user, info } = await runStandard(AuthStrategy.Google, {
      id: 'google-sub-race',
      displayName: 'Race Condition',
      emails: [{ value: 'race@example.com', verified: true }],
    });

    expect(mockCreate).toHaveBeenCalledTimes(1); // no retry attempted on a non-username collision
    expect(err).toBeNull();
    expect(user).toBeUndefined();
    expect((info as { message: string }).message).toContain('E11000');
    expect(errorSpy).toHaveBeenCalled();
  });

  it('derives a fallback username from the email local-part when the provider gives no username or displayName', async () => {
    mockFindOne.mockResolvedValueOnce(null).mockResolvedValueOnce(null);
    mockCreate.mockResolvedValueOnce({ _id: 'new-id', username: 'nodisplay' });

    await runStandard(AuthStrategy.Google, {
      id: 'google-sub-nodisplay',
      username: '', // Google never sends this, but be defensive about an empty string
      emails: [{ value: 'nodisplay@example.com', verified: true }],
    });

    expect(mockCreate).toHaveBeenCalledTimes(1);
    expect(mockCreate.mock.calls[0][0].username).toBe('nodisplay');
  });

  it('never creates with an empty name (required field) - falls back to the derived username', async () => {
    // A minimal provider assertion: only an email, no displayName/name/username. Without
    // the fallback, `name: ''` would throw a non-E11000 validation error and lock the user
    // out - the same class of opaque OAuth-create failure this helper prevents.
    mockFindOne.mockResolvedValueOnce(null).mockResolvedValueOnce(null);
    mockCreate.mockResolvedValueOnce({ _id: 'new-id', username: 'onlyemail', name: 'onlyemail' });

    await runStandard(AuthStrategy.Google, {
      id: 'google-sub-onlyemail',
      emails: [{ value: 'onlyemail@example.com', verified: true }],
    });

    expect(mockCreate).toHaveBeenCalledTimes(1);
    const createArg = mockCreate.mock.calls[0][0];
    expect(createArg.name).toBeTruthy();
    expect(createArg.name).toBe('onlyemail'); // derived username reused as the name
    expect(createArg.username).toBe('onlyemail');
  });

  it('derives a random fallback username when even the email local-part is empty', async () => {
    mockFindOne.mockResolvedValueOnce(null).mockResolvedValueOnce(null);
    mockCreate.mockResolvedValueOnce({ _id: 'new-id', username: 'user-abc12345' });

    await runStandard(AuthStrategy.Google, {
      id: 'google-sub-emptylocal',
      username: '',
      emails: [{ value: '@example.com', verified: true }],
    });

    expect(mockCreate).toHaveBeenCalledTimes(1);
    expect(mockCreate.mock.calls[0][0].username).toMatch(/^user-[a-f0-9]{8}$/);
  });
});

describe('verifyCallback - OAuth create: a provider-verified email is required', () => {
  it.each([
    ['marks it unverified', [{ value: 'victim@example.com', verified: false }]],
    ['gives no verification signal', [{ value: 'victim@example.com' }]],
  ])('refuses a Google sign-up when the provider %s', async (_label, emails) => {
    mockFindOne.mockResolvedValueOnce(null).mockResolvedValueOnce(null);

    const { err, user, info } = await runStandard(AuthStrategy.Google, {
      id: 'google-sub-attacker',
      username: 'attacker',
      emails,
    });

    expect(err).toBeNull();
    expect(user).toBeUndefined();
    expect(info).toEqual({ code: 'signup_email_unverified' });
    expect(mockCreate).not.toHaveBeenCalled();
  });

  it('refuses a GitHub sign-up whose profile carries no email', async () => {
    mockFindOne.mockResolvedValueOnce(null).mockResolvedValueOnce(null);

    const { user, info } = await runStandard(AuthStrategy.Github, { id: 'gh-1', username: 'noemail' });

    expect(user).toBeUndefined();
    expect(info).toEqual({ code: 'signup_email_unverified' });
    expect(mockCreate).not.toHaveBeenCalled();
  });

  it('refuses a GitHub sign-up when none of its emails is verified', async () => {
    mockFindOne.mockResolvedValueOnce(null).mockResolvedValueOnce(null);

    const { info } = await runStandard(AuthStrategy.Github, {
      id: 'gh-2',
      username: 'unverified',
      emails: [{ value: 'unverified@example.com', primary: true, verified: false }],
    });

    expect(info).toEqual({ code: 'signup_email_unverified' });
    expect(mockCreate).not.toHaveBeenCalled();
  });

  it('persists the email on create when the provider marks it verified', async () => {
    mockFindOne.mockResolvedValueOnce(null).mockResolvedValueOnce(null);
    mockCreate.mockResolvedValueOnce({ _id: 'new-id', email: 'real@example.com' });

    await runStandard(AuthStrategy.Google, {
      id: 'google-sub-real',
      displayName: 'Real User',
      emails: [{ value: 'real@example.com', verified: true }],
    });

    expect(mockCreate.mock.calls[0][0].email).toBe('real@example.com');
  });

  it('SAML create persists the email (IdP-attested, verified:true by construction)', async () => {
    mockFindOne.mockResolvedValueOnce(null).mockResolvedValueOnce(null);
    mockCreate.mockResolvedValueOnce({ _id: 'new-id', email: 'saml-user@example.com' });

    await runStandard(AuthStrategy.SAML, {
      id: 'saml-nameid',
      emails: [{ value: 'saml-user@example.com', verified: true }],
    });

    expect(mockCreate.mock.calls[0][0].email).toBe('saml-user@example.com');
  });

  it('leaves an existing account without a verified provider email signing in as before', async () => {
    mockFindOne.mockResolvedValueOnce({
      _id: 'u-existing',
      username: 'noemail',
      authProviders: [{ strategy: AuthStrategy.Github, id: 'gh-1' }],
    });

    const { user, info } = await runStandard(AuthStrategy.Github, { id: 'gh-1', username: 'noemail' });

    expect(user).toMatchObject({ _id: 'u-existing' });
    expect(info).toBeUndefined();
    expect(mockCreate).not.toHaveBeenCalled();
  });
});

describe('verifyCallback - OAuth create: blocked email domains', () => {
  const profile = {
    id: 'google-sub-burner',
    displayName: 'Burner',
    emails: [{ value: 'Someone@Burner.example ', verified: true }],
  };

  it.each([AuthStrategy.Google, AuthStrategy.Github])(
    'refuses a %s sign-up on a domain the shared gate blocks',
    async strategy => {
      mockFindOne.mockResolvedValueOnce(null).mockResolvedValueOnce(null);
      mockShouldBlockDisposableEmail.mockResolvedValue(true);

      const { err, user, info } = await runStandard(strategy, profile);

      expect(err).toBeNull();
      expect(user).toBeUndefined();
      expect(info).toEqual({ code: 'signup_email_blocked', email: 'someone@burner.example' });
      expect(mockShouldBlockDisposableEmail).toHaveBeenCalledWith('someone@burner.example', expect.anything());
      expect(mockCreate).not.toHaveBeenCalled();
    }
  );

  it('fails closed when the domain lists cannot be read', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    mockFindOne.mockResolvedValueOnce(null).mockResolvedValueOnce(null);
    mockShouldBlockDisposableEmail.mockRejectedValue(new Error('settings down'));

    const { user, info } = await runStandard(AuthStrategy.Google, profile);

    expect(user).toBeUndefined();
    expect((info as { code: string }).code).toBe('internal');
    expect(mockCreate).not.toHaveBeenCalled();
  });

  it('does not apply to enterprise SSO sign-ups', async () => {
    mockFindOne.mockResolvedValueOnce(null).mockResolvedValueOnce(null);
    mockShouldBlockDisposableEmail.mockResolvedValue(true);
    mockCreate.mockResolvedValueOnce({ _id: 'u-saml' });

    const { user } = await runStandard(AuthStrategy.SAML, profile);

    expect(user).toBeDefined();
    expect(mockShouldBlockDisposableEmail).not.toHaveBeenCalled();
  });

  it('lets an existing account on a blocked domain keep signing in', async () => {
    mockShouldBlockDisposableEmail.mockResolvedValue(true);
    mockFindOne.mockResolvedValueOnce({
      _id: 'u-existing',
      email: 'someone@burner.example',
      emailVerified: true,
      authProviders: [{ strategy: AuthStrategy.Google, id: 'google-sub-burner' }],
    });

    const { user } = await runStandard(AuthStrategy.Google, profile);

    expect(user).toMatchObject({ _id: 'u-existing' });
    expect(mockShouldBlockDisposableEmail).not.toHaveBeenCalled();
    expect(mockCreate).not.toHaveBeenCalled();
  });
});

describe('verifyCallback - Google "with params" callback signature', () => {
  it('strips the params arg and forwards profile + done correctly', async () => {
    mockFindOne.mockResolvedValueOnce(null);
    mockCreate.mockResolvedValueOnce({ _id: 'new-id', email: 'g@example.com' });

    await new Promise<void>(resolve => {
      verifyCallback(AuthStrategy.Google)(
        'access-tok',
        'refresh-tok',
        { idToken: 'fake' }, // params
        { id: 'g-sub', emails: [{ value: 'g@example.com', verified: true }] }, // profile
        (err: unknown, user: unknown) => {
          expect(err).toBeNull();
          expect(user).toBeDefined();
          resolve();
        }
      );
    });

    expect(mockCreate).toHaveBeenCalledTimes(1);
  });
});

describe('verifyCallback - invite gate on federated first login', () => {
  const freshProfile = {
    id: 'sub-new',
    displayName: 'New Person',
    emails: [{ value: 'new@example.com', verified: true }],
  };

  // No existing account: both lookup stages miss, so this is the create path.
  const noExistingUser = () => mockFindOne.mockResolvedValue(null);

  it('refuses a Google first login on an invite-only instance', async () => {
    noExistingUser();
    mockIsOpenRegistrationAllowed.mockResolvedValue(false);

    const { user, info } = await runStandard(AuthStrategy.Google, freshProfile);

    expect(user).toBeFalsy();
    expect(info).toMatchObject({ code: 'registration_closed' });
    expect(mockCreate).not.toHaveBeenCalled();
  });

  it('refuses a GitHub first login on an invite-only instance', async () => {
    noExistingUser();
    mockIsOpenRegistrationAllowed.mockResolvedValue(false);

    const { user } = await runStandard(AuthStrategy.Github, freshProfile);

    expect(user).toBeFalsy();
    expect(mockCreate).not.toHaveBeenCalled();
  });

  it('exempts enterprise SSO: a SAML first login still creates the account', async () => {
    noExistingUser();
    mockIsOpenRegistrationAllowed.mockResolvedValue(false);
    mockCreate.mockResolvedValue({ _id: 'u-saml', email: 'new@example.com' });

    const { user } = await runStandard(AuthStrategy.SAML, freshProfile);

    expect(user).toBeTruthy();
    expect(mockCreate).toHaveBeenCalled();
    // The gate is never even consulted for SSO.
    expect(mockIsOpenRegistrationAllowed).not.toHaveBeenCalled();
  });

  it('allows a Google first login when open registration is on', async () => {
    noExistingUser();
    mockCreate.mockResolvedValue({ _id: 'u-google', email: 'new@example.com' });

    const { user } = await runStandard(AuthStrategy.Google, freshProfile);

    expect(user).toBeTruthy();
    expect(mockCreate).toHaveBeenCalled();
  });

  it('reports registration_closed ahead of the email checks on an invite-only instance', async () => {
    noExistingUser();
    mockIsOpenRegistrationAllowed.mockResolvedValue(false);
    mockShouldBlockDisposableEmail.mockResolvedValue(true);

    const { info } = await runStandard(AuthStrategy.Google, {
      ...freshProfile,
      emails: [{ value: 'new@example.com', verified: false }],
    });

    expect(info).toMatchObject({ code: 'registration_closed' });
    expect(mockShouldBlockDisposableEmail).not.toHaveBeenCalled();
    expect(mockCreate).not.toHaveBeenCalled();
  });
});

describe('verifyCallback - partner-domain bypass of the invite gate', () => {
  const partnerProfile = (verified: boolean | undefined, email = 'new@partner.example') => ({
    id: 'sub-partner',
    displayName: 'Partner Person',
    emails: [{ value: email, ...(verified === undefined ? {} : { verified }) }],
  });
  const matchedGrant = {
    matched: true,
    ruleId: 'rule-1',
    domain: 'partner.example',
    entitlements: new Set(),
    signupCredits: 0,
    organizationId: null,
    tags: [],
    subscription: null,
  };

  beforeEach(() => {
    mockFindOne.mockResolvedValue(null);
    mockIsOpenRegistrationAllowed.mockResolvedValue(false);
    mockCreate.mockImplementation(async (doc: Record<string, unknown>) => ({ _id: 'u-partner', ...doc }));
  });

  it.each([AuthStrategy.Google, AuthStrategy.Github])(
    'lets a %s first login with a verified email on an enabled partner rule register',
    async strategy => {
      mockPartnerGrant.mockResolvedValue(matchedGrant);

      const { user, info } = await runStandard(strategy, partnerProfile(true));

      expect(user).toBeTruthy();
      expect(info).toBeUndefined();
      expect(mockCreate).toHaveBeenCalled();
      expect(mockPartnerGrant).toHaveBeenCalledWith('new@partner.example', true);
    }
  );

  it.each([AuthStrategy.Google, AuthStrategy.Github])(
    'still refuses a %s first login whose domain has no enabled rule',
    async strategy => {
      const { user, info } = await runStandard(strategy, partnerProfile(true, 'new@other.example'));

      expect(user).toBeFalsy();
      expect(info).toMatchObject({ code: 'registration_closed' });
      expect(mockCreate).not.toHaveBeenCalled();
    }
  );

  it.each([false, undefined])('refuses a partner-domain email the provider marked verified=%s', async verified => {
    mockPartnerGrant.mockResolvedValue(matchedGrant);

    const { user, info } = await runStandard(AuthStrategy.Google, partnerProfile(verified));

    expect(user).toBeFalsy();
    expect(info).toMatchObject({ code: 'registration_closed' });
    expect(mockCreate).not.toHaveBeenCalled();
    // An unverified email never reaches the rule lookup.
    expect(mockPartnerGrant).not.toHaveBeenCalled();
  });

  it('does not consult the rules when open registration is on', async () => {
    mockIsOpenRegistrationAllowed.mockResolvedValue(true);

    const { user } = await runStandard(AuthStrategy.Google, partnerProfile(true, 'new@other.example'));

    expect(user).toBeTruthy();
    // The only lookup is the post-create signup grant, never the gate.
    expect(mockPartnerGrant).toHaveBeenCalledTimes(1);
  });

  it.each([AuthStrategy.Google, AuthStrategy.Github])(
    'adds the partner bonus to the default grant on an invite-only %s signup',
    async strategy => {
      mockPartnerGrant.mockResolvedValue({ ...matchedGrant, signupCredits: 500 });

      const { user, info } = await runStandard(strategy, partnerProfile(true));

      expect(user).toBeTruthy();
      expect(info).toBeUndefined();
      expect(mockReleasePending).toHaveBeenCalledWith(
        expect.objectContaining({ id: 'u-partner', tags: [PENDING_FREE_CREDITS_TAG] }),
        expect.anything()
      );
      expect(mockAddCredits).toHaveBeenCalledWith(
        expect.objectContaining({
          ownerId: 'u-partner',
          credits: 500,
          transactionId: 'domain-grant-credits:u-partner',
        }),
        expect.anything()
      );
    }
  );
});

describe('verifyCallback - starter credits on OAuth signup', () => {
  const verifiedProfile = {
    id: 'provider-id-1',
    displayName: 'Pat Smith',
    emails: [{ value: 'pat@example.com', verified: true }],
  };

  beforeEach(() => {
    mockFindOne.mockResolvedValueOnce(null).mockResolvedValueOnce(null);
    mockCreate.mockImplementationOnce(async (doc: Record<string, unknown>) => ({ _id: 'new-id', ...doc }));
  });

  it.each([AuthStrategy.Google, AuthStrategy.Github])(
    'creates a new %s user tagged pending-free-credits, then releases and persists the grant',
    async strategy => {
      const { err, user } = await runStandard(strategy, verifiedProfile);

      expect(err).toBeNull();
      expect(user).toBeDefined();
      expect(mockCreate).toHaveBeenCalledWith(expect.objectContaining({ tags: [PENDING_FREE_CREDITS_TAG] }));
      expect(mockReleasePending).toHaveBeenCalledWith(
        expect.objectContaining({ id: 'new-id', tags: [PENDING_FREE_CREDITS_TAG] }),
        expect.objectContaining({ reason: 'OAuth signup (provider-verified email)' })
      );
      expect(mockClearPending).toHaveBeenCalledWith('new-id');
      expect((user as { signupCreditsGranted?: number }).signupCreditsGranted).toBe(100);
    }
  );

  it('does not tag or grant for an enterprise SSO strategy', async () => {
    const { err, user } = await runStandard(AuthStrategy.SAML, verifiedProfile);

    expect(err).toBeNull();
    expect(mockCreate).toHaveBeenCalledTimes(1);
    expect(mockCreate.mock.calls[0][0]).not.toHaveProperty('tags');
    expect(mockReleasePending).not.toHaveBeenCalled();
    expect((user as { signupCreditsGranted?: number }).signupCreditsGranted).toBe(0);
  });

  it('keeps the tag (no tag-strip write) and completes the login when the grant fails', async () => {
    mockReleasePending.mockResolvedValue({ released: false, creditsGranted: 0, currentCredits: null, patch: {} });

    const { err, user } = await runStandard(AuthStrategy.Google, verifiedProfile);

    expect(err).toBeNull();
    expect(user).toBeDefined();
    expect(mockCreate).toHaveBeenCalledWith(expect.objectContaining({ tags: [PENDING_FREE_CREDITS_TAG] }));
    expect(mockClearPending).not.toHaveBeenCalled();
  });

  it('completes the login when persisting the tag removal fails', async () => {
    mockClearPending.mockRejectedValue(new Error('db down'));

    const { err, user } = await runStandard(AuthStrategy.Google, verifiedProfile);

    expect(err).toBeNull();
    expect(user).toBeDefined();
  });
});

describe('verifyCallback - partner domain grant on OAuth signup', () => {
  const partnerProfile = {
    id: 'provider-id-2',
    displayName: 'Dee Partner',
    emails: [{ value: 'dee@partner.example', verified: true }],
  };

  beforeEach(() => {
    mockFindOne.mockResolvedValueOnce(null).mockResolvedValueOnce(null);
    mockCreate.mockImplementationOnce(async (doc: Record<string, unknown>) => ({ _id: 'new-id', ...doc }));
    mockPartnerGrant.mockResolvedValue({
      matched: true,
      entitlements: new Set(['optihashi:pro']),
      signupCredits: 1000,
      organizationId: 'org-1',
    });
  });

  it.each([AuthStrategy.Google, AuthStrategy.Github, AuthStrategy.SAML])(
    'grants the domain credits and partner org membership to a new %s user',
    async strategy => {
      const { err } = await runStandard(strategy, partnerProfile);

      expect(err).toBeNull();
      expect(mockPartnerGrant).toHaveBeenCalledWith('dee@partner.example', true);
      expect(mockAddCredits).toHaveBeenCalledWith(
        expect.objectContaining({ ownerId: 'new-id', credits: 1000, transactionId: 'domain-grant-credits:new-id' }),
        expect.objectContaining({ db: expect.objectContaining({ creditLots: expect.anything() }) })
      );
      expect(mockApplyPartnerRuleMembership).toHaveBeenCalledWith(
        { userId: 'new-id', organizationId: 'org-1' },
        expect.anything()
      );
    }
  );

  it('completes the login when the domain credit grant and membership both fail', async () => {
    mockAddCredits.mockRejectedValue(new Error('ledger down'));
    mockApplyPartnerRuleMembership.mockRejectedValue(new Error('org store down'));

    const { err, user } = await runStandard(AuthStrategy.Google, partnerProfile);

    expect(err).toBeNull();
    expect(user).toBeDefined();
  });

  it('completes the login when the partner rule lookup fails', async () => {
    mockPartnerGrant.mockRejectedValue(new Error('rules down'));

    const { err, user } = await runStandard(AuthStrategy.Google, partnerProfile);

    expect(err).toBeNull();
    expect(user).toBeDefined();
    expect(mockAddCredits).not.toHaveBeenCalled();
  });
});

describe('verifyCallback - pending free credits on account link', () => {
  const linkProfile = {
    id: 'google-sub-link',
    emails: [{ value: 'owner@example.com', verified: true }],
  };

  it('releases and persists a pending grant when the link promotes emailVerified', async () => {
    stage2Hit({
      _id: 'u-pending',
      email: 'owner@example.com',
      emailVerified: false,
      hasUsablePassword: false,
      tags: ['Customer', PENDING_FREE_CREDITS_TAG],
      pendingCreditGrant: 250,
      authProviders: [],
    });

    const { err, user } = await runStandard(AuthStrategy.Google, linkProfile);

    expect(err).toBeNull();
    expect((user as { emailVerified?: boolean }).emailVerified).toBe(true);
    expect(mockReleasePending).toHaveBeenCalledWith(
      { id: 'u-pending', tags: ['Customer', PENDING_FREE_CREDITS_TAG], pendingCreditGrant: 250 },
      expect.objectContaining({ reason: 'OAuth account link (email verified)' })
    );
    expect(mockClearPending).toHaveBeenCalledWith('u-pending');
  });

  it('does not release on a plain link of an already-verified account', async () => {
    stage2Hit({
      _id: 'u-verified',
      email: 'owner@example.com',
      emailVerified: true,
      hasUsablePassword: true,
      tags: [PENDING_FREE_CREDITS_TAG],
      authProviders: [],
    });

    const { err } = await runStandard(AuthStrategy.Google, linkProfile);

    expect(err).toBeNull();
    expect(mockReleasePending).not.toHaveBeenCalled();
  });

  it('applies the verified domain grant when the link promotes emailVerified on a partner domain', async () => {
    mockPartnerGrant.mockResolvedValue({
      matched: true,
      entitlements: new Set(['optihashi:pro']),
      signupCredits: 1000,
      organizationId: 'org-1',
    });
    stage2Hit({
      _id: 'u-pending',
      email: 'dee@partner.example',
      emailVerified: false,
      hasUsablePassword: false,
      tags: ['Customer'],
      authProviders: [],
    });

    const { err } = await runStandard(AuthStrategy.Google, {
      id: 'google-sub-partner',
      emails: [{ value: 'dee@partner.example', verified: true }],
    });

    expect(err).toBeNull();
    expect(mockPartnerGrant).toHaveBeenCalledWith('dee@partner.example', true);
    expect(mockAddCredits).toHaveBeenCalledWith(
      expect.objectContaining({
        ownerId: 'u-pending',
        credits: 1000,
        transactionId: 'domain-grant-credits:u-pending',
      }),
      expect.anything()
    );
    expect(mockApplyPartnerRuleMembership).toHaveBeenCalledWith(
      { userId: 'u-pending', organizationId: 'org-1' },
      expect.anything()
    );
    // Membership re-reads emailVerified, so the grant must follow the write that persists it.
    expect(mockUpdateOne.mock.invocationCallOrder[0]).toBeLessThan(mockAddCredits.mock.invocationCallOrder[0]);
  });

  it('does not apply the domain grant on a plain link of an already-verified account', async () => {
    stage2Hit({
      _id: 'u-verified',
      email: 'owner@example.com',
      emailVerified: true,
      hasUsablePassword: true,
      authProviders: [],
    });

    const { err } = await runStandard(AuthStrategy.Google, linkProfile);

    expect(err).toBeNull();
    expect(mockPartnerGrant).not.toHaveBeenCalled();
    expect(mockAddCredits).not.toHaveBeenCalled();
  });

  it('completes the link when the release throws', async () => {
    mockReleasePending.mockRejectedValue(new Error('credit service down'));
    stage2Hit({
      _id: 'u-pending',
      email: 'owner@example.com',
      emailVerified: false,
      hasUsablePassword: false,
      tags: [PENDING_FREE_CREDITS_TAG],
      authProviders: [],
    });

    const { err, user } = await runStandard(AuthStrategy.Google, linkProfile);

    expect(err).toBeNull();
    expect(user).toBeDefined();
    expect(mockClearPending).not.toHaveBeenCalled();
  });
});

describe('selfServeVerifyCallback - signup network limits', () => {
  const freshProfile = {
    id: 'sub-net',
    displayName: 'Net Person',
    emails: [{ value: 'net@example.com', verified: true }],
  };
  const req = { headers: { 'cloudfront-viewer-address': '203.0.113.9:4444', 'cloudfront-viewer-asn': '64500' } };
  const runSelfServe = (
    strategy: AuthStrategy,
    profile: Record<string, unknown> = freshProfile,
    verified = false
  ): Promise<{ err: unknown; user: unknown; info: unknown }> =>
    new Promise(resolve => {
      const done = (err: unknown, user?: unknown, info?: unknown) => resolve({ err, user, info });
      recordTurnstileVerification(req, verified);
      void selfServeVerifyCallback(strategy)(req, 'access-tok', 'refresh-tok', profile, done);
    });

  it('declares the arity passport-oauth2 needs to pass the request first', () => {
    expect(selfServeVerifyCallback(AuthStrategy.Google)).toHaveLength(5);
  });

  it('refuses a first login whose network is over the signup limit', async () => {
    mockFindOne.mockResolvedValue(null);
    mockIsSignupNetworkOverLimit.mockResolvedValue(true);

    const { user, info } = await runSelfServe(AuthStrategy.Github);

    expect(user).toBeFalsy();
    expect(info).toMatchObject({ code: 'signup_limited' });
    expect(mockIsSignupNetworkOverLimit).toHaveBeenCalledWith(
      expect.objectContaining({ ip: '203.0.113.9', asn: 64500 }),
      expect.anything()
    );
    expect(mockCreate).not.toHaveBeenCalled();
  });

  it.each([
    ['signup_email_unverified', { ...freshProfile, emails: [{ value: 'net@example.com', verified: false }] }, false],
    ['signup_email_blocked', freshProfile, true],
  ])('reports %s ahead of the network cap', async (code, profile, blocked) => {
    mockFindOne.mockResolvedValue(null);
    mockIsSignupNetworkOverLimit.mockResolvedValue(true);
    mockShouldBlockDisposableEmail.mockResolvedValue(blocked);

    const { info } = await runSelfServe(AuthStrategy.Github, profile);

    expect(info).toMatchObject({ code });
    expect(mockIsSignupNetworkOverLimit).not.toHaveBeenCalled();
    expect(mockCreate).not.toHaveBeenCalled();
  });

  it('admits a partner-domain first login without running the network cap check', async () => {
    mockFindOne.mockResolvedValue(null);
    mockCreate.mockImplementation(async (doc: Record<string, unknown>) => ({ ...doc, _id: 'p-id', id: 'p-id' }));
    mockIsSignupNetworkOverLimit.mockResolvedValue(true);
    mockPartnerGrant.mockResolvedValue({
      matched: true,
      ruleId: 'rule-1',
      domain: 'example.com',
      entitlements: new Set(),
      signupCredits: 0,
      organizationId: null,
      tags: [],
      subscription: null,
    });

    const { user, info } = await runSelfServe(AuthStrategy.Google);

    expect(user).toBeTruthy();
    expect(info).toBeUndefined();
    expect(mockIsSignupNetworkOverLimit).not.toHaveBeenCalled();
  });

  it.each([true, false])('assesses a new account with the request network and challenge proof (%s)', async verified => {
    mockFindOne.mockResolvedValue(null);
    mockCreate.mockImplementation(async (doc: Record<string, unknown>) => ({ ...doc, _id: 'new-id', id: 'new-id' }));

    const { user } = await runSelfServe(AuthStrategy.Google, freshProfile, verified);

    expect(user).toBeTruthy();
    expect(mockCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        signupMeta: expect.objectContaining({
          ip: '203.0.113.9',
          capturedAt: expect.any(Date),
          challengeVerified: verified ? true : null,
        }),
      })
    );
    expect(mockCreateSignupRiskCollector).toHaveBeenCalledWith(expect.objectContaining({ ip: '203.0.113.9' }));
    expect(mockReleasePending).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ collectRiskSignals: { collectorFor: expect.objectContaining({ asn: 64500 }) } })
    );
  });

  it('does not gate the request-less verifyCallback (SAML wrapper)', async () => {
    mockFindOne.mockResolvedValue(null);
    mockCreate.mockImplementation(async (doc: Record<string, unknown>) => ({ ...doc, _id: 'saml-id', id: 'saml-id' }));
    mockIsSignupNetworkOverLimit.mockResolvedValue(true);

    const { user } = await runStandard(AuthStrategy.Google, freshProfile);

    expect(user).toBeTruthy();
    expect(mockIsSignupNetworkOverLimit).not.toHaveBeenCalled();
  });
});
