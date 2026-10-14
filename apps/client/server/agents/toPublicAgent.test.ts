import { describe, it, expect } from 'vitest';
import { AgentResourceSchema } from '@bike4mind/common';
import { toPublicAgent, type PublicAgentSource } from './toPublicAgent';

// Every internal field set, so a projection that spreads the document would leak at least one.
const DOC = {
  id: 'agent-1',
  name: 'Researcher',
  description: 'Finds sources',
  userId: 'owner',
  organizationId: 'org-1',
  isSystem: false,
  systemPrompt: 'secret prompt',
  preferredModel: 'gpt-4o',
  temperature: 0.4,
  maxTokens: 2048,
  allowedTools: ['web_search'],
  deniedTools: [],
  triggerWords: ['@research'],
  users: [{ userId: 'sharee', permissions: ['read'] }],
  groups: [{ groupId: 'g1', permissions: ['read'] }],
  isGlobalRead: false,
  isGlobalWrite: false,
  currentCredits: 500,
  useOwnCredits: true,
  projectId: 'project-1',
  capabilities: ['{}'],
  personality: { quirk: 'hums' },
  identity: { gender: 'other' },
  visual: { portraitUrl: 'https://example.com/p.png' },
  memoryJournal: [{ id: 'm1' }],
  worldMemory: [{ id: 'w1' }],
  heartbeatConfig: { enabled: true },
  pendingMessages: [{ id: 'pm1' }],
  tavernStats: { xp: 10 },
  maxIterations: { quick: 1, medium: 2, very_thorough: 3 },
  defaultThoroughness: 'quick',
  defaultVariables: { a: 1 },
  exclusiveMcpServers: ['mcp'],
  fallbackModels: ['gpt-4o-mini'],
  elevenLabsAgentId: 'el-1',
  deletedAt: null,
  createdAt: new Date('2026-01-01T00:00:00Z'),
  updatedAt: new Date('2026-01-02T00:00:00Z'),
} as unknown as PublicAgentSource;

describe('toPublicAgent', () => {
  it('publishes exactly the allowlisted fields to the owner', () => {
    const resource = toPublicAgent(DOC, 'owner');

    expect(resource).toEqual({
      id: 'agent-1',
      name: 'Researcher',
      description: 'Finds sources',
      system_prompt: 'secret prompt',
      preferred_model: 'gpt-4o',
      temperature: 0.4,
      max_tokens: 2048,
      allowed_tools: ['web_search'],
      denied_tools: [],
      trigger_words: ['@research'],
      is_owner: true,
      created_at: '2026-01-01T00:00:00.000Z',
      updated_at: '2026-01-02T00:00:00.000Z',
    });
    expect(AgentResourceSchema.strict().safeParse(resource).success).toBe(true);
  });

  it('withholds the system prompt from a sharee', () => {
    const resource = toPublicAgent(DOC, 'sharee');

    expect(resource.system_prompt).toBeNull();
    expect(resource.is_owner).toBe(false);
  });

  it('keeps unset optional fields null, distinct from an empty tool list', () => {
    const resource = toPublicAgent({ id: 'a', name: 'n', description: 'd', userId: 'owner' }, 'owner');

    expect(resource).toMatchObject({
      system_prompt: '',
      preferred_model: null,
      temperature: null,
      max_tokens: null,
      allowed_tools: null,
      denied_tools: null,
      trigger_words: [],
      created_at: null,
    });
  });
});
