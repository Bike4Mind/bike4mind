import { describe, it, expect } from 'vitest';
import {
  isProviderEmailVerified,
  selectProviderEmail,
  isVerifiedFlag,
  decideAutoLink,
  applyAccountLink,
  ACCOUNT_LINK_VERIFICATION_REQUIRED,
  ACCOUNT_LINK_EMAIL_MISMATCH,
  type AutoLinkInput,
} from './oauthAccountLink';
import { AuthStrategy, type IAuthProviders } from '@bike4mind/common';

describe('isVerifiedFlag', () => {
  it('returns true for boolean true', () => expect(isVerifiedFlag(true)).toBe(true));
  it("returns true for string 'true'", () => expect(isVerifiedFlag('true')).toBe(true));
  it('returns false for boolean false', () => expect(isVerifiedFlag(false)).toBe(false));
  it("returns false for string 'false' (not truthy-checked)", () => expect(isVerifiedFlag('false')).toBe(false));
  it('returns false for undefined/null/other', () => {
    expect(isVerifiedFlag(undefined)).toBe(false);
    expect(isVerifiedFlag(null)).toBe(false);
    expect(isVerifiedFlag(1)).toBe(false);
    expect(isVerifiedFlag('yes')).toBe(false);
  });
});

describe('selectProviderEmail', () => {
  it('returns null for non-object profiles', () => {
    expect(selectProviderEmail(null)).toBeNull();
    expect(selectProviderEmail('string')).toBeNull();
  });

  it('prefers primary+verified over any other entry', () => {
    const profile = {
      emails: [
        { value: 'secondary@b.com', verified: true, primary: false },
        { value: 'primary@b.com', verified: true, primary: true },
      ],
    };
    expect(selectProviderEmail(profile)?.value).toBe('primary@b.com');
  });

  it('falls back to first verified when no primary+verified exists', () => {
    const profile = {
      emails: [
        { value: 'unverified@b.com', verified: false },
        { value: 'verified@b.com', verified: true },
      ],
    };
    expect(selectProviderEmail(profile)?.value).toBe('verified@b.com');
  });

  it("normalises string 'false' — does NOT treat it as verified", () => {
    const profile = {
      emails: [{ value: 'explicit-false@b.com', verified: 'false' }, { value: 'missing@b.com' }],
    };
    // Neither is verified; falls back to emails[0]
    expect(selectProviderEmail(profile)?.value).toBe('explicit-false@b.com');
  });

  it("normalises string 'true' — treats it as verified", () => {
    const profile = { emails: [{ value: 'g@b.com', verified: 'true' }] };
    expect(selectProviderEmail(profile)?.value).toBe('g@b.com');
  });

  it('falls back to emails[0] when no entry is verified', () => {
    const profile = { emails: [{ value: 'first@b.com' }, { value: 'second@b.com' }] };
    expect(selectProviderEmail(profile)?.value).toBe('first@b.com');
  });

  it('falls back to flat profile.email when no emails array', () => {
    expect(selectProviderEmail({ email: 'flat@b.com' })?.value).toBe('flat@b.com');
  });

  it('returns null when no email anywhere', () => {
    expect(selectProviderEmail({})).toBeNull();
  });
});

describe('isProviderEmailVerified', () => {
  it('returns false for null/undefined/non-object profiles', () => {
    expect(isProviderEmailVerified(null)).toBe(false);
    expect(isProviderEmailVerified(undefined)).toBe(false);
    expect(isProviderEmailVerified('string')).toBe(false);
    expect(isProviderEmailVerified(42)).toBe(false);
  });

  it('returns false for an empty profile', () => {
    expect(isProviderEmailVerified({})).toBe(false);
  });

  it('returns true for the SELECTED (primary+verified) email, not emails[0]', () => {
    // emails[0] is unverified, but the primary email is verified.
    // selectProviderEmail picks the primary; isProviderEmailVerified must agree.
    expect(
      isProviderEmailVerified({
        emails: [
          { value: 'secondary@b.com', verified: false },
          { value: 'primary@b.com', verified: true, primary: true },
        ],
      })
    ).toBe(true);
  });

  it("accepts profile.emails[i].verified as string 'true' (Google quirk)", () => {
    expect(isProviderEmailVerified({ emails: [{ value: 'a@b.com', verified: 'true' }] })).toBe(true);
  });

  it('rejects profile.emails[i].verified === false on the selected entry', () => {
    expect(isProviderEmailVerified({ emails: [{ value: 'a@b.com', verified: false }] })).toBe(false);
  });

  it("rejects profile.emails[i].verified === 'false' string on the selected entry", () => {
    expect(isProviderEmailVerified({ emails: [{ value: 'a@b.com', verified: 'false' }] })).toBe(false);
  });

  it('rejects missing verified field on the selected email entry', () => {
    expect(isProviderEmailVerified({ emails: [{ value: 'a@b.com' }] })).toBe(false);
  });

  it('reads top-level email_verified === true (OIDC) when no per-email signal', () => {
    expect(isProviderEmailVerified({ email_verified: true })).toBe(true);
  });

  it('reads profile._json.email_verified === true (passport _json)', () => {
    expect(isProviderEmailVerified({ _json: { email_verified: true } })).toBe(true);
  });

  it('rejects email_verified truthy non-true values', () => {
    expect(isProviderEmailVerified({ email_verified: 'yes' })).toBe(false);
    expect(isProviderEmailVerified({ email_verified: 1 })).toBe(false);
  });

  it('per-email verified === false on selected entry overrides top-level email_verified === true', () => {
    expect(
      isProviderEmailVerified({
        emails: [{ value: 'x@y.com', verified: false }],
        email_verified: true,
      })
    ).toBe(false);
  });

  it("per-email verified === 'false' string on selected entry also overrides top-level true", () => {
    expect(
      isProviderEmailVerified({
        emails: [{ value: 'x@y.com', verified: 'false' }],
        _json: { email_verified: true },
      })
    ).toBe(false);
  });
});

