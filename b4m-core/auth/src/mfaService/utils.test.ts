import { describe, it, expect } from 'vitest';
import { userHasMFAConfigured } from './utils';
import type { IUserDocument } from '@bike4mind/common';

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
});
