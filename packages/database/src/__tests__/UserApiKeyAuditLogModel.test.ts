import { describe, it, expect, beforeEach } from 'vitest';
import { UserApiKeyAuditLog } from '../models/auth/UserApiKeyAuditLogModel';
import { setupMongoTest } from '../__test__/utils';

setupMongoTest();

beforeEach(async () => {
  await UserApiKeyAuditLog.syncIndexes();
});

const baseDoc = {
  action: 'mint' as const,
  keyId: 'key-1',
  productId: 'vibeswire',
  actorUserId: 'admin-1',
};

describe('UserApiKeyAuditLog', () => {
  describe('create and read', () => {
    it('persists all required fields', async () => {
      const doc = await UserApiKeyAuditLog.create(baseDoc);
      const found = await UserApiKeyAuditLog.findById(doc._id);
      expect(found?.action).toBe('mint');
      expect(found?.keyId).toBe('key-1');
      expect(found?.productId).toBe('vibeswire');
      expect(found?.actorUserId).toBe('admin-1');
    });

    it('accepts rotate and revoke actions', async () => {
      await expect(UserApiKeyAuditLog.create({ ...baseDoc, action: 'rotate' })).resolves.toBeDefined();
      await expect(UserApiKeyAuditLog.create({ ...baseDoc, action: 'revoke' })).resolves.toBeDefined();
    });

    it('rejects invalid action values', async () => {
      await expect(UserApiKeyAuditLog.create({ ...baseDoc, action: 'delete' as any })).rejects.toThrow();
    });

    it('productId is optional', async () => {
      const doc = await UserApiKeyAuditLog.create({ ...baseDoc, productId: undefined });
      expect(doc.productId).toBeUndefined();
    });
  });

  describe('expiresAt TTL default', () => {
    it('sets expiresAt to ~90 days in the future when not provided', async () => {
      const before = Date.now();
      const doc = await UserApiKeyAuditLog.create(baseDoc);
      const after = Date.now();
      const ninety = 90 * 24 * 60 * 60 * 1000;
      const exp = doc.expiresAt.getTime();
      // Allow 1s clock skew in either direction
      expect(exp).toBeGreaterThanOrEqual(before + ninety - 1000);
      expect(exp).toBeLessThanOrEqual(after + ninety + 1000);
    });

    it('allows explicit expiresAt override', async () => {
      const custom = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);
      const doc = await UserApiKeyAuditLog.create({ ...baseDoc, expiresAt: custom });
      expect(doc.expiresAt.toISOString()).toBe(custom.toISOString());
    });
  });

  describe('compound indexes', () => {
    it('finds documents by productId sorted by createdAt', async () => {
      await UserApiKeyAuditLog.create({ ...baseDoc, keyId: 'k-a' });
      await UserApiKeyAuditLog.create({ ...baseDoc, keyId: 'k-b' });
      const results = await UserApiKeyAuditLog.find({ productId: 'vibeswire' }).sort({ createdAt: -1 });
      expect(results.length).toBeGreaterThanOrEqual(2);
    });

    it('finds documents by keyId sorted by createdAt', async () => {
      await UserApiKeyAuditLog.create(baseDoc);
      const results = await UserApiKeyAuditLog.find({ keyId: 'key-1' }).sort({ createdAt: -1 });
      expect(results.length).toBeGreaterThanOrEqual(1);
    });
  });
});
