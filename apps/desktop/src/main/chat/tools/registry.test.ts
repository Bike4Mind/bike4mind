import { describe, expect, it } from 'vitest';
import { findTool, isOfferedEditTool, toolsForRequest } from './registry';
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

  it('offers the browser without a folder, a project or anything else', () => {
    // The browser rides on nothing: a Chat session with no grant at all still gets it.
    expect(names({ roots: [], media: false, host: false, browser: true })).toEqual(
      expect.arrayContaining(['browser_navigate', 'browser_click', 'browser_screenshot'])
    );
    // And widening it leaves the host family where it was.
    expect(names({ roots: [], media: false, host: false, browser: true })).not.toContain('session_spawn');
    expect(names({ roots: ['/tmp'], media: true, host: true })).not.toContain('browser_navigate');
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

  describe('editing tools by model', () => {
    const edit = ['file_edit', 'file_write'];

    it('offers GPT models apply_patch instead of file_edit and file_write', () => {
      const declared = names({ roots: ['/tmp'], media: false, host: false, modelId: 'gpt-5' });
      expect(declared).toContain('apply_patch');
      for (const name of edit) expect(declared).not.toContain(name);
    });

    it('keeps file_edit and file_write, and no apply_patch, for gpt-4, oss and non-GPT models', () => {
      for (const modelId of ['gpt-4o', 'gpt-oss-120b', 'claude-sonnet-5-5', 'gemini-3-flash', undefined]) {
        const declared = names({ roots: ['/tmp'], media: false, host: false, modelId });
        expect(declared, String(modelId)).toEqual(expect.arrayContaining(edit));
        expect(declared, String(modelId)).not.toContain('apply_patch');
      }
    });

    it('leaves the other local tools and explore alone', () => {
      const gpt = names({ roots: ['/tmp'], media: false, host: false, explore: true, modelId: 'gpt-5' });
      const other = names({ roots: ['/tmp'], media: false, host: false, explore: true, modelId: 'claude-sonnet-5-5' });
      const strip = (list: string[]) => list.filter(name => name !== 'apply_patch' && !edit.includes(name));
      expect(strip(gpt)).toEqual(strip(other));
      expect(gpt).toContain('explore');
    });

    it('offers no edit tool at all without a granted folder', () => {
      expect(names({ roots: [], media: false, host: false, modelId: 'gpt-5' })).toEqual([]);
    });

    it('finds every edit tool by name, and says which family a model was offered', () => {
      for (const name of ['apply_patch', ...edit]) expect(findTool(name)).toBeDefined();
      expect(isOfferedEditTool('apply_patch', true)).toBe(true);
      expect(isOfferedEditTool('apply_patch', false)).toBe(false);
      expect(isOfferedEditTool('file_edit', true)).toBe(false);
      expect(isOfferedEditTool('file_write', false)).toBe(true);
      expect(isOfferedEditTool('file_read', true)).toBe(true);
    });
  });
});
