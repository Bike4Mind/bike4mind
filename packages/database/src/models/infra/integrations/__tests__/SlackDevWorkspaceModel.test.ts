import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import mongoose from 'mongoose';
import { slackDevWorkspaceRepository, SlackDevWorkspace } from '../SlackDevWorkspaceModel';
import type { MongoMemoryServer } from 'mongodb-memory-server';
import { createMongoServer } from '../../../../__test__/createMongoServer';

describe('SlackDevWorkspaceModel', () => {
  let mongoServer: MongoMemoryServer;

  beforeAll(async () => {
    mongoServer = await createMongoServer();
    await mongoose.connect(mongoServer.getUri());
    await SlackDevWorkspace.createIndexes();
  });

  afterAll(async () => {
    await mongoose.disconnect();
    await mongoServer?.stop();
  });

  afterEach(async () => {
    await SlackDevWorkspace.deleteMany({});
  });

  describe('create workspace', () => {
    it('should create a workspace with required fields', async () => {
      const workspaceData = {
        name: 'Acme',
        slackTeamId: 'T123ACME',
        slackAppId: 'A123456',
        slackBotUserId: 'U123BOT',
        slackBotId: 'B123BOT',
        slackBotToken: 'xoxb-test-token-12345',
        slackBotName: 'Acme Dev Assistant',
        isActive: true,
        installedAt: new Date(),
      };

      const workspace = await slackDevWorkspaceRepository.create(workspaceData);

      expect(workspace.name).toBe('Acme');
      expect(workspace.slackTeamId).toBe('T123ACME');
      expect(workspace.slackAppId).toBe('A123456');
      expect(workspace.slackBotUserId).toBe('U123BOT');
      expect(workspace.slackBotName).toBe('Acme Dev Assistant');
      expect(workspace.isActive).toBe(true);
      expect(workspace.createdAt).toBeDefined();
      expect(workspace.updatedAt).toBeDefined();
    });

    it('should not include slackBotToken in default query', async () => {
      const workspaceData = {
        name: 'Test Workspace',
        slackTeamId: 'T123TEST',
        slackAppId: 'A123456',
        slackBotUserId: 'U123BOT',
        slackBotId: 'B123BOT',
        slackBotToken: 'xoxb-secret-token',
        slackBotName: 'Test Bot',
        isActive: true,
        installedAt: new Date(),
      };

      await slackDevWorkspaceRepository.create(workspaceData);

      // Query without explicitly selecting token
      const workspace = await slackDevWorkspaceRepository.findBySlackTeamId('T123TEST');

      expect(workspace).toBeDefined();
      expect(workspace?.slackBotToken).toBeUndefined(); // Token should not be included
    });

    it('should allow multiple workspaces with same slackTeamId (uniqueness enforced at application level)', async () => {
      const workspaceData = {
        name: 'First Workspace',
        slackTeamId: 'T123UNIQUE',
        slackAppId: 'A123456',
        slackBotUserId: 'U123BOT',
        slackBotId: 'B123BOT',
        slackBotToken: 'xoxb-token-1',
        slackBotName: 'Bot 1',
        isActive: true,
        installedAt: new Date(),
      };

      await slackDevWorkspaceRepository.create(workspaceData);

      // Create another workspace with same slackTeamId (should succeed - no DB constraint)
      // Note: Application-level uniqueness is enforced during OAuth installation
      const duplicateData = { ...workspaceData, name: 'Second Workspace', slackAppId: 'A789012' };

      const secondWorkspace = await slackDevWorkspaceRepository.create(duplicateData);
      expect(secondWorkspace).toBeDefined();
      expect(secondWorkspace.name).toBe('Second Workspace');
      expect(secondWorkspace.slackTeamId).toBe('T123UNIQUE');
    });
  });

  describe('findBySlackTeamId', () => {
    it('should find workspace by slackTeamId', async () => {
      const workspaceData = {
        name: 'Globex',
        slackTeamId: 'T456GLOBEX',
        slackAppId: 'A789012',
        slackBotUserId: 'U456BOT',
        slackBotId: 'B456BOT',
        slackBotToken: 'xoxb-test-token-67890',
        slackBotName: 'Globex Assistant',
        isActive: true,
        installedAt: new Date(),
      };

      await slackDevWorkspaceRepository.create(workspaceData);

      const workspace = await slackDevWorkspaceRepository.findBySlackTeamId('T456GLOBEX');

      expect(workspace).toBeDefined();
      expect(workspace?.name).toBe('Globex');
      expect(workspace?.slackTeamId).toBe('T456GLOBEX');
    });

    it('should return null for non-existent slackTeamId', async () => {
      const workspace = await slackDevWorkspaceRepository.findBySlackTeamId('T999NONEXISTENT');

      expect(workspace).toBeNull();
    });

    it('should not return inactive workspaces', async () => {
      const workspaceData = {
        name: 'Inactive Workspace',
        slackTeamId: 'T789INACTIVE',
        slackAppId: 'A345678',
        slackBotUserId: 'U789BOT',
        slackBotId: 'B789BOT',
        slackBotToken: 'xoxb-inactive-token',
        slackBotName: 'Inactive Bot',
        isActive: false,
        installedAt: new Date(),
      };

      await slackDevWorkspaceRepository.create(workspaceData);

      const workspace = await slackDevWorkspaceRepository.findBySlackTeamId('T789INACTIVE');

      expect(workspace).toBeNull(); // Should not find inactive workspace
    });
  });

  describe('findAllActive', () => {
    it('should return all active workspaces', async () => {
      // Create 2 active workspaces
      await slackDevWorkspaceRepository.create({
        name: 'Workspace 1',
        slackTeamId: 'T111',
        slackAppId: 'A111',
        slackBotUserId: 'U111',
        slackBotId: 'B111',
        slackBotToken: 'token-1',
        slackBotName: 'Bot 1',
        isActive: true,
        installedAt: new Date(),
      });

      await slackDevWorkspaceRepository.create({
        name: 'Workspace 2',
        slackTeamId: 'T222',
        slackAppId: 'A222',
        slackBotUserId: 'U222',
        slackBotId: 'B222',
        slackBotToken: 'token-2',
        slackBotName: 'Bot 2',
        isActive: true,
        installedAt: new Date(),
      });

      // Create 1 inactive workspace
      await slackDevWorkspaceRepository.create({
        name: 'Workspace 3',
        slackTeamId: 'T333',
        slackAppId: 'A333',
        slackBotUserId: 'U333',
        slackBotId: 'B333',
        slackBotToken: 'token-3',
        slackBotName: 'Bot 3',
        isActive: false,
        installedAt: new Date(),
      });

      const activeWorkspaces = await slackDevWorkspaceRepository.findAllActive();

      expect(activeWorkspaces).toHaveLength(2);
      expect(activeWorkspaces.every(w => w.isActive)).toBe(true);
    });

    it('should return empty array when no active workspaces', async () => {
      const activeWorkspaces = await slackDevWorkspaceRepository.findAllActive();

      expect(activeWorkspaces).toHaveLength(0);
    });
  });

  describe('deactivate', () => {
    it('should deactivate a workspace', async () => {
      const workspaceData = {
        name: 'To Deactivate',
        slackTeamId: 'T999DEACTIVATE',
        slackAppId: 'A999',
        slackBotUserId: 'U999',
        slackBotId: 'B999',
        slackBotToken: 'token-999',
        slackBotName: 'Bot 999',
        isActive: true,
        installedAt: new Date(),
      };

      const workspace = await slackDevWorkspaceRepository.create(workspaceData);

      const deactivated = await slackDevWorkspaceRepository.deactivate(workspace.id);

      expect(deactivated).toBeDefined();
      expect(deactivated?.isActive).toBe(false);

      // Verify it's not returned in active workspaces
      const active = await slackDevWorkspaceRepository.findAllActive();
      expect(active).toHaveLength(0);
    });

    it('should return null when deactivating non-existent workspace', async () => {
      // Use a non-existent ObjectId
      const result = await slackDevWorkspaceRepository.deactivate('507f1f77bcf86cd799439011');

      expect(result).toBeNull();
    });
  });

  describe('findBySlackTeamIdWithToken', () => {
    it('should return workspace with slackBotToken included', async () => {
      const workspaceData = {
        name: 'Token Test',
        slackTeamId: 'T555TOKEN',
        slackAppId: 'A555',
        slackBotUserId: 'U555',
        slackBotId: 'B555',
        slackBotToken: 'xoxb-secret-token-555',
        slackBotName: 'Token Bot',
        isActive: true,
        installedAt: new Date(),
      };

      await slackDevWorkspaceRepository.create(workspaceData);

      const workspace = await slackDevWorkspaceRepository.findBySlackTeamIdWithToken('T555TOKEN');

      expect(workspace).toBeDefined();
      expect(workspace?.slackBotToken).toBe('xoxb-secret-token-555'); // Token should be included
    });
  });

  describe('update workspace (reinstall)', () => {
    it('should update workspace with new OAuth token on reinstall', async () => {
      // 1. Create initial workspace
      const workspace = await slackDevWorkspaceRepository.create({
        name: 'Original Name',
        slackTeamId: 'T123REINSTALL',
        slackAppId: 'A123',
        slackBotUserId: 'U123',
        slackBotId: 'B123',
        slackBotToken: 'xoxb-old-token',
        slackBotName: 'Old Bot',
        isActive: true,
        installedAt: new Date('2024-01-01'),
      });

      // 2. Update with new token (simulating reinstall)
      const updated = await slackDevWorkspaceRepository.update({
        id: workspace.id,
        slackBotToken: 'xoxb-new-token',
        installedAt: new Date('2024-12-01'),
      });

      // 3. Verify update succeeded
      expect(updated).toBeDefined();

      // 4. Fetch with token to verify the new token was saved
      const fetched = await slackDevWorkspaceRepository.findBySlackTeamIdWithToken('T123REINSTALL');
      expect(fetched?.slackBotToken).toBe('xoxb-new-token');
    });

    it('should update workspace name if renamed in Slack', async () => {
      // 1. Create initial workspace
      const workspace = await slackDevWorkspaceRepository.create({
        name: 'Old Workspace Name',
        slackTeamId: 'T456RENAME',
        slackAppId: 'A456',
        slackBotUserId: 'U456',
        slackBotId: 'B456',
        slackBotToken: 'xoxb-token-456',
        slackBotName: 'Bot',
        isActive: true,
        installedAt: new Date(),
      });

      // 2. Update with new name (simulating workspace rename + reinstall)
      await slackDevWorkspaceRepository.update({
        id: workspace.id,
        name: 'New Workspace Name',
      });

      // 3. Verify name was updated
      const fetched = await slackDevWorkspaceRepository.findBySlackTeamId('T456RENAME');
      expect(fetched?.name).toBe('New Workspace Name');
    });
  });
});
