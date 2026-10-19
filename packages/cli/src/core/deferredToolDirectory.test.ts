import { describe, expect, it } from 'vitest';
import { buildCoreSystemPrompt, buildMinimalSystemPrompt } from './prompts.js';

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
