import { describe, it, expect } from 'vitest';
import type { IAgent } from '@bike4mind/common';
import { hydrateEmbedAgent } from './embedAgentHydration';

const agent = {
  name: 'Aria',
  systemPrompt: 'You are Aria, a helpful onboarding guide.',
  preferredModel: 'claude-test',
  temperature: 0.7,
  maxTokens: 512,
  allowedTools: ['search_knowledge_base'],
  deniedTools: ['delete_file'],
  projectId: 'proj-9',
} as unknown as IAgent;

describe('hydrateEmbedAgent', () => {
  it('projects the agent config and builds the persona from the stored prompt', () => {
    const h = hydrateEmbedAgent(agent);
    expect(h.model).toBe('claude-test');
    expect(h.temperature).toBe(0.7);
    expect(h.maxTokens).toBe(512);
    expect(h.allowedTools).toEqual(['search_knowledge_base']);
    expect(h.deniedTools).toEqual(['delete_file']);
    expect(h.projectId).toBe('proj-9');
    expect(h.systemPrompt).toContain('You are Aria');
  });

  it('defaults the tool lists to empty and leaves model blank when unset', () => {
    const h = hydrateEmbedAgent({ name: 'Bare', personality: {} } as unknown as IAgent);
    expect(h.model).toBe('');
    expect(h.allowedTools).toEqual([]);
    expect(h.deniedTools).toEqual([]);
    expect(h.projectId).toBeUndefined();
  });

  it('treats an empty-string preferredModel (System Default in the UI) the same as unset', () => {
    const h = hydrateEmbedAgent({ name: 'Bare', personality: {}, preferredModel: '' } as unknown as IAgent);
    expect(h.model).toBe('');
  });
});
