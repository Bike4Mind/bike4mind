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
  it('preserves genuine challenge proof and leaves skipped challenges unknown', () => {
    expect(signupMetaSchema.parse({ ...signupMeta, challengeVerified: true }).challengeVerified).toBe(true);
    expect(signupMetaSchema.parse({ ...signupMeta, challengeVerified: null }).challengeVerified).toBeNull();
    expect(signupMetaSchema.safeParse({ ...signupMeta, challengeVerified: 'true' }).success).toBe(false);
    expect(signupMetaSchema.safeParse({ ...signupMeta, challengeVerified: false }).success).toBe(false);
  });
  it.each(['h2', 'H2', 'aZ', '00'])('preserves case in the ALPN component %s', alpn => {
    const fingerprint = `t13d0101${alpn}_111111111111_222222222222`;
    expect(ja4FingerprintSchema.parse(fingerprint)).toBe(fingerprint);
  });

  it.each(['t13d', 'q13d', 'dd1i', 'ts3i', 't00i'])('accepts the protocol/version prefix %s', prefix => {
    expect(ja4FingerprintSchema.safeParse(`${prefix}0101h2_111111111111_222222222222`).success).toBe(true);
  });

  it.each([
    '',
    `${ja4}\n`,
    `${ja4}\r`,
    `${ja4},${ja4}`,
    ja4.slice(1),
    ja4.replace('t13d', 'x13d'),
    ja4.replace('0101', '01x1'),
    ja4.replace('h2', 'h_'),
    ja4.replace('111111111111', 'AAAAAAAAAAAA'),
    [ja4],
    null,
  ])('rejects malformed fingerprints %j', value => {
    expect(ja4FingerprintSchema.safeParse(value).success).toBe(false);
  });

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
