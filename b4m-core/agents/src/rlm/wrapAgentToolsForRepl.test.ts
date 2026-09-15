import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { ICompletionOptionTools } from '@bike4mind/llm-adapters';
import { wrapAgentToolsForRepl } from './wrapAgentToolsForRepl';

function fakeTool(
  name: string,
  description: string,
  properties: Record<string, { type: string; description: string }>,
  toolFn: (params?: unknown) => Promise<string>
): ICompletionOptionTools {
  return {
    toolFn,
    toolSchema: {
      name,
      description,
      parameters: {
        type: 'object',
        properties,
      },
    },
  };
}

describe('wrapAgentToolsForRepl', () => {
  it('produces a ReplToolMap and matching descriptors for each input tool', () => {
    const tools: ICompletionOptionTools[] = [
      fakeTool(
        'searchKB',
        'Search the knowledge base. Returns matching files.',
        { query: { type: 'string', description: 'Search query' } },
        async () => '[]'
      ),
      fakeTool('listEntities', 'List entities visible in the world.', {}, async () => '[]'),
    ];
    const { replTools, descriptors } = wrapAgentToolsForRepl(tools);
    expect(Object.keys(replTools)).toEqual(['searchKB', 'listEntities']);
    expect(descriptors).toHaveLength(2);
    expect(descriptors[0].name).toBe('searchKB');
    expect(descriptors[0].signature).toBe('({ query })');
    expect(descriptors[1].signature).toBe('()');
  });

  it('parses JSON object responses so the agent gets a structured value', async () => {
    const tools = [
      fakeTool('getStuff', 'Get stuff.', { id: { type: 'string', description: 'id' } }, async () =>
        JSON.stringify({ ok: true, items: [1, 2, 3] })
      ),
    ];
    const { replTools } = wrapAgentToolsForRepl(tools);
    const result = await replTools.getStuff({ id: 'abc' });
    expect(result).toEqual({ ok: true, items: [1, 2, 3] });
  });

  it('keeps non-JSON responses (markdown, prose) as strings', async () => {
    const tools = [
      fakeTool(
        'summarize',
        'Summarize.',
        { text: { type: 'string', description: 'input' } },
        async () => '# Heading\n\nSome prose here.'
      ),
    ];
    const { replTools } = wrapAgentToolsForRepl(tools);
    const result = await replTools.summarize({ text: 'foo' });
    expect(typeof result).toBe('string');
    expect(result).toBe('# Heading\n\nSome prose here.');
  });

  it('parses JSON arrays and primitives that look JSON-shaped', async () => {
    const tools = [
      fakeTool('arr', 'arr', {}, async () => '[1, 2, 3]'),
      fakeTool('num', 'num', {}, async () => '42'),
      fakeTool('boolish', 'boolish', {}, async () => 'true'),
    ];
    const { replTools } = wrapAgentToolsForRepl(tools);
    expect(await replTools.arr()).toEqual([1, 2, 3]);
    expect(await replTools.num()).toBe(42);
    expect(await replTools.boolish()).toBe(true);
  });

  it('does NOT trip on prose that happens to start with curly braces', async () => {
    const tools = [fakeTool('tricky', 'tricky', {}, async () => '{not actually JSON, just curly}')];
    const { replTools } = wrapAgentToolsForRepl(tools);
    const result = await replTools.tricky();
    expect(typeof result).toBe('string');
    expect(result).toContain('not actually JSON');
  });

  it('honors the filter option to drop tools the caller does not want exposed', () => {
    const tools = [
      fakeTool('readKB', 'read', {}, async () => ''),
      fakeTool('writeFile', 'write', {}, async () => ''),
      fakeTool('deleteEntity', 'delete', {}, async () => ''),
    ];
    const { replTools, descriptors } = wrapAgentToolsForRepl(tools, {
      filter: t => t.toolSchema.name.startsWith('read'),
    });
    expect(Object.keys(replTools)).toEqual(['readKB']);
    expect(descriptors).toHaveLength(1);
  });

  it('honors the rename option for in-REPL identifier choice', () => {
    const tools = [
      fakeTool('search_knowledge_base', 'search', { q: { type: 'string', description: 'q' } }, async () => ''),
    ];
    const { replTools, descriptors } = wrapAgentToolsForRepl(tools, {
      rename: original => (original === 'search_knowledge_base' ? 'searchKB' : original),
    });
    expect(Object.keys(replTools)).toEqual(['searchKB']);
    expect(descriptors[0].name).toBe('searchKB');
  });

  describe('with console.warn spy', () => {
    let warnSpy: ReturnType<typeof vi.spyOn>;

    beforeEach(() => {
      warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    });
    afterEach(() => {
      warnSpy.mockRestore();
    });

    it('warns and skips tools whose name is not a valid JS identifier', () => {
      const tools = [
        fakeTool('valid_name', 'ok', {}, async () => ''),
        fakeTool('not.an.identifier', 'bad', {}, async () => ''),
        fakeTool('123starts-with-digit', 'bad', {}, async () => ''),
      ];
      const { replTools, descriptors } = wrapAgentToolsForRepl(tools);
      expect(Object.keys(replTools)).toEqual(['valid_name']);
      expect(descriptors).toHaveLength(1);
      expect(warnSpy).toHaveBeenCalledTimes(2);
      expect(warnSpy.mock.calls[0][0]).toContain('not.an.identifier');
      expect(warnSpy.mock.calls[1][0]).toContain('123starts-with-digit');
    });

    it('warns and skips on duplicate in-REPL names (rename collision)', () => {
      const tools = [
        fakeTool('searchA', 'first', {}, async () => 'first'),
        fakeTool('searchB', 'second', {}, async () => 'second'),
      ];
      const { replTools, descriptors } = wrapAgentToolsForRepl(tools, {
        rename: () => 'search', // both tools collide on the same name
      });
      expect(Object.keys(replTools)).toEqual(['search']);
      expect(descriptors).toHaveLength(1);
      expect(warnSpy).toHaveBeenCalledTimes(1);
      expect(warnSpy.mock.calls[0][0]).toContain('duplicate in-REPL name');
      expect(warnSpy.mock.calls[0][0]).toContain('searchB');
    });
  });

  it('shortens descriptions to first sentence for the in-REPL listing', () => {
    const tools = [
      fakeTool(
        'fooTool',
        'Search the knowledge base. Returns matching files. Supports fuzzy matching and tag filters across all data lakes.',
        {},
        async () => ''
      ),
    ];
    const { descriptors } = wrapAgentToolsForRepl(tools);
    expect(descriptors[0].description).toBe('Search the knowledge base.');
  });
});
