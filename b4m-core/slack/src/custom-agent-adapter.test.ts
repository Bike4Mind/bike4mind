/**
 * Tests for the Custom Agent Adapter
 */

import { describe, it, expect } from 'vitest';
import { customAgentToPersona } from './custom-agent-adapter';
import type { IAgentDocument } from '@bike4mind/common';

// Helper to create a minimal mock agent
function createMockAgent(overrides: Partial<IAgentDocument> = {}): IAgentDocument {
  return {
    id: 'test-agent-id',
    name: 'Test Agent',
    description: 'A test agent for unit tests',
    userId: 'user-123',
    projectId: 'project-123',
    triggerWords: ['@test'],
    isPublic: false,
    useOwnCredits: false,
    createdAt: new Date(),
    updatedAt: new Date(),
    personality: {
      majorMotivation: '',
      minorMotivation: '',
      flaw: '',
      quirk: '',
      description: '',
    },
    ...overrides,
  } as IAgentDocument;
}

describe('Custom Agent Adapter', () => {
  describe('customAgentToPersona', () => {
    it('should convert agent with systemPrompt to persona', () => {
      const agent = createMockAgent({
        name: 'Custom Helper',
        description: 'Helps with custom tasks',
        systemPrompt: 'You are a specialized helper.',
        capabilities: ['code', 'analysis'],
      });

      const persona = customAgentToPersona(agent);

      expect(persona.name).toBe('Custom Helper');
      expect(persona.description).toBe('Helps with custom tasks');
      expect(persona.systemPrompt).toBe('You are a specialized helper.');
      expect(persona.capabilities).toEqual(['code', 'analysis']);
    });

    it('should use default capabilities when not specified', () => {
      const agent = createMockAgent({
        systemPrompt: 'You are helpful.',
      });

      const persona = customAgentToPersona(agent);

      expect(persona.capabilities).toEqual(['all']);
    });

    it('should build systemPrompt from personality when not provided', () => {
      const agent = createMockAgent({
        systemPrompt: undefined,
        personality: {
          majorMotivation: 'Helping users succeed',
          minorMotivation: 'Learning new things',
          flaw: '',
          quirk: 'Uses metaphors frequently',
          description: 'A friendly and knowledgeable assistant',
          communicationPattern: 'Clear and concise',
          problemSolvingApproach: 'Breaks down complex problems step by step',
        },
      });

      const persona = customAgentToPersona(agent);

      expect(persona.systemPrompt).toContain('A friendly and knowledgeable assistant');
      expect(persona.systemPrompt).toContain('Helping users succeed');
      expect(persona.systemPrompt).toContain('Learning new things');
      expect(persona.systemPrompt).toContain('Uses metaphors frequently');
      expect(persona.systemPrompt).toContain('Clear and concise');
      expect(persona.systemPrompt).toContain('Breaks down complex problems step by step');
    });

    it('should return default prompt when no systemPrompt or personality', () => {
      const agent = createMockAgent({
        systemPrompt: undefined,
        personality: undefined,
      });

      const persona = customAgentToPersona(agent);

      expect(persona.systemPrompt).toBe('You are a helpful AI assistant.');
    });

    it('should return default prompt when personality has no fields set', () => {
      const agent = createMockAgent({
        systemPrompt: undefined,
        personality: {
          majorMotivation: '',
          minorMotivation: '',
          flaw: '',
          quirk: '',
          description: '',
        },
      });

      const persona = customAgentToPersona(agent);

      expect(persona.systemPrompt).toBe('You are a helpful AI assistant.');
    });

    it('should include personalMission and coreValues in systemPrompt', () => {
      const agent = createMockAgent({
        systemPrompt: undefined,
        personality: {
          majorMotivation: '',
          minorMotivation: '',
          flaw: '',
          quirk: '',
          description: '',
          personalMission: 'To empower developers',
          coreValues: 'Integrity, Excellence, Innovation',
        },
      });

      const persona = customAgentToPersona(agent);

      expect(persona.systemPrompt).toContain('To empower developers');
      expect(persona.systemPrompt).toContain('Integrity, Excellence, Innovation');
    });

    it('should preserve agent name and description exactly', () => {
      const agent = createMockAgent({
        name: 'My Special Agent with Spaces',
        description: 'Description with special chars: @#$%',
      });

      const persona = customAgentToPersona(agent);

      expect(persona.name).toBe('My Special Agent with Spaces');
      expect(persona.description).toBe('Description with special chars: @#$%');
    });
  });
});
