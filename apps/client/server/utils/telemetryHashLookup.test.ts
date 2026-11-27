import { Logger } from '@bike4mind/observability';
import { createHmac, randomBytes } from 'crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { regenerateHashesForDeletion } from '@bike4mind/common';

const mocks = vi.hoisted(() => ({ distinct: vi.fn(), setOptions: vi.fn() }));
const secrets = vi.hoisted(() => ({
  values: { SECRET_ENCRYPTION_KEY: 'test-telemetry-hmac-secret' } as Record<string, string | undefined>,
}));
vi.mock('sst', () => ({
  Resource: new Proxy(
    {},
    {
      get: (_target, name) => {
        const value = secrets.values[String(name)];
        return value === undefined ? undefined : { value };
      },
    }
  ),
}));
vi.mock('@bike4mind/database', () => ({
  User: { findById: () => ({ select: () => ({ lean: async () => ({ organizationId: 'current-org' }) }) }) },
  organizationRepository: { findMembershipOrgIds: async () => ['member-org'] },
  questRepository: { findOrganizationIdsForUser: mocks.distinct },
}));
import { deriveTelemetrySalts, regenerateUserTelemetryHashes } from './telemetryHashLookup';

describe('telemetry hash lookup', () => {
  it('covers personal, current, member and departed organizations, including deleted turns', async () => {
    mocks.distinct.mockResolvedValue(['departed-org']);
    const hashes = await regenerateUserTelemetryHashes('user-1');
    const salts = deriveTelemetrySalts();
    for (const organizationId of ['default', 'current-org', 'member-org', 'departed-org']) {
      expect(hashes).toEqual(expect.arrayContaining(regenerateHashesForDeletion('user-1', organizationId, salts)));
    }
    expect(mocks.distinct).toHaveBeenCalledWith('user-1');
  });

  describe('daily salts', () => {
    const dailySalt = (secret: string, dateKey: string) => createHmac('sha256', secret).update(dateKey).digest('hex');
    const derive = (root: string) => createHmac('sha256', root).update('b4m-signing/telemetry-salt/v1').digest('hex');
    const original = { ...secrets.values };
    afterEach(() => {
      secrets.values = { ...original };
      vi.restoreAllMocks();
    });

    it('without a dedicated secret, covers the derived and the raw encryption key for every day', () => {
      const salts = deriveTelemetrySalts();
      const keys = [derive('test-telemetry-hmac-secret'), 'test-telemetry-hmac-secret'];
      expect(salts).toHaveLength(91 * keys.length);
      for (const dateKey of new Set(salts.map(s => s.dateKey))) {
        const forDay = salts.filter(s => s.dateKey === dateKey).map(s => s.salt);
        expect(forDay).toEqual(keys.map(key => dailySalt(key, dateKey)));
      }
    });

    it('with a dedicated secret and a previous secret, covers both keys for every day', () => {
      const root = randomBytes(32).toString('hex');
      const previous = randomBytes(32).toString('hex');
      secrets.values = { HMAC_SIGNING_SECRET: root, HMAC_SIGNING_SECRET_PREVIOUS: previous };

      const salts = deriveTelemetrySalts();
      const keys = [
        derive(root),
        createHmac('sha256', previous).update('b4m-signing/telemetry-salt/v1').digest('hex'),
        previous,
      ];
      expect(salts).toHaveLength(91 * keys.length);
      const dateKeys = [...new Set(salts.map(s => s.dateKey))];
      expect(dateKeys).toHaveLength(91);
      for (const dateKey of dateKeys) {
        const forDay = salts.filter(s => s.dateKey === dateKey).map(s => s.salt);
        expect(forDay).toEqual(keys.map(key => dailySalt(key, dateKey)));
      }
    });

    it('with a dedicated secret and no previous secret, still covers the encryption key', () => {
      const root = randomBytes(32).toString('hex');
      secrets.values = { ...original, HMAC_SIGNING_SECRET: root };

      const salts = deriveTelemetrySalts();

      expect(salts).toHaveLength(182);
      const today = new Date().toISOString().split('T')[0];
      expect(salts.filter(entry => entry.dateKey === today).map(entry => entry.salt)).toEqual([
        dailySalt(derive(root), today),
        dailySalt('test-telemetry-hmac-secret', today),
      ]);
    });

    it('does not repeat the encryption key when it is also the previous secret', () => {
      secrets.values = {
        ...original,
        HMAC_SIGNING_SECRET: randomBytes(32).toString('hex'),
        HMAC_SIGNING_SECRET_PREVIOUS: original.SECRET_ENCRYPTION_KEY,
      };

      const salts = deriveTelemetrySalts();

      expect(salts).toHaveLength(273);
      expect(new Set(salts.map(entry => entry.salt)).size).toBe(273);
    });

    it('finds hashes written under the previous secret as well as the current one', async () => {
      const root = randomBytes(32).toString('hex');
      const previous = randomBytes(32).toString('hex');
      mocks.distinct.mockResolvedValue([]);
      const dateKey = new Date().toISOString().split('T')[0];
      const hashFor = (secret: string) =>
        regenerateHashesForDeletion('user-1', 'current-org', [{ salt: dailySalt(secret, dateKey), dateKey }])[0];

      secrets.values = { HMAC_SIGNING_SECRET: root, HMAC_SIGNING_SECRET_PREVIOUS: previous };
      const hashes = await regenerateUserTelemetryHashes('user-1');

      expect(hashes).toContain(hashFor(derive(root)));
      expect(hashes).toContain(hashFor(previous));
    });

    it('uses the predictable placeholder salt and warns when no key is configured', () => {
      secrets.values = {};
      const warn = vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
      const salts = deriveTelemetrySalts();
      expect(salts).toHaveLength(91);
      for (const { salt, dateKey } of salts) expect(salt).toBe(`telemetry-salt-${dateKey}`);
      expect(warn).toHaveBeenCalledTimes(1);
    });

    it('keeps salting with the shipped placeholder encryption key, as the writer does', () => {
      secrets.values = { SECRET_ENCRYPTION_KEY: 'my-secret-placeholder-value' };
      const salts = deriveTelemetrySalts();
      const { dateKey } = salts[0];
      const forDay = salts.filter(s => s.dateKey === dateKey).map(s => s.salt);
      expect(forDay).toEqual(
        [derive('my-secret-placeholder-value'), 'my-secret-placeholder-value'].map(key => dailySalt(key, dateKey))
      );
    });
  });
});
