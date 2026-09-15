import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import mongoose from 'mongoose';
import { orgJiraConnectionRepository, OrgJiraConnection } from '../OrgJiraConnectionModel';
import type { MongoMemoryServer } from 'mongodb-memory-server';
import { createMongoServer } from '../../../../__test__/createMongoServer';

describe('OrgJiraConnectionModel', () => {
  let mongoServer: MongoMemoryServer;

  beforeAll(async () => {
    mongoServer = await createMongoServer();
    await mongoose.connect(mongoServer.getUri());
    await OrgJiraConnection.createIndexes();
  });

  afterAll(async () => {
    await mongoose.disconnect();
    await mongoServer?.stop();
  });

  afterEach(async () => {
    await OrgJiraConnection.deleteMany({});
  });

  const baseConnection = {
    cloudId: 'cloud-123',
    siteUrl: 'https://org-a.atlassian.net',
    accessToken: 'encrypted-token-a',
    connectedBy: 'user-1',
  };

  describe('create connection', () => {
    it('creates a connection with defaults', async () => {
      const connection = await orgJiraConnectionRepository.create({
        ...baseConnection,
        organizationId: 'org-a',
      });

      expect(connection.organizationId).toBe('org-a');
      expect(connection.cloudId).toBe('cloud-123');
      expect(connection.enabled).toBe(true);
      expect(connection.isSystemDefault).toBe(false);
    });

    it('excludes accessToken from default queries', async () => {
      await orgJiraConnectionRepository.create({ ...baseConnection, organizationId: 'org-a' });

      const found = await orgJiraConnectionRepository.findByOrganizationId('org-a');
      expect(found).not.toBeNull();
      expect(found?.accessToken).toBeUndefined();
    });

    it('includes accessToken when fetched with credentials', async () => {
      await orgJiraConnectionRepository.create({ ...baseConnection, organizationId: 'org-a' });

      const found = await orgJiraConnectionRepository.findByOrganizationIdWithCredentials('org-a');
      expect(found?.accessToken).toBe('encrypted-token-a');
    });

    it('enforces one connection per organization', async () => {
      await orgJiraConnectionRepository.create({ ...baseConnection, organizationId: 'org-a' });

      await expect(
        orgJiraConnectionRepository.create({ ...baseConnection, organizationId: 'org-a' })
      ).rejects.toThrow();
    });

    it('allows multiple system-default (null org) rows without unique collision', async () => {
      await orgJiraConnectionRepository.create({ ...baseConnection, organizationId: null, isSystemDefault: true });
      await expect(
        orgJiraConnectionRepository.create({ ...baseConnection, organizationId: null })
      ).resolves.toBeDefined();
    });
  });

  describe('org isolation', () => {
    it('resolves each organization to its own connection', async () => {
      await orgJiraConnectionRepository.create({ ...baseConnection, organizationId: 'org-a' });
      await orgJiraConnectionRepository.create({
        ...baseConnection,
        organizationId: 'org-b',
        cloudId: 'cloud-456',
        siteUrl: 'https://org-b.atlassian.net',
        accessToken: 'encrypted-token-b',
      });

      const connA = await orgJiraConnectionRepository.findByOrganizationIdWithCredentials('org-a');
      const connB = await orgJiraConnectionRepository.findByOrganizationIdWithCredentials('org-b');

      expect(connA?.cloudId).toBe('cloud-123');
      expect(connA?.accessToken).toBe('encrypted-token-a');
      expect(connB?.cloudId).toBe('cloud-456');
      expect(connB?.accessToken).toBe('encrypted-token-b');
    });

    it('does not return disabled connections from findByOrganizationId', async () => {
      await orgJiraConnectionRepository.create({ ...baseConnection, organizationId: 'org-a', enabled: false });

      expect(await orgJiraConnectionRepository.findByOrganizationId('org-a')).toBeFalsy();
      expect(await orgJiraConnectionRepository.findByOrganizationIdAny('org-a')).toBeTruthy();
    });
  });

  describe('system default', () => {
    it('finds the enabled system default connection', async () => {
      await orgJiraConnectionRepository.create({
        ...baseConnection,
        organizationId: null,
        isSystemDefault: true,
      });

      const found = await orgJiraConnectionRepository.findSystemDefault();
      expect(found?.isSystemDefault).toBe(true);

      const withCreds = await orgJiraConnectionRepository.findSystemDefaultWithCredentials();
      expect(withCreds?.accessToken).toBe('encrypted-token-a');
    });

    it('returns null when no system default exists', async () => {
      await orgJiraConnectionRepository.create({ ...baseConnection, organizationId: 'org-a' });
      expect(await orgJiraConnectionRepository.findSystemDefault()).toBeFalsy();
    });
  });
});
