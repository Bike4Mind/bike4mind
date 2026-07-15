import { describe, it, expect, beforeEach } from 'vitest';
import { AuthStrategy } from '@bike4mind/common';
import { User } from './UserModel';
import { setupMongoTest } from '../../__test__/utils';

describe('UserModel authProviders', () => {
  setupMongoTest();

  beforeEach(async () => {
    await User.deleteMany({});
  });

  const baseUser = (overrides: Record<string, unknown> = {}) => ({
    name: 'Auth Providers Test',
    username: `ap-test-${Math.random().toString(36).slice(2, 10)}`,
    password: null,
    hasUsablePassword: false,
    ...overrides,
  });

  describe('typed sub-schema', () => {
    it('persists a well-formed provider entry with all typed fields', async () => {
      const user = await User.create(
        baseUser({
          authProviders: [
            {
              strategy: AuthStrategy.Okta,
              id: 'sub-123',
              accessToken: 'at',
              refreshToken: 'rt',
              oktaIdentityProviderId: 'idp-1',
              encrypted: true,
            },
          ],
        })
      );

      const reloaded = await User.findById(user._id);
      expect(reloaded?.authProviders).toHaveLength(1);
      const provider = reloaded!.authProviders![0];
      expect(provider.strategy).toBe(AuthStrategy.Okta);
      expect(provider.id).toBe('sub-123');
      expect(provider.accessToken).toBe('at');
      expect(provider.refreshToken).toBe('rt');
      expect(provider.oktaIdentityProviderId).toBe('idp-1');
      expect(provider.encrypted).toBe(true);
    });

    it('defaults id to null (legacy-row shape) when omitted', async () => {
      const user = await User.create(baseUser({ authProviders: [{ strategy: AuthStrategy.Google }] }));
      expect(user.authProviders![0].id).toBeNull();
    });

    it('rejects a strategy outside the AuthStrategy enum', async () => {
      await expect(User.create(baseUser({ authProviders: [{ strategy: 'not-a-strategy', id: 'x' }] }))).rejects.toThrow(
        /validation/i
      );
    });

    it('rejects an entry with no strategy', async () => {
      await expect(User.create(baseUser({ authProviders: [{ id: 'orphan' }] }))).rejects.toThrow(/validation/i);
    });
  });

  describe('duplicate (strategy, id) pre-save guard', () => {
    it('dedupes exact (strategy, id) duplicates on create, keeping the freshest entry', async () => {
      // The concurrent first-login TOCTOU shape: the same provider identity
      // written twice; the later entry carries newer tokens and must win.
      const user = await User.create(
        baseUser({
          authProviders: [
            { strategy: AuthStrategy.Google, id: 'sub-1', accessToken: 'stale' },
            { strategy: AuthStrategy.Google, id: 'sub-1', accessToken: 'fresh' },
          ],
        })
      );

      expect(user.authProviders).toHaveLength(1);
      expect(user.authProviders![0].accessToken).toBe('fresh');

      const reloaded = await User.findById(user._id);
      expect(reloaded?.authProviders).toHaveLength(1);
    });

    it('dedupes duplicate legacy null-id pairs per strategy', async () => {
      const user = await User.create(
        baseUser({
          authProviders: [
            { strategy: AuthStrategy.SAML, accessToken: 'stale' },
            { strategy: AuthStrategy.SAML, accessToken: 'fresh' },
          ],
        })
      );
      expect(user.authProviders).toHaveLength(1);
      expect(user.authProviders![0].accessToken).toBe('fresh');
    });

    it('keeps distinct identities: same strategy with different ids, and different strategies', async () => {
      const user = await User.create(
        baseUser({
          authProviders: [
            { strategy: AuthStrategy.Okta, id: 'sub-a', oktaIdentityProviderId: 'idp-1' },
            { strategy: AuthStrategy.Okta, id: 'sub-b', oktaIdentityProviderId: 'idp-2' },
            { strategy: AuthStrategy.Github, id: 'sub-a' },
          ],
        })
      );
      expect(user.authProviders).toHaveLength(3);
    });

    it('self-heals a duplicate pushed onto an existing document on save', async () => {
      const user = await User.create(
        baseUser({ authProviders: [{ strategy: AuthStrategy.Google, id: 'sub-1', accessToken: 'stale' }] })
      );

      user.authProviders!.push({ strategy: AuthStrategy.Google, id: 'sub-1', accessToken: 'fresh' });
      await user.save();

      const reloaded = await User.findById(user._id);
      expect(reloaded?.authProviders).toHaveLength(1);
      expect(reloaded?.authProviders![0].accessToken).toBe('fresh');
    });
  });
});
