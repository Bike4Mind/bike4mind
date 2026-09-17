import { describe, it, expect } from 'vitest';
import type { ICompletionOptionTools } from '@bike4mind/llm-adapters';
import { filterOptInTools, selectSubagentTools, filterToolsByPatterns, matchesToolPattern } from './toolFilter';

/** Minimal tool stub — only `toolSchema.name` is read by the filters. */
function tool(name: string): ICompletionOptionTools {
  return { toolSchema: { name } } as unknown as ICompletionOptionTools;
}

const names = (tools: ICompletionOptionTools[]): string[] => tools.map(t => t.toolSchema.name);

describe('filterOptInTools', () => {
  const pool = [tool('lattice_create_model'), tool('lattice_query'), tool('web_search')];

  it('grants NOTHING when no allowed patterns are given (explicit opt-in required)', () => {
    // The load-bearing inverse of filterToolsByPatterns: an unrestricted agent
    // (no allowedTools) must NOT be handed opt-in tools by the allow-all default.
    expect(filterOptInTools(pool, undefined)).toEqual([]);
    expect(filterOptInTools(pool, [])).toEqual([]);
  });

  it('grants only the tools an explicit pattern matches', () => {
    expect(names(filterOptInTools(pool, ['lattice_create_model']))).toEqual(['lattice_create_model']);
  });

  it('supports wildcard opt-in', () => {
    expect(names(filterOptInTools(pool, ['lattice_*']))).toEqual(['lattice_create_model', 'lattice_query']);
  });

  it('treats an explicit "*" as opting into everything in the pool', () => {
    expect(names(filterOptInTools(pool, ['*']))).toEqual(['lattice_create_model', 'lattice_query', 'web_search']);
  });

  it('lets deny patterns override an allow match', () => {
    expect(names(filterOptInTools(pool, ['lattice_*'], ['lattice_query']))).toEqual(['lattice_create_model']);
  });
});

describe('selectSubagentTools', () => {
  const parentTools = [tool('web_search'), tool('read_file')];
  const optInTools = [tool('lattice_create_model'), tool('lattice_query')];

  it('returns allowed parent tools plus explicitly opted-in tools', () => {
    const result = selectSubagentTools(parentTools, optInTools, ['web_search', 'lattice_*']);
    expect(names(result)).toEqual(['web_search', 'lattice_create_model', 'lattice_query']);
  });

  it('never grants opt-in tools under the allow-all default (no allowedTools)', () => {
    // Parent tools still flow through (allow-all), but opt-in tools do not.
    const result = selectSubagentTools(parentTools, optInTools, undefined);
    expect(names(result)).toEqual(['web_search', 'read_file']);
  });

  it('respects deny patterns on both parent and opt-in tools', () => {
    const result = selectSubagentTools(parentTools, optInTools, ['*'], ['read_file', 'lattice_query']);
    expect(names(result)).toEqual(['web_search', 'lattice_create_model']);
  });

  it('dedupes an opt-in tool already present in the (allowed) parent set', () => {
    // Simulates a parent run that already had the opt-in capability enabled, so
    // the tool is in parentTools too. It must appear exactly once.
    const parentWithLattice = [...parentTools, tool('lattice_query')];
    const result = selectSubagentTools(parentWithLattice, optInTools, ['*']);
    expect(names(result).filter(n => n === 'lattice_query')).toHaveLength(1);
    // The parent-set instance wins its position; the opt-in duplicate is dropped.
    expect(names(result)).toEqual(['web_search', 'read_file', 'lattice_query', 'lattice_create_model']);
  });

  it('matches filterToolsByPatterns for the parent portion when the opt-in pool is empty', () => {
    const viaSelect = selectSubagentTools(parentTools, [], ['web_search']);
    const viaFilter = filterToolsByPatterns(parentTools, ['web_search']);
    expect(names(viaSelect)).toEqual(names(viaFilter));
  });
});

describe('matchesToolPattern', () => {
  it('treats every character but * as a literal', () => {
    // A regex-based matcher escapes `.` into `\.` and would answer the first pair the same
    // way, but `[ab]` into a character class - flipping the second pair in both directions.
    expect(matchesToolPattern('mcp__github__create_issue', 'mcp__*__create_*')).toBe(true);
    expect(matchesToolPattern('a.b', 'a.b')).toBe(true);
    expect(matchesToolPattern('axb', 'a.b')).toBe(false);
    expect(matchesToolPattern('x[ab]', '*[ab]')).toBe(true);
    expect(matchesToolPattern('xa', '*[ab]')).toBe(false);
  });

  it('resolves a chained-* pattern without catastrophic backtracking', () => {
    // allowedTools/deniedTools reach this unvalidated off req.body, and every subagent
    // dispatch evaluates each pattern - so a hostile one used to pin the event loop.
    const start = Date.now();
    expect(matchesToolPattern('a'.repeat(40), '*a'.repeat(20) + 'Z')).toBe(false);
    expect(Date.now() - start).toBeLessThan(1000);
  });
});
