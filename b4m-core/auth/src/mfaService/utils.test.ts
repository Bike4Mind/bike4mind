import { describe, it, expect, vi } from 'vitest';
import QRCode from 'qrcode';
import { generateTOTPSecret, totpCode } from './totp';
import {
  clearFailedAttempts,
  generateBackupCodes,
  generateTOTPSetup,
  isMfaEnforcementExempt,
  matchTOTPStep,
  userHasMFAConfigured,
  userHasTotpConfigured,
  userCanDisableMFA,
  userRequiresMFA,
} from './utils';
import type { IMFAConfig, IUserDocument } from '@bike4mind/common';

const user = (mfa: unknown) => ({ mfa }) as unknown as IUserDocument;

describe('userHasMFAConfigured', () => {
  // Regression guard: totpSecret is select:false and is NOT loaded on the OTC login
  // path (findByEmail). MFA detection MUST rely on totpEnabled alone - re-adding a
  // `&& user.mfa.totpSecret` requirement here would make MFA-enabled users silently
  // bypass MFA when logging in via OTC.
  it('is true when totpEnabled, even without the (select:false) totpSecret loaded', () => {
    expect(userHasMFAConfigured(user({ totpEnabled: true }))).toBe(true);
  });

  it('is false when MFA is not enabled', () => {
    expect(userHasMFAConfigured(user({ totpEnabled: false }))).toBe(false);
    expect(userHasMFAConfigured(user(null))).toBe(false);
    expect(userHasMFAConfigured(user(undefined))).toBe(false);
  });

  it.each([
    ['an authenticator app only', { totpEnabled: true }, true],
    ['a passkey only', { totpEnabled: false, passkeyEnabled: true }, true],
    ['a passkey with no totp flag at all', { passkeyEnabled: true }, true],
    ['both factors', { totpEnabled: true, passkeyEnabled: true }, true],
    ['neither factor', { totpEnabled: false, passkeyEnabled: false }, false],
    ['a pending app setup', { totpEnabled: false }, false],
    ['an empty mfa object', {}, false],
  ])('for %s returns %s', (_label, mfa, expected) => {
    expect(userHasMFAConfigured(user(mfa))).toBe(expected);
  });
});

describe('userHasTotpConfigured', () => {
  it.each([
    ['an authenticator app only', { totpEnabled: true }, true],
    ['both factors', { totpEnabled: true, passkeyEnabled: true }, true],
    ['a passkey only', { totpEnabled: false, passkeyEnabled: true }, false],
    ['a pending app setup', { totpEnabled: false }, false],
  ])('for %s returns %s', (_label, mfa, expected) => {
    expect(userHasTotpConfigured(user(mfa))).toBe(expected);
  });

  it('is false when the user has no mfa', () => {
    expect(userHasTotpConfigured(user(null))).toBe(false);
    expect(userHasTotpConfigured(user(undefined))).toBe(false);
  });
});

describe('clearFailedAttempts', () => {
  it('resets lockout state and preserves secrets', () => {
    const mfa = {
      totpEnabled: true,
      totpSecret: 'SECRET',
      backupCodes: ['h1', 'h2'],
      failedAttempts: 3,
      lastFailedAttempt: new Date(),
      lockedUntil: new Date(Date.now() + 60_000),
    } as unknown as IMFAConfig;

    const result = clearFailedAttempts(mfa);

    expect(result.failedAttempts).toBe(0);
    expect(result.lastFailedAttempt).toBeUndefined();
    expect(result.lockedUntil).toBeUndefined();
    expect(result.totpSecret).toBe('SECRET');
    expect(result.backupCodes).toEqual(['h1', 'h2']);
    expect(mfa.failedAttempts).toBe(3);
  });
});

describe('matchTOTPStep', () => {
  const secret = generateTOTPSecret();
  // Mid-step instant so +/-1 second never crosses a step boundary.
  const nowMs = 1_700_000_015_000;
  const currentStep = Math.floor(nowMs / 1000 / 30);
  const codeAt = (offsetSeconds: number) => totpCode(secret, currentStep + offsetSeconds / 30);

  it('returns the current step for a fresh code', () => {
    expect(matchTOTPStep(secret, codeAt(0), 1, nowMs)).toBe(currentStep);
  });

  it('returns the previous step for a code from 30s ago', () => {
    expect(matchTOTPStep(secret, codeAt(-30), 1, nowMs)).toBe(currentStep - 1);
  });

  it('returns the next step for a code 30s ahead (clock drift)', () => {
    expect(matchTOTPStep(secret, codeAt(30), 1, nowMs)).toBe(currentStep + 1);
  });

  it('returns null for a wrong code', () => {
    const wrong = codeAt(0) === '000000' ? '000001' : '000000';
    expect(matchTOTPStep(secret, wrong, 1, nowMs)).toBeNull();
  });

  it('returns null for a code 2 steps old', () => {
    expect(matchTOTPStep(secret, codeAt(-60), 1, nowMs)).toBeNull();
  });

  it('fails closed on an empty secret (an undecryptable stored secret reads as empty)', () => {
    const emptyKeyCode = totpCode('', currentStep);
    expect(matchTOTPStep('', emptyKeyCode, 1, nowMs)).toBeNull();
  });
});

