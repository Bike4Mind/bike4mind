import { describe, it, expect } from 'vitest';
import type { ICompletionOptionTools } from '@bike4mind/llm-adapters';
import { filterOptInTools, selectSubagentTools, filterToolsByPatterns } from './toolFilter';

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
