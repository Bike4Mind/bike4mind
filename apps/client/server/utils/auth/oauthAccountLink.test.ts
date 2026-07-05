import { describe, it, expect } from 'vitest';
import { isProviderEmailVerified, selectProviderEmail, isVerifiedFlag } from './oauthAccountLink';

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
