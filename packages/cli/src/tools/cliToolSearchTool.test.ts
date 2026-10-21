import { describe, expect, it } from 'vitest';
import { DeferredToolRegistry, createToolSearchTool } from '@bike4mind/agents';
import type { ICompletionOptionTools } from '@bike4mind/llm-adapters';
import { createCliToolSearchTool, parseToolReferences } from './cliToolSearchTool';

const makeTool = (name: string, description = ''): ICompletionOptionTools => ({
  toolSchema: { name, description, parameters: { type: 'object', properties: {} } },
  toolFn: async () => `${name} ran`,
});

function setup(useToolReference: () => boolean) {
  const registry = new DeferredToolRegistry();
  registry.register([
    makeTool('github__create_issue', 'Create a GitHub issue'),
    makeTool('github__list_pulls', 'List pull requests'),
    makeTool('slack__post', 'Post a Slack message'),
  ]);
  const liveTools: ICompletionOptionTools[] = [makeTool('read_file')];
  const tool = createCliToolSearchTool({ registry, toolListAccessor: () => liveTools, useToolReference });
  return { registry, liveTools, tool };
}

const names = (tools: ICompletionOptionTools[]) => tools.map(t => t.toolSchema.name);

describe('parseToolReferences', () => {
  it('reads a serialized toolReference result', () => {
    expect(parseToolReferences('[{"type":"tool_reference","tool_name":"a"}]')).toEqual([
      { type: 'tool_reference', tool_name: 'a' },
    ]);
  });

  it('drops a field the core serializer may add later', () => {
    expect(parseToolReferences('[{"type":"tool_reference","tool_name":"a","extra":1}]')).toEqual([
      { type: 'tool_reference', tool_name: 'a' },
    ]);
  });

  it.each([
    ['plain text', 'tool_search: no deferred tools matched query "x".'],
    ['an empty array', '[]'],
    ['a non-array', '{"type":"tool_reference","tool_name":"a"}'],
    ['another block type', '[{"type":"text","text":"a"}]'],
    ['a non-string name', '[{"type":"tool_reference","tool_name":1}]'],
    ['a trailing warning', '[{"type":"tool_reference","tool_name":"a"}]\n\nWarning: repeated call'],
  ])('is null for %s', (_label, text) => {
    expect(parseToolReferences(text)).toBeNull();
  });
});

describe('createCliToolSearchTool', () => {
  it('keeps the shared tool_search schema', () => {
    const { registry, tool } = setup(() => true);
    const shared = createToolSearchTool({ registry, toolListAccessor: () => [] });
    expect(tool.toolSchema).toEqual(shared.toolSchema);
  });

  it('runs mutateTools unchanged when the model has no native tool search', async () => {
    const { registry, liveTools, tool } = setup(() => false);
    const reference: ICompletionOptionTools[] = [makeTool('read_file')];
    const shared = createToolSearchTool({ registry, toolListAccessor: () => reference });

    const result = await tool.toolFn({ query: 'github' });

    expect(result).toBe(await shared.toolFn({ query: 'github' }));
    expect(result).toContain('<functions>');
    expect(names(liveTools)).toEqual(names(reference));
  });

  it('returns tool_reference blocks and makes the matches executable on a native model', async () => {
    const { liveTools, tool } = setup(() => true);

    const result = await tool.toolFn({ query: 'select:github__create_issue,slack__post' });

    expect(JSON.parse(result)).toEqual([
      { type: 'tool_reference', tool_name: 'github__create_issue' },
      { type: 'tool_reference', tool_name: 'slack__post' },
    ]);
    expect(names(liveTools)).toEqual(['read_file', 'github__create_issue', 'slack__post']);
  });

  it('ranks keyword searches identically under both strategies', async () => {
    const native = setup(() => true);
    const plain = setup(() => false);

    await native.tool.toolFn({ query: 'github pull', max_results: 2 });
    await plain.tool.toolFn({ query: 'github pull', max_results: 2 });

    expect(names(native.liveTools)).toEqual(names(plain.liveTools));
  });

  it('does not add a tool twice on a repeated search', async () => {
    const { liveTools, tool } = setup(() => true);
    await tool.toolFn({ query: 'select:slack__post' });
    await tool.toolFn({ query: 'select:slack__post' });
    expect(names(liveTools)).toEqual(['read_file', 'slack__post']);
  });

  it('does not add a tool twice when one query names it twice', async () => {
    const { liveTools, tool } = setup(() => true);
    await tool.toolFn({ query: 'select:slack__post,slack__post' });
    expect(names(liveTools)).toEqual(['read_file', 'slack__post']);
  });

  it('rejects before the agent tools are wired, without touching the live list', async () => {
    const { registry } = setup(() => true);
    const tool = createCliToolSearchTool({
      registry,
      toolListAccessor: () => {
        throw new Error('tool_search invoked before agent context was wired');
      },
      useToolReference: () => true,
    });

    await expect(tool.toolFn({ query: 'select:slack__post' })).rejects.toThrow(/before agent context was wired/);
  });

  it('passes a no-match hint through and leaves the live list alone', async () => {
    const { liveTools, tool } = setup(() => true);
    expect(await tool.toolFn({ query: 'select:nope' })).toMatch(/no deferred tools matched nope/);
    expect(names(liveTools)).toEqual(['read_file']);
  });

  it('picks the strategy per call, following a model switch', async () => {
    let native = true;
    const { tool } = setup(() => native);
    expect(parseToolReferences(await tool.toolFn({ query: 'select:slack__post' }))).not.toBeNull();
    native = false;
    expect(await tool.toolFn({ query: 'select:github__list_pulls' })).toContain('Loaded 1 new tool schema(s)');
  });
});
