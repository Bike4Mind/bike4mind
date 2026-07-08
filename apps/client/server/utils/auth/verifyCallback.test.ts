import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { AuthStrategy } from '@bike4mind/common';
import { ACCOUNT_LINK_VERIFICATION_REQUIRED, ACCOUNT_LINK_EMAIL_MISMATCH } from './oauthAccountLink';
import { ForbiddenError } from '@server/utils/errors';

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

  it('refuses to link when local user emailVerified is false', async () => {
    stage2Hit({ _id: 'u1', email: 'victim@example.com', emailVerified: false, authProviders: [] });

    const { err, user } = await runStandard(AuthStrategy.Google, baseProfile);

    expect(err).toBe(ACCOUNT_LINK_VERIFICATION_REQUIRED);
    expect(user).toBeUndefined();
    expect(mockUpdateOne).not.toHaveBeenCalled();
    expect(mockFindOne).toHaveBeenCalledTimes(2);
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
    stage2Hit({
      _id: 'u1',
      email: 'victim@example.com',
      emailVerified: false,
      authProviders: [{ strategy: AuthStrategy.Google, id: 'google-sub-original' }],
    });

    const { err } = await runStandard(AuthStrategy.Google, {
      id: 'google-sub-attacker',
      emails: [{ value: 'victim@example.com', verified: true }],
    });

    expect(err).toBe(ACCOUNT_LINK_VERIFICATION_REQUIRED);
    expect(mockUpdateOne).not.toHaveBeenCalled();
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
    stage2Hit({ _id: 'u1', email: 'victim@example.com', emailVerified: false, authProviders: [] });

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
    // then prevents the null===null bypass.
    mockFindOne.mockResolvedValueOnce({
      _id: 'u1',
      email: 'victim@example.com',
      emailVerified: false,
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
