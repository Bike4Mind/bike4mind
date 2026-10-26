import { describe, expect, it } from 'vitest';
import { ja4FingerprintSchema, signupMetaSchema } from './networkMeta';
import { redactUserSecretsForSelf } from '../serializers/toSafeUser';

const ja4 = 't13d0101h2_111111111111_222222222222';
const signupMeta = {
  ip: null,
  userAgent: null,
  asn: null,
  asnOrg: null,
  country: null,
  isDatacenter: null,
  capturedAt: new Date(),
  ja4,
};

describe('optional signup fingerprints', () => {
  it('accepts the canonical format and tolerates absent legacy metadata', () => {
    expect(ja4FingerprintSchema.parse(ja4)).toBe(ja4);
    expect(signupMetaSchema.safeParse({ ...signupMeta, ja4: undefined }).success).toBe(true);
    expect(signupMetaSchema.safeParse({ ...signupMeta, ja4: null }).success).toBe(true);
    expect(ja4FingerprintSchema.safeParse(`${ja4},${ja4}`).success).toBe(false);
  });

  it('does not expose fingerprint metadata on self views, but permits explicit admin views', () => {
    const user = { signupMeta };
    expect(redactUserSecretsForSelf(user as never)).not.toHaveProperty('signupMeta');
    expect(redactUserSecretsForSelf(user as never, { keepAdminOnly: ['signupMeta'] })).toHaveProperty(
      'signupMeta.ja4',
      ja4
    );
  });
});