describe('decideAutoLink', () => {
  // A fully-safe baseline (verified both sides, matching emails); each test flips
  // one field to isolate that dimension of the gate.
  const base: AutoLinkInput = {
    providerEmailVerified: true,
    providerEmail: 'user@b.com',
    localEmail: 'user@b.com',
    localEmailVerified: true,
    hasUsablePassword: true,
  };

  it('links when both sides are verified and emails match', () => {
    expect(decideAutoLink(base)).toEqual({ action: 'link' });
  });

  it('is case-insensitive on the email match', () => {
    expect(decideAutoLink({ ...base, providerEmail: 'USER@B.COM' })).toEqual({ action: 'link' });
  });

  it('refuses (verification required) when the provider email is unverified', () => {
    expect(decideAutoLink({ ...base, providerEmailVerified: false })).toEqual({
      action: 'refuse',
      reason: ACCOUNT_LINK_VERIFICATION_REQUIRED,
      detail: 'provider_email_unverified',
    });
  });

  it('provider-unverified takes priority over an email mismatch', () => {
    // Refuse-reason ordering matters: an unverified provider is reported as
    // verification-required (provider-side), never as a mismatch.
    expect(decideAutoLink({ ...base, providerEmailVerified: false, providerEmail: 'other@b.com' })).toEqual({
      action: 'refuse',
      reason: ACCOUNT_LINK_VERIFICATION_REQUIRED,
      detail: 'provider_email_unverified',
    });
  });

  it('refuses (email mismatch) when both emails are present and differ', () => {
    expect(decideAutoLink({ ...base, providerEmail: 'attacker@b.com' })).toEqual({
      action: 'refuse',
      reason: ACCOUNT_LINK_EMAIL_MISMATCH,
      detail: 'email_mismatch',
    });
  });

  describe('local account not yet verified', () => {
    const unverifiedLocal: AutoLinkInput = { ...base, localEmailVerified: false };

    it('promotes-and-links a passwordless account on a matching verified email', () => {
      expect(decideAutoLink({ ...unverifiedLocal, hasUsablePassword: false })).toEqual({
        action: 'promote-and-link',
      });
    });

    it('refuses a password-holding account (reverse-takeover setup)', () => {
      expect(decideAutoLink({ ...unverifiedLocal, hasUsablePassword: true })).toEqual({
        action: 'refuse',
        reason: ACCOUNT_LINK_VERIFICATION_REQUIRED,
        detail: 'local_email_unverified',
      });
    });

    it('does NOT promote on a username-only match (no local email)', () => {
      // localEmail null is not an identity assertion; promoting would let a
      // colliding username stamp its email onto an emailless passwordless shell.
      expect(decideAutoLink({ ...unverifiedLocal, hasUsablePassword: false, localEmail: null })).toEqual({
        action: 'refuse',
        reason: ACCOUNT_LINK_VERIFICATION_REQUIRED,
        detail: 'local_email_unverified',
      });
    });

    it('does NOT promote when the provider email is absent', () => {
      expect(decideAutoLink({ ...unverifiedLocal, hasUsablePassword: false, providerEmail: null })).toEqual({
        action: 'refuse',
        reason: ACCOUNT_LINK_VERIFICATION_REQUIRED,
        detail: 'local_email_unverified',
      });
    });
  });

  describe('one-sided emails (username-only match)', () => {
    it('links when local is already verified even though local email is null', () => {
      // No mismatch is possible without both emails; the verified local side
      // still permits the link.
      expect(decideAutoLink({ ...base, localEmail: null })).toEqual({ action: 'link' });
    });

    it('links when the provider email is null but local is verified', () => {
      expect(decideAutoLink({ ...base, providerEmail: null })).toEqual({ action: 'link' });
    });
  });
});

