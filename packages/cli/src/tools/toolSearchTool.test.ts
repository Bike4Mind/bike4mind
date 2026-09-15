import { beforeEach, describe, expect, it } from 'vitest';
import type { ICompletionOptionTools } from '@bike4mind/llm-adapters';
import { deferredToolRegistry } from './deferredToolRegistry.js';
import { createToolSearchTool } from './toolSearchTool.js';

const makeTool = (name: string, description = ''): ICompletionOptionTools => ({
  toolSchema: {
    name,
    description,
    parameters: { type: 'object', properties: {} },
  },
  toolFn: async () => 'noop',
});

const run = async (
  search: ICompletionOptionTools,
  params: { query: string; max_results?: number }
): Promise<string> => {
  const result = await search.toolFn(params);
  return typeof result === 'string' ? result : JSON.stringify(result);
};

describe('toolSearchTool', () => {
  let liveTools: ICompletionOptionTools[];

  beforeEach(() => {
    deferredToolRegistry.clear();
    liveTools = [];
  });

  it('returns error for empty query', async () => {
    const search = createToolSearchTool(() => liveTools);
    expect(await run(search, { query: '' })).toMatch(/non-empty/);
  });

  it('whitespace-only query falls through to no-match (Zod min(1) only checks length)', async () => {
    const search = createToolSearchTool(() => liveTools);
    expect(await run(search, { query: '   ' })).toMatch(/no deferred tools matched/i);
  });

  it('returns error for invalid max_results (negative)', async () => {
    const search = createToolSearchTool(() => liveTools);
    const result = await run(search, { query: 'foo', max_results: -1 });
    expect(result).toMatch(/invalid parameters/i);
  });

  it('coerces string max_results to number', async () => {
    deferredToolRegistry.register([makeTool('foo', 'desc')]);
    const search = createToolSearchTool(() => liveTools);
    // LLMs occasionally emit numeric-looking strings; verify coercion.
    const result = await search.toolFn({ query: 'foo', max_results: '1' });
    expect(typeof result === 'string' ? result : '').toContain('Loaded 1 new tool schema(s)');
  });

  it('select: form loads exact tools into the live tools array', async () => {
    deferredToolRegistry.register([makeTool('alpha'), makeTool('beta'), makeTool('gamma')]);
    const search = createToolSearchTool(() => liveTools);

    const out = await run(search, { query: 'select:alpha,gamma' });
    expect(liveTools.map(t => t.toolSchema.name).sort()).toEqual(['alpha', 'gamma']);
    expect(out).toContain('Loaded 2 new tool schema(s)');
    expect(out).toContain('<function>');
  });

  it('select: form reports unmatched names', async () => {
    deferredToolRegistry.register([makeTool('alpha')]);
    const search = createToolSearchTool(() => liveTools);
    const out = await run(search, { query: 'select:alpha,bogus' });
    expect(out).toContain('Not found: bogus');
    expect(liveTools.map(t => t.toolSchema.name)).toEqual(['alpha']);
  });

  it('select: form is idempotent — loading a tool twice does not duplicate it', async () => {
    deferredToolRegistry.register([makeTool('alpha')]);
    const search = createToolSearchTool(() => liveTools);
    await run(search, { query: 'select:alpha' });
    const out = await run(search, { query: 'select:alpha' });
    expect(liveTools.length).toBe(1);
    expect(out).toContain('Loaded 0 new tool schema(s)');
    expect(out).toContain('1 already loaded');
  });

  it('free-text form returns ranked matches and respects max_results', async () => {
    deferredToolRegistry.register([
      makeTool('mcp__github__create_pull_request', 'opens a PR'),
      makeTool('mcp__github__list_issues', 'lists issues'),
      makeTool('mcp__github__merge_pull_request', 'merges a PR'),
    ]);
    const search = createToolSearchTool(() => liveTools);
    const out = await run(search, { query: 'pull request', max_results: 2 });
    expect(liveTools.length).toBe(2);
    expect(out).toContain('mcp__github__create_pull_request');
  });

  it('returns hint string when no results match', async () => {
    deferredToolRegistry.register([makeTool('foo')]);
    const search = createToolSearchTool(() => liveTools);
    expect(await run(search, { query: 'nothing matches' })).toMatch(/no deferred tools matched/i);
    expect(await run(search, { query: 'select:none' })).toMatch(/no deferred tools matched/i);
    expect(liveTools).toEqual([]);
  });
});
