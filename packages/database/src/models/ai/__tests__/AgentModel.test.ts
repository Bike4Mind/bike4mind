import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import mongoose from 'mongoose';
import type { MongoMemoryServer } from 'mongodb-memory-server';
import { createMongoServer } from '../../../__test__/createMongoServer';
import Agent from '../AgentModel';

const baseAgentData = {
  name: 'Test Agent',
  description: 'A test agent for unit tests',
  userId: 'user-123',
  triggerWords: ['@test'],
  isPublic: false,
  capabilities: ['{"responseStyle":"friendly","specialBehaviors":[]}'],
  useOwnCredits: false,
  personality: {
    majorMotivation: 'Testing',
    minorMotivation: 'Validation',
    flaw: 'Too literal',
    quirk: 'Speaks in assertions',
    description: 'A diligent test agent',
  },
};

describe('AgentModel', () => {
  let mongoServer: MongoMemoryServer;

  beforeAll(async () => {
    mongoServer = await createMongoServer();
    await mongoose.connect(mongoServer.getUri());
  }, 30000);

  afterAll(async () => {
    await mongoose.disconnect();
    await mongoServer.stop();
  }, 30000);

  beforeEach(async () => {
    if (mongoose.connection.db) {
      await mongoose.connection.db.dropDatabase();
    }
  });

  describe('projectId optionality', () => {
    it('should create an agent without projectId', async () => {
      const agent = await Agent.create(baseAgentData);

      expect(agent.name).toBe('Test Agent');
      expect(agent.userId).toBe('user-123');
      expect(agent.projectId).toBeUndefined();
    });

    it('should create an agent with projectId', async () => {
      const agent = await Agent.create({
        ...baseAgentData,
        projectId: 'project-456',
      });

      expect(agent.projectId).toBe('project-456');
    });

    it('should allow updating projectId from undefined to a value', async () => {
      const agent = await Agent.create(baseAgentData);
      expect(agent.projectId).toBeUndefined();

      agent.projectId = 'project-789';
      await agent.save();

      const updated = await Agent.findById(agent._id);
      expect(updated?.projectId).toBe('project-789');
    });

    it('should allow clearing projectId from an existing agent', async () => {
      const agent = await Agent.create({
        ...baseAgentData,
        projectId: 'project-456',
      });
      expect(agent.projectId).toBe('project-456');

      agent.projectId = undefined as unknown as string;
      await agent.save();

      const updated = await Agent.findById(agent._id);
      expect(updated?.projectId).toBeUndefined();
    });
  });

  describe('required field validation', () => {
    it('should reject an agent without name', async () => {
      const { name: _, ...dataWithoutName } = baseAgentData;
      await expect(Agent.create(dataWithoutName)).rejects.toThrow(/name.*required/i);
    });

    it('should reject an agent without description', async () => {
      const { description: _, ...dataWithoutDesc } = baseAgentData;
      await expect(Agent.create(dataWithoutDesc)).rejects.toThrow(/description.*required/i);
    });

    it('should reject an agent with no scope set (#8336)', async () => {
      // userId is no longer required at the field level; the scope discriminator
      // hook requires exactly one of userId / organizationId / isSystem instead.
      const { userId: _, ...dataWithoutScope } = baseAgentData;
      await expect(Agent.create(dataWithoutScope)).rejects.toThrow(/exactly one of/i);
    });
  });

  describe('turnTimeoutSeconds bounds (#8882)', () => {
    it('should accept an in-range turnTimeoutSeconds', async () => {
      const agent = await Agent.create({ ...baseAgentData, turnTimeoutSeconds: 10 });
      expect(agent.turnTimeoutSeconds).toBe(10);
    });

    it('should reject a turnTimeoutSeconds below the minimum (1)', async () => {
      await expect(Agent.create({ ...baseAgentData, turnTimeoutSeconds: 0 })).rejects.toThrow(/turnTimeoutSeconds/i);
    });

    it('should reject a turnTimeoutSeconds above the maximum (30)', async () => {
      await expect(Agent.create({ ...baseAgentData, turnTimeoutSeconds: 31 })).rejects.toThrow(/turnTimeoutSeconds/i);
    });

    it('should reject a non-integer turnTimeoutSeconds (mirrors the API .int() rule)', async () => {
      await expect(Agent.create({ ...baseAgentData, turnTimeoutSeconds: 1.5 })).rejects.toThrow(/turnTimeoutSeconds/i);
    });
  });
});
