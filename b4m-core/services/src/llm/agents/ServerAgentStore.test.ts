import { describe, it, expect } from 'vitest';
import type { ServerAgentDefinition } from '@bike4mind/agents';
import { ServerAgentStore } from './ServerAgentStore';

function makeCustomAgent(overrides: Partial<ServerAgentDefinition> = {}): ServerAgentDefinition {
  return {
    name: 'custom_agent',
    description: 'A custom org-scoped agent',
    model: 'claude-3-5-haiku-20241022',
    systemPrompt: 'You are a custom agent. Task: $TASK',
    maxIterations: { quick: 3, medium: 6, very_thorough: 12 },
    defaultThoroughness: 'medium',
    ...overrides,
  };
}

describe('ServerAgentStore', () => {
  describe('built-ins-only construction', () => {
    it('returns the built-in factory agents when no custom agents are passed', () => {
      const store = new ServerAgentStore({});
      const names = store.getAgentNames();

      // Built-ins are stable: analyst, code_review, github_manager, project_manager, researcher.
      expect(names).toContain('analyst');
      expect(names).toContain('code_review');
      expect(names).toContain('github_manager');
      expect(names).toContain('project_manager');
      expect(names).toContain('researcher');
    });
  });

  describe('custom agents overlay', () => {
    it('adds a custom agent on top of built-ins', () => {
      const builtInsOnly = new ServerAgentStore({});
      const builtInCount = builtInsOnly.getAllAgents().length;

      const store = new ServerAgentStore({}, { orgAgents: [makeCustomAgent({ name: 'compliance_reviewer' })] });

      expect(store.hasAgent('compliance_reviewer')).toBe(true);
      expect(store.getAllAgents()).toHaveLength(builtInCount + 1);
    });

    it('overrides a built-in when a custom agent uses the same name', () => {
      const customCodeReview = makeCustomAgent({
        name: 'code_review',
        description: 'Org-flavored code review (overrides built-in)',
        systemPrompt: 'CUSTOM PROMPT — $TASK',
      });

      const store = new ServerAgentStore({}, { orgAgents: [customCodeReview] });

      const resolved = store.getAgent('code_review');
      expect(resolved).toBeDefined();
      expect(resolved?.description).toBe('Org-flavored code review (overrides built-in)');
      expect(resolved?.systemPrompt).toBe('CUSTOM PROMPT — $TASK');

      // Total count is unchanged because the override replaces the built-in.
      const builtInsOnly = new ServerAgentStore({});
      expect(store.getAllAgents()).toHaveLength(builtInsOnly.getAllAgents().length);
    });

    it('preserves other built-ins when one is overridden', () => {
      const customCodeReview = makeCustomAgent({ name: 'code_review' });
      const store = new ServerAgentStore({}, { orgAgents: [customCodeReview] });

      // The non-overridden built-ins stay intact.
      expect(store.hasAgent('analyst')).toBe(true);
      expect(store.hasAgent('researcher')).toBe(true);
      expect(store.hasAgent('github_manager')).toBe(true);
    });
  });

  describe('scope precedence (org > user > built-in)', () => {
    it('org-scoped agent overrides a user-scoped agent of the same name', () => {
      const userResearcher = makeCustomAgent({
        name: 'researcher',
        description: 'User personal researcher',
        systemPrompt: 'USER PROMPT',
      });
      const orgResearcher = makeCustomAgent({
        name: 'researcher',
        description: 'Org canonical researcher',
        systemPrompt: 'ORG PROMPT',
      });

      const store = new ServerAgentStore({}, { userAgents: [userResearcher], orgAgents: [orgResearcher] });

      const resolved = store.getAgent('researcher');
      expect(resolved?.description).toBe('Org canonical researcher');
      expect(resolved?.systemPrompt).toBe('ORG PROMPT');
    });

    it('user-scoped agent overrides a built-in of the same name', () => {
      const userCodeReview = makeCustomAgent({
        name: 'code_review',
        description: 'Personal code review override',
        systemPrompt: 'USER PROMPT',
      });

      const store = new ServerAgentStore({}, { userAgents: [userCodeReview] });

      const resolved = store.getAgent('code_review');
      expect(resolved?.description).toBe('Personal code review override');
    });
  });

  describe('getExclusiveMcpServers', () => {
    it('returns the built-in agents exclusive MCP servers (includes atlassian from project_manager)', () => {
      // agent_executor relies on this value to withhold atlassian from the parent LLM while routing
      // it to the delegated project_manager subagent. If it stops returning atlassian, the fix breaks.
      const store = new ServerAgentStore({});
      expect(store.getExclusiveMcpServers()).toContain('atlassian');
    });

    it('dedups a server claimed by more than one agent', () => {
      const extra = makeCustomAgent({ name: 'second_atlassian_agent', exclusiveMcpServers: ['atlassian'] });
      const store = new ServerAgentStore({}, { orgAgents: [extra] });
      expect(store.getExclusiveMcpServers().filter(s => s === 'atlassian')).toHaveLength(1);
    });
  });

  describe('getFilteredStore', () => {
    it('returns a store containing only the named agents (custom + built-in)', () => {
      const store = new ServerAgentStore({}, { orgAgents: [makeCustomAgent({ name: 'compliance_reviewer' })] });
      const filtered = store.getFilteredStore(['compliance_reviewer', 'code_review']);

      expect(filtered.getAgentNames().sort()).toEqual(['code_review', 'compliance_reviewer']);
    });
  });
});
