import { describe, expect, it } from 'vitest';
import { buildCoreSystemPrompt, buildMinimalSystemPrompt, buildDeferredToolDirectory } from './prompts.js';

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

describe('buildCoreSystemPrompt with deferredToolNames', () => {
  it('omits the directory section when no deferred tools are passed', () => {
    const prompt = buildCoreSystemPrompt({});
    expect(prompt).not.toContain('Deferred tool schemas');
  });

  it('includes the directory when names are passed', () => {
    const prompt = buildCoreSystemPrompt({
      deferredToolNames: ['mcp__github__create_pull_request'],
    });
    expect(prompt).toContain('Deferred tool schemas');
    expect(prompt).toContain('mcp__github__create_pull_request');
  });
});

describe('buildMinimalSystemPrompt with deferredToolNames', () => {
  it('includes the directory when names are passed', () => {
    const prompt = buildMinimalSystemPrompt({
      deferredToolNames: ['mcp__github__list_issues'],
    });
    expect(prompt).toContain('Deferred tool schemas');
    expect(prompt).toContain('mcp__github__list_issues');
  });
});
