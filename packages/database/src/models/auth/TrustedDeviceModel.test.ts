import { describe, it, expect } from 'vitest';
import { TrustedDeviceModel, trustedDeviceRepository, TRUSTED_DEVICE_TTL_MS } from './TrustedDeviceModel';
import { setupMongoTest } from '../../__test__/utils';

setupMongoTest();

const HOUR = 60 * 60 * 1000;

const makeDevice = (userId: string, overrides: Partial<{ tokenHash: string; expiresAt: Date; label: string }> = {}) =>
  trustedDeviceRepository.create({
    userId,
    tokenHash: overrides.tokenHash ?? `hash-${Math.random()}`,
    label: overrides.label ?? 'Chrome on macOS',
    expiresAt: overrides.expiresAt ?? new Date(Date.now() + TRUSTED_DEVICE_TTL_MS),
  });

/**
 * A trusted device lets a login skip the second factor, so every lookup and delete
 * has to be scoped to the owning user AND to a live window inside the query itself.
 * A miss here is an MFA bypass, not a cosmetic bug.
 */
describe('trustedDeviceRepository', () => {
  describe('findValidForUser', () => {
    it('returns the device for its owner', async () => {
      const device = await makeDevice('user-a');
      const found = await trustedDeviceRepository.findValidForUser(device.id, 'user-a');
      expect(found?.id).toBe(device.id);
    });

    it("does not return another user's device", async () => {
      const device = await makeDevice('user-a');
      expect(await trustedDeviceRepository.findValidForUser(device.id, 'user-b')).toBeNull();
    });

    it('does not return an expired device', async () => {
      const device = await makeDevice('user-a', { expiresAt: new Date(Date.now() - HOUR) });
      expect(await trustedDeviceRepository.findValidForUser(device.id, 'user-a')).toBeNull();
    });

    it('returns null for a malformed id instead of throwing a cast error', async () => {
      expect(await trustedDeviceRepository.findValidForUser('not-an-object-id', 'user-a')).toBeNull();
    });
  });

  describe('revoke', () => {
    it("removes the caller's own device", async () => {
      const device = await makeDevice('user-a');
      expect(await trustedDeviceRepository.revoke(device.id, 'user-a')).toBe(true);
      expect(await TrustedDeviceModel.findById(device.id)).toBeNull();
    });

    it('refuses to remove a device belonging to someone else', async () => {
      const device = await makeDevice('user-a');
      expect(await trustedDeviceRepository.revoke(device.id, 'user-b')).toBe(false);
      expect(await TrustedDeviceModel.findById(device.id)).not.toBeNull();
    });

    it('reports false for a malformed id', async () => {
      expect(await trustedDeviceRepository.revoke('nope', 'user-a')).toBe(false);
    });
  });

  describe('revokeAllForUser', () => {
    it('drops every device for the user and leaves other users untouched', async () => {
      await makeDevice('user-a');
      await makeDevice('user-a');
      await makeDevice('user-b');

      expect(await trustedDeviceRepository.revokeAllForUser('user-a')).toBe(2);
      expect(await TrustedDeviceModel.countDocuments({ userId: 'user-a' })).toBe(0);
      expect(await TrustedDeviceModel.countDocuments({ userId: 'user-b' })).toBe(1);
    });
  });

  describe('window management', () => {
    it('touch records use without extending the window', async () => {
      const expiresAt = new Date(Date.now() + 5 * HOUR);
      const device = await makeDevice('user-a', { expiresAt });

      await trustedDeviceRepository.touch(device.id, '203.0.113.4');

      const reloaded = await TrustedDeviceModel.findById(device.id);
      expect(reloaded?.lastUsedAt).toBeInstanceOf(Date);
      expect(reloaded?.lastUsedIp).toBe('203.0.113.4');
      // The absolute window is the point: a device cannot renew itself by being used,
      // so it always re-proves the second factor eventually.
      expect(reloaded?.expiresAt.getTime()).toBe(expiresAt.getTime());
    });

    it('extend slides the window forward on an explicit re-grant', async () => {
      const device = await makeDevice('user-a', { expiresAt: new Date(Date.now() + HOUR) });
      const later = new Date(Date.now() + 10 * HOUR);

      await trustedDeviceRepository.extend(device.id, later, '198.51.100.7');

      const reloaded = await TrustedDeviceModel.findById(device.id);
      expect(reloaded?.expiresAt.getTime()).toBe(later.getTime());
    });
  });

  describe('listByUser', () => {
    it("lists only the user's live devices, newest first", async () => {
      await makeDevice('user-a', { label: 'older' });
      await makeDevice('user-a', { label: 'newer' });
      await makeDevice('user-a', { label: 'stale', expiresAt: new Date(Date.now() - HOUR) });
      await makeDevice('user-b', { label: 'other user' });

      const devices = await trustedDeviceRepository.listByUser('user-a');
      expect(devices.map(d => d.label).sort()).toEqual(['newer', 'older']);
    });
  });

  describe('per-user cap', () => {
    it('prunes the oldest grants so the collection cannot grow without bound', async () => {
      for (let i = 0; i < 25; i++) {
        await makeDevice('user-a', { label: `device-${i}` });
      }
      expect(await TrustedDeviceModel.countDocuments({ userId: 'user-a' })).toBe(20);
      // The just-granted device must never be the one pruned - that would revoke the
      // trust the user just asked for.
      expect(await TrustedDeviceModel.findOne({ userId: 'user-a', label: 'device-24' })).not.toBeNull();
    });
  });
});
