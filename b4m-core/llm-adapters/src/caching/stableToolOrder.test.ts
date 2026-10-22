import { describe, expect, it } from 'vitest';
import type { ICompletionOptionTools } from '../backend';
import { sortToolsForStableCacheKey } from './stableToolOrder';

const tool = (name: string): ICompletionOptionTools => ({
  toolSchema: { name, description: name, parameters: { type: 'object', properties: {} } },
  toolFn: async () => 'ok',
});
const names = (tools: ICompletionOptionTools[]) => tools.map(t => t.toolSchema.name);

describe('sortToolsForStableCacheKey', () => {
  it('orders the same tool set identically whatever order the caller assembled it in', () => {
    const saved = [tool('web_search'), tool('current_datetime'), tool('navigate_view')];
    const reordered = [tool('navigate_view'), tool('web_search'), tool('current_datetime')];

    expect(names(sortToolsForStableCacheKey(saved))).toEqual(names(sortToolsForStableCacheKey(reordered)));
  });

  it('compares by code unit, so uppercase MCP prefixes sort the same on every host locale', () => {
    expect(names(sortToolsForStableCacheKey([tool('b'), tool('Z'), tool('a')]))).toEqual(['Z', 'a', 'b']);
  });

  it('leaves the input array untouched', () => {
    const input = [tool('b'), tool('a')];
    sortToolsForStableCacheKey(input);
    expect(names(input)).toEqual(['b', 'a']);
  });
});
