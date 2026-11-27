import { describe, expect, it, vi } from 'vitest';
import type { ToolContext } from '@bike4mind/services/llm/tools';
import { searchGuideTool } from './searchGuide';

const context = {
  user: { isAdmin: true },
  userId: 'admin-1',
  logger: { error: vi.fn(), info: vi.fn(), warn: vi.fn(), debug: vi.fn() },
} as unknown as Omit<ToolContext, 'config'>;

const runTool = async (args: unknown) =>
  JSON.parse(await searchGuideTool.implementation(context, undefined).toolFn(args));

describe('searchGuideTool', () => {
  it('returns the matching entries with where to go and how to use them', async () => {
    const result = await runTool({ query: 'AI advisories' });
    expect(result.ok).toBe(true);
    expect(result.data.entries.length).toBeGreaterThan(0);
    expect(result.data.entries.length).toBeLessThanOrEqual(3);
    expect(Object.keys(result.data.entries[0]).sort()).toEqual(
      ['howTo', 'id', 'settings', 'summary', 'title', 'views'].sort()
    );
    expect(result.data.note).toBeUndefined();
  });

  it('says the guide has no answer instead of returning a near miss', async () => {
    const result = await runTool({ query: 'Lighthouse Rewards' });
    expect(result.data.entries).toEqual([]);
    expect(result.data.note).toMatch(/No guide entry matched/);
  });

  it('rejects an empty query', async () => {
    const result = await runTool({ query: '   ' });
    expect(result).toMatchObject({ ok: false, error: 'invalid_input' });
  });
});