describe('matchTOTPStep against fixed vectors', () => {
  // RFC 6238 Appendix B, SHA-1: the key is the ASCII "12345678901234567890"; 6-digit codes are the
  // last six digits of the 8-digit vectors.
  const RFC_SECRET = 'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ';
  it.each([
    [59, '287082'],
    [1111111109, '081804'],
    [1111111111, '050471'],
    [1234567890, '005924'],
    [2000000000, '279037'],
    [20000000000, '353130'],
  ])('accepts the RFC 6238 code at T=%i', (seconds, code) => {
    expect(matchTOTPStep(RFC_SECRET, code, 0, seconds * 1000)).toBe(Math.floor(seconds / 30));
  });

  const nowMs = 1_700_000_015_000;
  const step = Math.floor(nowMs / 30_000);

  it('accepts a code for a 52-character secret in the format speakeasy generated', () => {
    expect(matchTOTPStep('HRSXEI3TNRWTOUJZKZGDEWB6FQYG22CRLJEUUILOON2CGW2KJISQ', '308371', 0, nowMs)).toBe(step);
  });

  // Base32 is decoded the way speakeasy's base32.js did, so a stored secret keeps its key.
  it.each([
    ['upper case', 'JBSWY3DPEHPK3PXP', '367665'],
    ['lower case', 'jbswy3dpehpk3pxp', '367665'],
    ['= padding', 'JBSWY3DPEHPK3PXP====', '367665'],
    ['0 and 1 read as O and I', 'JBSWY3DPEHPK3P01', '573198'],
    ['O and I', 'JBSWY3DPEHPK3POI', '573198'],
    ['an unknown character read as A', 'JBSW Y3DP EHPK 3PXP', '063212'],
    ['the same secret with A in place of each space', 'JBSWAY3DPAEHPKA3PXP', '063212'],
    ['a dash read as A', 'JBSW-Y3DP', '433303'],
    ['leftover nonzero bits kept as a final byte', 'B', '449506'],
    ['leftover zero bits dropped', 'A', '647021'],
  ])('decodes a secret with %s', (_label, secret, code) => {
    expect(matchTOTPStep(secret, code, 0, nowMs)).toBe(step);
  });

  it('checks one step either side by default and none with a window of 0', () => {
    const secret = 'JBSWY3DPEHPK3PXP';
    const previous = '324550';
    expect(matchTOTPStep(secret, previous, 1, nowMs)).toBe(step - 1);
    expect(matchTOTPStep(secret, previous, 0, nowMs)).toBeNull();
    expect(matchTOTPStep(secret, previous, 0, nowMs - 30_000)).toBe(step - 1);
  });

  it('widens to two steps either side with a window of 2', () => {
    const secret = 'JBSWY3DPEHPK3PXP';
    expect(matchTOTPStep(secret, '367665', 2, nowMs + 60_000)).toBe(step);
    expect(matchTOTPStep(secret, '367665', 2, nowMs - 60_000)).toBe(step);
    expect(matchTOTPStep(secret, '367665', 1, nowMs + 60_000)).toBeNull();
  });

  it('returns the earliest step when two steps in the window share a code', () => {
    // This secret's codes at step - 1 and step + 1 are both 642899.
    expect(matchTOTPStep('AAAAAAAAAAACT3OT', '642899', 1, nowMs)).toBe(step - 1);
    expect(matchTOTPStep('AAAAAAAAAAACT3OT', '374102', 1, nowMs)).toBe(step);
  });

  it('compares the digits exactly rather than as numbers', () => {
    expect(matchTOTPStep(RFC_SECRET, '005924', 0, 1234567890_000)).toBe(41152263);
    expect(matchTOTPStep(RFC_SECRET, '5924ab', 0, 1234567890_000)).toBeNull();
    expect(matchTOTPStep(RFC_SECRET, '+05924', 0, 1234567890_000)).toBeNull();
  });

  it('rejects a token that is not six characters', () => {
    expect(matchTOTPStep('JBSWY3DPEHPK3PXP', '36766', 1, nowMs)).toBeNull();
    expect(matchTOTPStep('JBSWY3DPEHPK3PXP', '3676650', 1, nowMs)).toBeNull();
    expect(matchTOTPStep('JBSWY3DPEHPK3PXP', 'ABCDEF', 1, nowMs)).toBeNull();
    expect(matchTOTPStep('JBSWY3DPEHPK3PXP', '', 1, nowMs)).toBeNull();
  });
});

