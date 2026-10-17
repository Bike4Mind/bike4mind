import { describe, it, expect } from 'vitest';
import { ToolCatalog, resolveStaticToolDescriptor } from './toolCatalog.js';
import { CORE_TOOL_DESCRIPTORS } from './coreToolDescriptors.js';
import type { ToolDescriptor } from './toolDescriptor.js';

const pluginReader: ToolDescriptor = {
  source: { kind: 'plugin', packageName: 'example-plugin' },
  effect: 'read',
  approval: 'auto_approve',
};

describe('ToolCatalog hook namespaces', () => {
  it('classifies agent_hook:* and skill_hook:* as prompt_always (never trustable)', () => {
    const catalog = new ToolCatalog();
    expect(catalog.category('agent_hook:PreToolUse')).toBe('prompt_always');
    expect(catalog.category('agent_hook:Stop')).toBe('prompt_always');
    expect(catalog.category('skill_hook:pre-invoke')).toBe('prompt_always');

    expect(catalog.canTrust('agent_hook:PreToolUse')).toBe(false);
    expect(catalog.canTrust('skill_hook:pre-invoke')).toBe(false);
    expect(catalog.isReadOnly('agent_hook:PreToolUse')).toBe(false);
  });

  it('does not let a registration downgrade a hook namespace', () => {
    const catalog = new ToolCatalog();
    expect(() => catalog.register('agent_hook:PreToolUse', pluginReader)).toThrow(/reserved namespace/);
    expect(() => catalog.register('skill_hook:pre-invoke', pluginReader)).toThrow(/reserved namespace/);
    expect(catalog.category('agent_hook:PreToolUse')).toBe('prompt_always');
  });

  it('still resolves normal tools as before', () => {
    const catalog = new ToolCatalog();
    expect(catalog.category('file_read')).toBe('prompt_default');
    expect(catalog.category('edit_file')).toBe('prompt_always');
    expect(catalog.category('math_evaluate')).toBe('auto_approve');
  });
});

describe('ToolCatalog MCP and skill defaults', () => {
  it('classifies MCP tools and skill as prompt_always (opaque power -> always prompt)', () => {
    const catalog = new ToolCatalog();
    expect(catalog.category('mcp__github__create_issue')).toBe('prompt_always');
    expect(catalog.category('mcp__anything__whatever')).toBe('prompt_always');
    expect(catalog.category('skill')).toBe('prompt_always');

    expect(catalog.canTrust('mcp__github__create_issue')).toBe(false);
    expect(catalog.canTrust('skill')).toBe(false);
    expect(catalog.isReadOnly('mcp__github__create_issue')).toBe(false);
  });

  it('parses the server from an mcp__<server>__<tool> name', () => {
    expect(resolveStaticToolDescriptor('mcp__github__create_issue')?.source).toEqual({ kind: 'mcp', server: 'github' });
    expect(resolveStaticToolDescriptor('mcp__my_server')?.source).toEqual({ kind: 'mcp', server: 'my_server' });
  });

  it('refuses to register into the MCP namespace', () => {
    expect(() => new ToolCatalog().register('mcp__github__create_issue', pluginReader)).toThrow(/reserved namespace/);
  });
});

describe('CLI session bookkeeping and delegation categories', () => {
  // The permission wrapper routes every CLI-built tool, so each one needs an explicit
  // descriptor: an unknown name falls back to prompt_default, which prompts interactive
  // users on every todo/blocker/work-item call and denies the tool outright in a headless
  // run with a deny-default policy.
  it.each([
    'agent_delegate',
    'check_agent_status',
    'list_background_agents',
    'cancel_background_agent',
    'resume_agent',
    'create_dynamic_agent',
    'coordinate_task',
    'decompose_task',
    'shared_context_read',
    'shared_context_write',
    'write_todos',
    'read_prior_todos',
    'log_decision',
    'track_blocker',
    'resolve_blocker',
    'request_review_gate',
    'work_item_create',
    'work_item_update',
    'work_item_close',
    'work_item_ready',
    'work_item_graph',
    'tool_search',
  ])('auto-approves %s', name => {
    expect(new ToolCatalog().category(name)).toBe('auto_approve');
  });
});

describe('ToolCatalog resolution order', () => {
  it('resolves a registered descriptor first', () => {
    const catalog = new ToolCatalog();
    catalog.register('plugin_lookup', pluginReader);
    expect(catalog.resolve('plugin_lookup')).toBe(pluginReader);
    expect(catalog.category('plugin_lookup')).toBe('auto_approve');
  });

  it('resolves a core name from the core table', () => {
    expect(new ToolCatalog().resolve('bash_execute')).toBe(CORE_TOOL_DESCRIPTORS.get('bash_execute'));
  });

  it('checks the core table before the MCP and hook prefixes', () => {
    // No core name carries a reserved prefix, so the order is only observable through
    // resolveStaticToolDescriptor returning the core entry itself.
    for (const name of CORE_TOOL_DESCRIPTORS.keys()) {
      expect(name.startsWith('mcp__') || name.startsWith('agent_hook:') || name.startsWith('skill_hook:')).toBe(false);
      expect(resolveStaticToolDescriptor(name)).toBe(CORE_TOOL_DESCRIPTORS.get(name));
    }
  });

  it('resolves the MCP and hook namespaces from the name alone', () => {
    expect(resolveStaticToolDescriptor('mcp__srv__tool')?.source.kind).toBe('mcp');
    expect(resolveStaticToolDescriptor('agent_hook:Stop')?.source.kind).toBe('hook');
    expect(resolveStaticToolDescriptor('skill_hook:post-invoke')?.source.kind).toBe('hook');
  });

  it('falls back to prompt_default and read-only for an unknown tool', () => {
    const catalog = new ToolCatalog();
    expect(catalog.resolve('some_unknown_tool')).toBeUndefined();
    expect(catalog.category('some_unknown_tool')).toBe('prompt_default');
    expect(catalog.canTrust('some_unknown_tool')).toBe(true);
    expect(catalog.isReadOnly('some_unknown_tool')).toBe(true);
  });

  it('keeps registrations per instance', () => {
    const first = new ToolCatalog();
    first.register('plugin_lookup', pluginReader);
    expect(new ToolCatalog().resolve('plugin_lookup')).toBeUndefined();
  });
});

describe('ToolCatalog.register', () => {
  it('refuses to re-declare a core tool', () => {
    expect(() => new ToolCatalog().register('bash_execute', pluginReader)).toThrow(/core tool/);
  });

  it('refuses a duplicate registration', () => {
    const catalog = new ToolCatalog();
    catalog.register('plugin_lookup', pluginReader);
    expect(() => catalog.register('plugin_lookup', pluginReader)).toThrow(/already has a registered descriptor/);
  });
});
