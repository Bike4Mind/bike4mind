import { describe, expect, it, vi } from 'vitest';
import { DeferredToolRegistry } from '@bike4mind/agents';
import type { ICompletionBackend, ICompletionOptionTools } from '@bike4mind/llm-adapters';
import { ToolSearchLlmBackend } from '../llm/ToolSearchLlmBackend';
import { buildToolSearch } from './buildToolSearch';

const llm: ICompletionBackend = {
  currentModel: 'm',
  complete: vi.fn(),
  pushToolMessages: vi.fn(),
  getModelInfo: vi.fn(),
};

const makeTool = (name: string): ICompletionOptionTools => ({
  toolSchema: { name, description: '', parameters: { type: 'object', properties: {} } },
  toolFn: async () => '',
});

describe('buildToolSearch', () => {
  it('leaves the backend unwrapped and offers no tool_search without deferred tools', () => {
    const result = buildToolSearch({
      llm,
      models: [],
      registry: new DeferredToolRegistry(),
      agentToolsRef: { current: null },
    });
    expect(result).toEqual({ llm, toolSearchTool: null });
  });

  it('wraps the backend and builds tool_search over the registry', async () => {
    const registry = new DeferredToolRegistry();
    registry.register([makeTool('mcp__a')]);
    const agentToolsRef: { current: ICompletionOptionTools[] | null } = { current: null };

    const { llm: wrapped, toolSearchTool } = buildToolSearch({ llm, models: [], registry, agentToolsRef });

    expect(wrapped).toBeInstanceOf(ToolSearchLlmBackend);
    expect(toolSearchTool?.toolSchema.name).toBe('tool_search');
    await expect(toolSearchTool!.toolFn({ query: 'select:mcp__a' })).rejects.toThrow(/before agent context/);

    agentToolsRef.current = [];
    await toolSearchTool!.toolFn({ query: 'select:mcp__a' });
    expect(agentToolsRef.current.map(t => t.toolSchema.name)).toEqual(['mcp__a']);
  });
});
