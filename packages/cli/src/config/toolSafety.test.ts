import { describe, it, expect } from 'vitest';
import { getToolCategory, canTrustTool } from './toolSafety';

describe('getToolCategory hook namespaces', () => {
  it('classifies agent_hook:* and skill_hook:* as prompt_always (never trustable)', () => {
    expect(getToolCategory('agent_hook:PreToolUse')).toBe('prompt_always');
    expect(getToolCategory('agent_hook:Stop')).toBe('prompt_always');
    expect(getToolCategory('skill_hook:pre-invoke')).toBe('prompt_always');

    expect(canTrustTool('agent_hook:PreToolUse')).toBe(false);
    expect(canTrustTool('skill_hook:pre-invoke')).toBe(false);
  });

  it('does not let a custom category downgrade a hook namespace', () => {
    // The namespace check runs before custom categories, so a repo-supplied
    // category can never make a hook shell trustable.
    expect(getToolCategory('agent_hook:PreToolUse', { 'agent_hook:PreToolUse': 'auto_approve' })).toBe('prompt_always');
  });

  it('still resolves normal tools as before', () => {
    expect(getToolCategory('file_read')).toBe('prompt_default');
    expect(getToolCategory('edit_file')).toBe('prompt_always');
    expect(getToolCategory('math_evaluate')).toBe('auto_approve');
    expect(getToolCategory('some_unknown_tool')).toBe('prompt_default');
  });
});

describe('getToolCategory MCP and skill defaults', () => {
  it('classifies MCP tools and skill as prompt_always (opaque power -> always prompt)', () => {
    expect(getToolCategory('mcp__github__create_issue')).toBe('prompt_always');
    expect(getToolCategory('mcp__anything__whatever')).toBe('prompt_always');
    expect(getToolCategory('skill')).toBe('prompt_always');

    expect(canTrustTool('mcp__github__create_issue')).toBe(false);
    expect(canTrustTool('skill')).toBe(false);
  });

  it('lets an operator relax a specific MCP tool via a custom category', () => {
    // The mcp__ default runs AFTER custom categories, so a trusted server can be
    // explicitly downgraded (unlike the hook namespaces, which cannot).
    expect(getToolCategory('mcp__manifold__read_board', { mcp__manifold__read_board: 'auto_approve' })).toBe(
      'auto_approve'
    );
  });
});
