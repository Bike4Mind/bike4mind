import { describe, expect, it } from 'vitest';
import { buildDeferredToolDirectory } from './buildDeferredToolDirectory';

describe('buildDeferredToolDirectory', () => {
  it('returns empty string when no deferred tools', () => {
    expect(buildDeferredToolDirectory([])).toBe('');
  });

  it('renders sorted names and tool_search instructions', () => {
    const out = buildDeferredToolDirectory(['mcp__b', 'mcp__a', 'mcp__c']);
    expect(out).toContain('mcp__a');
    expect(out).toContain('mcp__b');
    expect(out).toContain('mcp__c');
    expect(out).toContain('tool_search');
    expect(out).toContain('select:');
    // Sorted: a should come before b should come before c
    expect(out.indexOf('mcp__a')).toBeLessThan(out.indexOf('mcp__b'));
    expect(out.indexOf('mcp__b')).toBeLessThan(out.indexOf('mcp__c'));
  });
});
