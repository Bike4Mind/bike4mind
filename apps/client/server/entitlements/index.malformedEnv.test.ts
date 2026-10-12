import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';

// The env grant rows are parsed once at registry module load, so each case re-imports the
// real registry (no registry mock here, unlike index.test.ts) under a stubbed env value.
vi.mock('@server/models/Subscription', () => ({
  subscriptionRepository: { findActiveUserSubscriptions: vi.fn().mockResolvedValue([]) },
}));
vi.mock('@server/entitlements/partnerRules', () => ({
  partnerEntitlementsForEmail: vi.fn().mockResolvedValue(new Set()),
}));

const loadWithEnv = async (value: string) => {
  vi.stubEnv('NEXT_PUBLIC_PREMIUM_DOMAIN_GRANTS', value);
  vi.resetModules();
  return import('./index');
};

beforeEach(() => {
  vi.unstubAllEnvs();
});

afterAll(() => {
  vi.unstubAllEnvs();
  vi.resetModules();
});

describe('getUserEntitlements with a malformed NEXT_PUBLIC_PREMIUM_DOMAIN_GRANTS', () => {
  const user = { id: 'u1', tags: [], email: 'person@malformed.example', emailVerified: true };

  it.each(['[123]', '[null]', '{"domain":"malformed.example"}', 'not json'])(
    'does not throw for %s and grants nothing from it',
    async value => {
      const { getUserEntitlements } = await loadWithEnv(value);
      await expect(getUserEntitlements(user)).resolves.toEqual(['base']);
    }
  );

  it('drops non-string entitlement entries and normalizes the string ones', async () => {
    const { getUserEntitlements } = await loadWithEnv(
      JSON.stringify([{ domain: 'Malformed.Example', entitlements: [123, null, { k: 1 }, ' Some:Key '] }])
    );
    await expect(getUserEntitlements(user)).resolves.toEqual(['some:key', 'base']);
  });

  it('normalizes the key at parse time, so the raw registry rows carry canonical form', async () => {
    // getUserEntitlements normalizes again downstream, so asserting only through it would not
    // bind the parse-time `.map(normalizeTag)`. entitlementsForEmail reads the raw row values,
    // the same values the verify-credit path consumes - a mixed-case env key must already be
    // canonical here for those callers to match a gate.
    await loadWithEnv(JSON.stringify([{ domain: 'Malformed.Example', entitlements: [' Some:Key '] }]));
    const { entitlementsForEmail } = await import('@client/lib/entitlements/registry');
    expect([...entitlementsForEmail('person@malformed.example', true)]).toEqual(['some:key']);
  });

  it('keeps a valid row when a non-object row sits next to it', async () => {
    const { getUserEntitlements } = await loadWithEnv(
      JSON.stringify([null, { domain: 'malformed.example', entitlements: ['some:key'] }])
    );
    await expect(getUserEntitlements(user)).resolves.toEqual(['some:key', 'base']);
  });
});
