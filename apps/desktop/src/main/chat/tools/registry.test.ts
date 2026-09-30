import { describe, expect, it } from 'vitest';
import { findTool, toolsForRequest } from './registry';
import type { ToolSchema } from './types';

const names = (options: Parameters<typeof toolsForRequest>[0]) =>
  toolsForRequest(options).map(entry => entry.toolSchema.name);

const mcpSchema: ToolSchema = {
  name: 'mcp__notion_search',
  description: 'from a server',
  parameters: { type: 'object', properties: {} },
};

/**
 * The seam where the four tool families meet. Each becomes available for its own unrelated
 * reason, so the combinations are what is worth pinning: a Code session with a project, a
 * signed-in session and a connected MCP server gets all four at once, and each family being
 * off must subtract only itself.
 */
describe('toolsForRequest', () => {
  it('declares nothing when nothing is available', () => {
    expect(names({ roots: [], media: false, host: false })).toEqual([]);
  });

  it('declares all four families together', () => {
    const declared = names({ roots: ['/tmp'], media: true, host: true, mcp: [mcpSchema] });
    expect(declared).toContain('bash_execute');
    expect(declared).toContain('generate_image');
    expect(declared).toContain('session_spawn');
    expect(declared).toContain('mcp__notion_search');
  });

  it('keeps MCP tools when every built-in family is off', () => {
    // A signed-out user with no folder and no project still gets the servers they configured:
    // an MCP server is theirs, and none of the other three preconditions is about it.
    expect(names({ roots: [], media: false, host: false, mcp: [mcpSchema] })).toEqual(['mcp__notion_search']);
  });

  it('drops each family independently', () => {
    expect(names({ roots: [], media: true, host: true, mcp: [mcpSchema] })).not.toContain('bash_execute');
    expect(names({ roots: ['/tmp'], media: false, host: true, mcp: [mcpSchema] })).not.toContain('generate_image');
    expect(names({ roots: ['/tmp'], media: true, host: false, mcp: [mcpSchema] })).not.toContain('session_spawn');
    expect(names({ roots: ['/tmp'], media: true, host: true })).not.toContain('mcp__notion_search');
  });

  it('offers explore only beside the local tools', () => {
    expect(names({ roots: ['/tmp'], media: false, host: false, explore: true })).toContain('explore');
    expect(names({ roots: [], media: false, host: false, explore: true })).not.toContain('explore');
    expect(names({ roots: ['/tmp'], media: false, host: false })).not.toContain('explore');
    expect(findTool('explore')).toBeDefined();
  });

  it('declares no tool twice, whatever a server contributed', () => {
    const declared = names({ roots: ['/tmp'], media: true, host: true, mcp: [mcpSchema] });
    expect(new Set(declared).size).toBe(declared.length);
  });

  it('resolves built-ins but never an MCP name, which ChatService owns', () => {
    expect(findTool('bash_execute')).toBeDefined();
    expect(findTool('session_spawn')).toBeDefined();
    expect(findTool('generate_image')).toBeDefined();
    // The MCP registry is the manager's; a declared MCP schema must not become findable here,
    // or the built-ins-first lookup in ChatService would be resolving MCP tools by accident.
    expect(findTool('mcp__notion_search')).toBeUndefined();
  });
});