describe('generateTOTPSetup otpauth URI', () => {
  it.each([
    ['Test App', 'a.b+c@example.com', 'otpauth://totp/Test%20App%20(a.b%2Bc%40example.com)?secret=JBSWY3DPEHPK3PXP'],
    ["O'Brien & Co", 'x@y.com', "otpauth://totp/O'Brien%20%26%20Co%20(x%40y.com)?secret=JBSWY3DPEHPK3PXP"],
    ['caf\u{e9}', 'u@example.com', 'otpauth://totp/caf%C3%A9%20(u%40example.com)?secret=JBSWY3DPEHPK3PXP'],
    ['a#b?c d/e', 'q@example.com', 'otpauth://totp/a%23b%3Fc%20d%2Fe%20(q%40example.com)?secret=JBSWY3DPEHPK3PXP'],
    ['', 'user@example.com', 'otpauth://totp/user%40example.com?secret=JBSWY3DPEHPK3PXP'],
  ])('labels app %j and email %s', async (appName, email, uri) => {
    const toDataURL = vi.spyOn(QRCode, 'toDataURL');
    await generateTOTPSetup(email, appName, 'JBSWY3DPEHPK3PXP');
    expect(toDataURL).toHaveBeenCalledWith(uri);
    toDataURL.mockRestore();
  });

  it('mints a new 52-character base32 secret each time and puts it in the URI', async () => {
    const toDataURL = vi.spyOn(QRCode, 'toDataURL');
    const first = await generateTOTPSetup('a@example.com', 'App');
    const second = await generateTOTPSetup('a@example.com', 'App');
    expect(first.secret).toMatch(/^[A-Z2-7]{52}$/);
    expect(second.secret).toMatch(/^[A-Z2-7]{52}$/);
    expect(second.secret).not.toBe(first.secret);
    expect(first.manualEntryKey).toBe(first.secret);
    expect(toDataURL).toHaveBeenCalledWith(`otpauth://totp/App%20(a%40example.com)?secret=${first.secret}`);
    toDataURL.mockRestore();
  });
});

describe('generateBackupCodes', () => {
  it('returns ten distinct 10-character base32 codes by default', () => {
    const codes = generateBackupCodes();
    expect(codes).toHaveLength(10);
    for (const code of codes) expect(code).toMatch(/^[A-Z2-7]{10}$/);
    expect(new Set(codes).size).toBe(10);
  });

  it('returns the requested number of codes', () => {
    expect(generateBackupCodes(3)).toHaveLength(3);
  });
});

describe('generateTOTPSetup', () => {
  it('re-serves an existing secret in the same URI a new one gets', async () => {
    const existing = generateTOTPSecret();
    const toDataURL = vi.spyOn(QRCode, 'toDataURL');

    const setup = await generateTOTPSetup('a.b+c@example.com', 'Test App', existing);

    expect(setup.secret).toBe(existing);
    expect(setup.manualEntryKey).toBe(existing);
    expect(toDataURL).toHaveBeenCalledWith(`otpauth://totp/Test%20App%20(a.b%2Bc%40example.com)?secret=${existing}`);
    toDataURL.mockRestore();
  });
});

describe('userRequiresMFA', () => {
  const ordinary = { mfa: {} } as unknown as IUserDocument;
  const persona = { mfa: {}, isPersona: true } as unknown as IUserDocument;

  it('requires every ordinary user while enforcement is on, and nobody while it is off', () => {
    expect(userRequiresMFA(ordinary, true)).toBe(true);
    expect(userRequiresMFA({ ...ordinary, isPersona: false } as IUserDocument, true)).toBe(true);
    expect(userRequiresMFA(ordinary, false)).toBe(false);
  });

  it('never requires a test persona', () => {
    expect(isMfaEnforcementExempt(persona)).toBe(true);
    expect(userRequiresMFA(persona, true)).toBe(false);
  });

  it('requires a persona that holds any admin access', () => {
    const fullAdmin = { ...persona, isAdmin: true } as IUserDocument;
    const delegate = { ...persona, adminPermissions: ['settings:manage'] } as unknown as IUserDocument;
    expect(userRequiresMFA(fullAdmin, true)).toBe(true);
    expect(userRequiresMFA(delegate, true)).toBe(true);
  });

  it('requires a forced account while the stage setting is off, unless it is an exempt persona', () => {
    expect(userRequiresMFA({ ...ordinary, mfaEnforcement: 'force' } as IUserDocument, false)).toBe(true);
    expect(userRequiresMFA({ ...persona, mfaEnforcement: 'force' } as IUserDocument, false)).toBe(false);
  });
});

describe('userCanDisableMFA', () => {
  const ordinary = { mfa: { totpEnabled: true } } as unknown as IUserDocument;

  it('lets a user disable only while neither the stage nor their account forces MFA', () => {
    expect(userCanDisableMFA(ordinary, false)).toBe(true);
    expect(userCanDisableMFA(ordinary, true)).toBe(false);
    expect(userCanDisableMFA({ ...ordinary, mfaEnforcement: 'force' } as IUserDocument, false)).toBe(false);
  });
});
