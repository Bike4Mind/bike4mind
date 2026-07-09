import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { AuthStrategy } from '@bike4mind/common';
import { ACCOUNT_LINK_VERIFICATION_REQUIRED, ACCOUNT_LINK_EMAIL_MISMATCH } from './oauthAccountLink';

const mockFindOne = vi.fn();
const mockUpdateOne = vi.fn();
const mockCreate = vi.fn();

vi.mock('@bike4mind/database', () => ({
  User: {
    findOne: (...args: unknown[]) => mockFindOne(...args),
    updateOne: (...args: unknown[]) => mockUpdateOne(...args),
    create: (...args: unknown[]) => mockCreate(...args),
  },
}));

vi.mock('@server/auth/requireNonSystemUser', () => ({
  requireNonSystemUser: (u: unknown) => u,
}));

import { verifyCallback } from './verifyCallback';

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

describe('verifyCallback - new user creation username field', () => {
  it('stores the provider username (handle) not the displayName so second login finds the user', async () => {
    mockFindOne.mockResolvedValueOnce(null).mockResolvedValueOnce(null);
    mockCreate.mockResolvedValueOnce({ _id: 'new-id', username: 'aanderson' });

    await runStandard(AuthStrategy.Github, {
      id: 'github-id-123',
      username: 'aanderson',
      displayName: 'Alice Anderson',
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
  it('logs the exception and passes an info message instead of swallowing silently', async () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    mockFindOne.mockResolvedValueOnce(null).mockResolvedValueOnce(null);
    mockCreate.mockRejectedValueOnce(Object.assign(new Error('E11000 duplicate key error: username'), { code: 11000 }));

    const { err, user, info } = await runStandard(AuthStrategy.Github, {
      id: 'github-id-789',
      username: 'dupe-handle',
      emails: [{ value: 'dupe@example.com', verified: true }],
    });

    // done(null, undefined, { message }) - no user, but a non-empty reason
    expect(err).toBeNull();
    expect(user).toBeUndefined();
    expect((info as { message: string }).message).toContain('E11000');
    expect(errorSpy).toHaveBeenCalledWith('[verifyCallback] authenticateUser threw:', expect.any(Error));
    // Spy restored failure-safely by the file-level afterEach.
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