describe('applyAccountLink', () => {
  const cred = (strategy: AuthStrategy, id: string): IAuthProviders => ({ id, strategy }) as unknown as IAuthProviders;

  describe('new provider link', () => {
    it('pushes the provider, sets fields under $set and bumps tokenVersion', () => {
      const authProviders: IAuthProviders[] = [];
      const oauthCredentials = cred(AuthStrategy.Google, 'sub-1');
      const { update, reflect } = applyAccountLink({
        authProviders,
        oauthCredentials,
        isNewProvider: true,
        promoteEmailVerified: false,
        currentTokenVersion: 3,
      });

      expect(authProviders).toEqual([oauthCredentials]);
      expect(update.$set).toMatchObject({ oauthCredentials, authProviders });
      expect((update.$set as Record<string, unknown>).emailVerified).toBeUndefined();
      expect(update.$inc).toEqual({ tokenVersion: 1 });
      expect(reflect).toEqual({ tokenVersion: 4 });
    });

    it('treats a missing tokenVersion as 0 when bumping', () => {
      const { reflect } = applyAccountLink({
        authProviders: [],
        oauthCredentials: cred(AuthStrategy.Google, 'sub-1'),
        isNewProvider: true,
        promoteEmailVerified: false,
        currentTokenVersion: undefined,
      });
      expect(reflect.tokenVersion).toBe(1);
    });

    it('rides the emailVerified promotion on the same $set and reflects it', () => {
      const { update, reflect } = applyAccountLink({
        authProviders: [],
        oauthCredentials: cred(AuthStrategy.Google, 'sub-1'),
        isNewProvider: true,
        promoteEmailVerified: true,
        currentTokenVersion: 0,
      });

      const set = update.$set as Record<string, unknown>;
      expect(set.emailVerified).toBe(true);
      expect(set.emailVerifiedAt).toBeInstanceOf(Date);
      expect(update.$inc).toEqual({ tokenVersion: 1 });
      expect(reflect.tokenVersion).toBe(1);
      expect(reflect.emailVerified).toBe(true);
      expect(reflect.emailVerifiedAt).toBe(set.emailVerifiedAt);
    });
  });

  describe('refresh of an already-linked provider', () => {
    it('replaces the existing entry in place with no $set/$inc and no tokenVersion bump', () => {
      const existing = cred(AuthStrategy.Google, 'old-sub');
      const authProviders: IAuthProviders[] = [existing];
      const oauthCredentials = cred(AuthStrategy.Google, 'new-sub');
      const { update, reflect } = applyAccountLink({
        authProviders,
        oauthCredentials,
        isNewProvider: false,
        promoteEmailVerified: false,
        currentTokenVersion: 7,
      });

      expect(authProviders).toEqual([oauthCredentials]);
      expect(update.$set).toBeUndefined();
      expect(update.$inc).toBeUndefined();
      expect(update).toMatchObject({ oauthCredentials, authProviders });
      expect(reflect).toEqual({});
    });

    it('collapses duplicate entries for the same strategy left by a concurrent-login race', () => {
      const other = cred(AuthStrategy.Github, 'gh-sub');
      const authProviders: IAuthProviders[] = [
        cred(AuthStrategy.Google, 'sub-1'),
        other,
        cred(AuthStrategy.Google, 'sub-1'),
      ];
      const oauthCredentials = cred(AuthStrategy.Google, 'sub-1');
      const { update } = applyAccountLink({
        authProviders,
        oauthCredentials,
        isNewProvider: false,
        promoteEmailVerified: false,
        currentTokenVersion: 0,
      });

      // The refreshed entry keeps its original position; the stale duplicate is gone.
      expect(authProviders).toEqual([oauthCredentials, other]);
      expect(update).toMatchObject({ authProviders });
    });

    it('promotes emailVerified on a refresh without bumping tokenVersion', () => {
      const { update, reflect } = applyAccountLink({
        authProviders: [cred(AuthStrategy.Google, 'sub-1')],
        oauthCredentials: cred(AuthStrategy.Google, 'sub-1'),
        isNewProvider: false,
        promoteEmailVerified: true,
        currentTokenVersion: 7,
      });

      expect(update.emailVerified).toBe(true);
      expect(update.emailVerifiedAt).toBeInstanceOf(Date);
      expect(update.$inc).toBeUndefined();
      expect(reflect.tokenVersion).toBeUndefined();
      expect(reflect.emailVerified).toBe(true);
      expect(reflect.emailVerifiedAt).toBe(update.emailVerifiedAt);
    });
  });
});
