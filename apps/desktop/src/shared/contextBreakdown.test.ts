import { describe, expect, it } from 'vitest';
import { contextBreakdown, estimateContextOverhead, type ContextSnapshot } from './contextBreakdown';

const snapshot: ContextSnapshot = {
  model: 'model',
  inputTokens: 100,
  overhead: [
    { id: 'system', tokens: 30 },
    { id: 'mcp-tools', tokens: 20, items: ['search'] },
  ],
};

describe('context breakdown', () => {
  it.each([0, 10, 50, 100, 900, 950, 1000, 1100])('keeps every segment consistent at %i tokens', tokens => {
    const result = contextBreakdown(tokens, 1000, snapshot);
    const injected = result.slices.reduce((sum, slice) => sum + slice.tokens, 0);
    expect(injected).toBe(tokens);
    expect(injected + result.reserve + result.free).toBe(Math.max(tokens, 1000));
    expect(result.slices.every(slice => slice.tokens >= 0)).toBe(true);
    expect(result.reserve).toBeLessThanOrEqual(100);
  });

  it('does not invent capacity or attribution', () => {
    expect(contextBreakdown(100, null)).toEqual({
      slices: [{ id: 'messages', tokens: 100 }],
      used: 100,
      capacity: null,
      free: 0,
      reserve: 0,
    });
  });

  it('subtracts injected project/skills text exactly once from system instructions', () => {
    const overhead = estimateContextOverhead({
      system: 'base\nproject\nskills',
      project: 'project',
      skills: 'skills',
      tools: [
        { name: 'read', schema: { name: 'read' }, mcp: false },
        { name: 'search', schema: { name: 'search' }, mcp: true },
      ],
    });
    expect(overhead.find(slice => slice.id === 'system')?.tokens).toBe(2);
    expect(overhead.find(slice => slice.id === 'mcp-tools')?.items).toEqual(['search']);
    expect(overhead.find(slice => slice.id === 'system-tools')?.items).toEqual(['read']);
  });

  it('does not count unavailable or non-injected sections', () => {
    const overhead = estimateContextOverhead({ system: 'base', project: 'missing', skills: '', tools: [] });
    expect(overhead).toEqual([{ id: 'system', tokens: 1 }]);
  });
});
