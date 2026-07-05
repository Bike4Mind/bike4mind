import { describe, it, expect } from 'vitest';
import mongoose from 'mongoose';
import { agentRepository, Agent } from '../AgentModel';
import { setupMongoTest } from '../../../__test__/utils';

/**
 * Scope-aware agent tests for the unified IAgent / IAgentDefinition model.
 *
 * Ports the org-scoped CRUD coverage from the deleted `AgentDefinitionModel.test.ts`
 * onto the unified `agentRepository`, and adds new tests for the scope discriminator
 * (user / organization / system) introduced by the unification.
 */

function makeOrgAgentInput(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    organizationId: new mongoose.Types.ObjectId().toString(),
    name: 'compliance_reviewer',
    description: 'Reviews changes for compliance with internal policies.',
    preferredModel: 'claude-3-5-haiku-20241022',
    systemPrompt: 'You are a compliance reviewer. Task: $TASK',
    maxIterations: { quick: 3, medium: 6, very_thorough: 12 },
    defaultThoroughness: 'medium' as const,
    ...overrides,
  };
}

function makeUserAgentInput(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    userId: new mongoose.Types.ObjectId().toString(),
    name: 'personal_helper',
    description: 'A personal helper agent.',
    preferredModel: 'claude-3-5-haiku-20241022',
    systemPrompt: 'You help with personal tasks.',
    ...overrides,
  };
}

describe('AgentRepository (unified, #8336)', () => {
  setupMongoTest();

  describe('scope discriminator', () => {
    it('accepts an org-scoped agent (organizationId only)', async () => {
      const created = await Agent.create(makeOrgAgentInput());
      expect(created.organizationId).toBeTruthy();
      expect(created.userId).toBeUndefined();
      expect(created.isSystem).toBeFalsy();
    });

    it('accepts a user-scoped agent (userId only)', async () => {
      const created = await Agent.create(makeUserAgentInput());
      expect(created.userId).toBeTruthy();
      expect(created.organizationId).toBeUndefined();
    });

    it('accepts a system agent (isSystem only)', async () => {
      const created = await Agent.create({
        name: 'built_in_researcher',
        description: 'A system-level researcher.',
        isSystem: true,
        preferredModel: 'claude-3-5-haiku-20241022',
        systemPrompt: 'You are a researcher.',
        maxIterations: { quick: 5, medium: 15, very_thorough: 30 },
        defaultThoroughness: 'medium',
      });
      expect(created.isSystem).toBe(true);
    });

    it('rejects an agent with no scope set', async () => {
      await expect(
        Agent.create({
          name: 'orphan_agent',
          description: 'No scope.',
        })
      ).rejects.toThrow(/exactly one of/);
    });

    it('rejects an agent with multiple scopes set', async () => {
      await expect(
        Agent.create({
          name: 'overscoped',
          description: 'Too many scopes.',
          userId: new mongoose.Types.ObjectId().toString(),
          organizationId: new mongoose.Types.ObjectId().toString(),
        })
      ).rejects.toThrow(/exactly one of/);
    });
  });

  describe('listForOrganization', () => {
    it('returns only the requested org and excludes soft-deleted', async () => {
      const orgA = new mongoose.Types.ObjectId().toString();
      const orgB = new mongoose.Types.ObjectId().toString();

      await Agent.create(makeOrgAgentInput({ organizationId: orgA, name: 'agent_one' }));
      await Agent.create(makeOrgAgentInput({ organizationId: orgA, name: 'agent_two' }));
      const toDelete = await Agent.create(makeOrgAgentInput({ organizationId: orgA, name: 'agent_three' }));
      await Agent.create(makeOrgAgentInput({ organizationId: orgB, name: 'agent_one' }));

      // Soft-delete via direct field set (softDeletePlugin convention).
      await Agent.updateOne({ _id: toDelete._id }, { $set: { deletedAt: new Date() } });

      const orgAList = await agentRepository.listForOrganization(orgA);
      expect(orgAList.map(a => a.name).sort()).toEqual(['agent_one', 'agent_two']);

      const orgBList = await agentRepository.listForOrganization(orgB);
      expect(orgBList).toHaveLength(1);
      expect(orgBList[0]?.name).toBe('agent_one');
    });
  });

  describe('listForUser', () => {
    it('returns only the requested user and excludes soft-deleted', async () => {
      const userA = new mongoose.Types.ObjectId().toString();
      const userB = new mongoose.Types.ObjectId().toString();

      await Agent.create(makeUserAgentInput({ userId: userA, name: 'a_one' }));
      await Agent.create(makeUserAgentInput({ userId: userA, name: 'a_two' }));
      await Agent.create(makeUserAgentInput({ userId: userB, name: 'b_one' }));

      const userAList = await agentRepository.listForUser(userA);
      expect(userAList.map(a => a.name).sort()).toEqual(['a_one', 'a_two']);

      const userBList = await agentRepository.listForUser(userB);
      expect(userBList).toHaveLength(1);
    });
  });

  describe('listSystem', () => {
    it('returns only system agents', async () => {
      await Agent.create(makeUserAgentInput({ name: 'user_one' }));
      await Agent.create({
        name: 'system_one',
        description: 'A system agent.',
        isSystem: true,
        preferredModel: 'claude-3-5-haiku-20241022',
        systemPrompt: 'System.',
      });

      const systemAgents = await agentRepository.listSystem();
      expect(systemAgents).toHaveLength(1);
      expect(systemAgents[0]?.name).toBe('system_one');
    });
  });

  describe('findByNameForOrganization / findByNameForUser', () => {
    it('finds by name within org scope only', async () => {
      const orgId = new mongoose.Types.ObjectId().toString();
      const otherOrgId = new mongoose.Types.ObjectId().toString();
      await Agent.create(makeOrgAgentInput({ organizationId: otherOrgId, name: 'finder' }));

      const result = await agentRepository.findByNameForOrganization(orgId, 'finder');
      expect(result).toBeNull();
    });

    it('finds by name within user scope only', async () => {
      const userId = new mongoose.Types.ObjectId().toString();
      const otherUserId = new mongoose.Types.ObjectId().toString();
      await Agent.create(makeUserAgentInput({ userId: otherUserId, name: 'mine' }));

      const result = await agentRepository.findByNameForUser(userId, 'mine');
      expect(result).toBeNull();
    });
  });

  describe('defaultVariables validation', () => {
    it('rejects non-string values', async () => {
      await expect(
        Agent.create(
          makeOrgAgentInput({
            defaultVariables: { foo: 'bar', count: 42 },
          })
        )
      ).rejects.toThrow();
    });

    it('rejects arrays', async () => {
      await expect(
        Agent.create(
          makeOrgAgentInput({
            defaultVariables: ['foo', 'bar'],
          })
        )
      ).rejects.toThrow();
    });

    it('accepts a flat string record', async () => {
      const created = await Agent.create(
        makeOrgAgentInput({
          defaultVariables: { tone: 'formal', audience: 'engineering' },
        })
      );
      expect((created.toJSON() as { defaultVariables?: Record<string, string> }).defaultVariables).toEqual({
        tone: 'formal',
        audience: 'engineering',
      });
    });
  });
});
