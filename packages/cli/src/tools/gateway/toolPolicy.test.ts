import { describe, it, expect } from 'vitest';
import { canTrustTool, commandTextOf, isReadOnlyTool, toolCategory, writePathOf } from './toolPolicy.js';
import type { ToolDescriptor, ToolEffect } from './toolDescriptor.js';

function descriptor(overrides: Partial<ToolDescriptor> = {}): ToolDescriptor {
  return { source: { kind: 'core' }, effect: 'read', approval: 'prompt_default', ...overrides };
}

describe('toolCategory', () => {
  it('returns the declared approval for a trusted source', () => {
    expect(toolCategory(descriptor({ approval: 'auto_approve' }))).toBe('auto_approve');
    expect(toolCategory(descriptor({ source: { kind: 'cli' }, approval: 'prompt_always' }))).toBe('prompt_always');
    expect(
      toolCategory(descriptor({ source: { kind: 'builtin-module', module: 'm' }, approval: 'auto_approve' }))
    ).toBe('auto_approve');
  });

  it('never lets a plugin skip the first prompt, but keeps a stricter declared tier', () => {
    const plugin = { kind: 'plugin', packageName: 'p' } as const;
    expect(toolCategory(descriptor({ source: plugin, approval: 'auto_approve' }))).toBe('prompt_default');
    expect(toolCategory(descriptor({ source: plugin, approval: 'prompt_default' }))).toBe('prompt_default');
    expect(toolCategory(descriptor({ source: plugin, approval: 'prompt_always' }))).toBe('prompt_always');
    expect(canTrustTool(descriptor({ source: plugin, approval: 'auto_approve' }))).toBe(true);
  });

  it('forces prompt_always for MCP and hook sources whatever they declare', () => {
    expect(toolCategory(descriptor({ source: { kind: 'mcp', server: 's' }, approval: 'auto_approve' }))).toBe(
      'prompt_always'
    );
    expect(toolCategory(descriptor({ source: { kind: 'hook' }, approval: 'auto_approve' }))).toBe('prompt_always');
  });

  it('falls back to prompt_default for an unresolved tool', () => {
    expect(toolCategory(undefined)).toBe('prompt_default');
  });
});

describe('canTrustTool', () => {
  it('is false only for prompt_always', () => {
    expect(canTrustTool(descriptor({ approval: 'prompt_always' }))).toBe(false);
    expect(canTrustTool(descriptor({ approval: 'prompt_default' }))).toBe(true);
    expect(canTrustTool(descriptor({ approval: 'auto_approve' }))).toBe(true);
    expect(canTrustTool(undefined)).toBe(true);
    expect(canTrustTool(descriptor({ source: { kind: 'mcp', server: 's' }, approval: 'auto_approve' }))).toBe(false);
  });
});

describe('isReadOnlyTool', () => {
  it('believes the declared effect of a builtin module', () => {
    expect(isReadOnlyTool(descriptor({ source: { kind: 'builtin-module', module: 'm' }, effect: 'read' }))).toBe(true);
  });

  it.each<[ToolEffect, boolean]>([
    ['none', true],
    ['session', true],
    ['read', true],
    ['write', false],
    ['execute', false],
  ])('derives read-only from effect %s', (effect, expected) => {
    expect(isReadOnlyTool(descriptor({ effect }))).toBe(expected);
  });

  it('never treats an MCP, hook or plugin tool as read-only', () => {
    expect(isReadOnlyTool(descriptor({ source: { kind: 'mcp', server: 's' }, effect: 'read' }))).toBe(false);
    expect(isReadOnlyTool(descriptor({ source: { kind: 'plugin', packageName: 'p' }, effect: 'none' }))).toBe(false);
    expect(isReadOnlyTool(descriptor({ source: { kind: 'hook' }, effect: 'none' }))).toBe(false);
  });

  it('treats an unresolved tool as read-only', () => {
    expect(isReadOnlyTool(undefined)).toBe(true);
  });
});

describe('commandTextOf / writePathOf', () => {
  it('reads the declared argument', () => {
    expect(commandTextOf(descriptor({ commandArg: 'command' }), { command: 'ls' })).toBe('ls');
    expect(writePathOf(descriptor({ writePathArg: 'path' }), { path: 'a.txt' })).toBe('a.txt');
  });

  it('returns undefined without a declared argument, a string value or an args object', () => {
    expect(commandTextOf(descriptor(), { command: 'ls' })).toBeUndefined();
    expect(commandTextOf(descriptor({ commandArg: 'command' }), { command: 42 })).toBeUndefined();
    expect(commandTextOf(descriptor({ commandArg: 'command' }), null)).toBeUndefined();
    expect(commandTextOf(undefined, { command: 'ls' })).toBeUndefined();
    expect(writePathOf(descriptor(), { path: 'a.txt' })).toBeUndefined();
    expect(writePathOf(descriptor({ writePathArg: 'path' }), { path: '' })).toBeUndefined();
    expect(writePathOf(descriptor({ writePathArg: 'path' }), 'a.txt')).toBeUndefined();
  });
});
