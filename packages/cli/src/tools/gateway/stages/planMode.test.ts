import { describe, it, expect } from 'vitest';
import path from 'path';
import { getPlanModeFileDir } from '../../../utils/planMode.js';
import { ToolCatalog } from '../toolCatalog.js';
import { planModeRefusal } from './planMode.js';

const catalog = new ToolCatalog();

function refusal(toolName: string, args: unknown, mode: 'plan' | 'normal' | 'auto-accept' = 'plan') {
  return planModeRefusal(toolName, catalog.resolve(toolName), args, mode);
}

describe('planModeRefusal', () => {
  it('lets every tool through outside plan mode', () => {
    expect(refusal('bash_execute', { command: 'rm -rf x' }, 'normal')).toBeNull();
    expect(refusal('create_file', { path: 'a.ts' }, 'auto-accept')).toBeNull();
  });

  it('lets read-only tools through in plan mode', () => {
    expect(refusal('file_read', { path: 'a.ts' })).toBeNull();
    expect(refusal('write_todos', {})).toBeNull();
    expect(refusal('some_unknown_tool', {})).toBeNull();
  });

  it('blocks write and execute tools in plan mode', () => {
    expect(refusal('bash_execute', { command: 'ls' })).toMatch(/"bash_execute" is blocked while plan mode is active/);
    expect(refusal('create_file', { path: 'src/a.ts' })).toMatch(/blocked while plan mode/);
    expect(refusal('mcp__srv__tool', {})).toMatch(/blocked while plan mode/);
  });

  it('allows a file write that targets the plan directory', () => {
    const planFile = path.join(getPlanModeFileDir(), 'plan.md');
    expect(refusal('create_file', { path: planFile })).toBeNull();
    expect(refusal('edit_local_file', { path: planFile })).toBeNull();
  });

  it('does not extend the plan-file exemption to a tool without a write path', () => {
    const planFile = path.join(getPlanModeFileDir(), 'plan.md');
    expect(refusal('bash_execute', { command: 'ls', path: planFile })).toMatch(/blocked while plan mode/);
  });
});
