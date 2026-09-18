/**
 * Hook-command permission gate: the shared helper and both hook paths (agent
 * lifecycle hooks via executeHooks, and skill lifecycle hooks via createSkillTool)
 * must obtain a permission decision BEFORE running any shell command.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('./shellRunner.js', () => ({ runShellCommand: vi.fn() }));
vi.mock('./shellRunner', () => ({ runShellCommand: vi.fn() }));

import { runShellCommand } from './shellRunner';
import { requestShellCommandPermission, type ShellPermissionPromptFn } from './commandPermission';
import { PermissionManager } from './PermissionManager';
import { executeHooks } from '../agents/hookExecutor';
import { createSkillTool } from '../tools/skillTool';
import type { CustomCommandStore } from '../storage/CustomCommandStore';
import type { CustomCommand } from '../storage/types';

const mockRun = vi.mocked(runShellCommand);

function promptReturning(action: 'allow-once' | 'allow-session' | 'allow-always' | 'deny'): ShellPermissionPromptFn {
  return vi.fn(async () => ({ action }));
}

beforeEach(() => {
  mockRun.mockReset();
  mockRun.mockResolvedValue({ exitCode: 0, stdout: 'ok', stderr: '', timedOut: false });
});

describe('requestShellCommandPermission', () => {
  it('denies when the prompt is denied', async () => {
    const pm = new PermissionManager();
    const res = await requestShellCommandPermission('agent_hook:PreToolUse', 'rm -rf /', '/proj', {
      permissionManager: pm,
      promptFn: promptReturning('deny'),
    });
    expect(res.allowed).toBe(false);
  });

  it('allows once without permanently trusting the hook', async () => {
    const pm = new PermissionManager();
    const res = await requestShellCommandPermission('agent_hook:PreToolUse', 'ls', '/proj', {
      permissionManager: pm,
      promptFn: promptReturning('allow-once'),
    });
    expect(res.allowed).toBe(true);
    expect(pm.isSessionTrusted('agent_hook:PreToolUse')).toBe(false);
  });

  it('allow-session session-trusts the hook so the next call skips the prompt', async () => {
    const pm = new PermissionManager();
    const prompt = promptReturning('allow-session');
    await requestShellCommandPermission('agent_hook:Stop', 'ls', '/proj', { permissionManager: pm, promptFn: prompt });
    expect(pm.isSessionTrusted('agent_hook:Stop')).toBe(true);

    // A second call is allowed without prompting again.
    const prompt2 = promptReturning('deny');
    const res = await requestShellCommandPermission('agent_hook:Stop', 'ls', '/proj', {
      permissionManager: pm,
      promptFn: prompt2,
    });
    expect(res.allowed).toBe(true);
    expect(prompt2).not.toHaveBeenCalled();
  });
});

describe('agent lifecycle hooks (executeHooks)', () => {
  const hooks = [{ hooks: [{ type: 'command' as const, command: 'echo hi' }] }];
  const context = {
    session_id: 's',
    agent_name: 'a',
    cwd: '/proj',
    hook_event_name: 'PreToolUse',
    tool_name: 'edit_file',
  };

  it('does not run the shell command when permission is denied', async () => {
    const pm = new PermissionManager();
    const result = await executeHooks(hooks, context, { permissionManager: pm, promptFn: promptReturning('deny') });
    expect(result.decision).toBe('deny');
    expect(mockRun).not.toHaveBeenCalled();
  });

  it('runs the shell command when permission is allowed', async () => {
    const pm = new PermissionManager();
    await executeHooks(hooks, context, { permissionManager: pm, promptFn: promptReturning('allow-once') });
    expect(mockRun).toHaveBeenCalledTimes(1);
  });
});

describe('skill lifecycle hooks (createSkillTool)', () => {
  function storeWithHookedSkill(): CustomCommandStore {
    const cmd = {
      name: 'demo',
      description: 'demo',
      body: 'do the thing',
      source: 'project',
      filePath: '/proj/.bike4mind/commands/demo.md',
      hooks: { 'pre-invoke': 'echo pre' },
    } as unknown as CustomCommand;
    return {
      getCommand: (name: string) => (name === 'demo' ? cmd : undefined),
      getAllCommands: () => [cmd],
    } as unknown as CustomCommandStore;
  }

  it('does not run the pre-invoke hook shell command when denied', async () => {
    const pm = new PermissionManager();
    const tool = createSkillTool({
      customCommandStore: storeWithHookedSkill(),
      permissionManager: pm,
      promptFn: promptReturning('deny'),
    });
    await expect(tool.toolFn({ skill: 'demo' })).rejects.toThrow(/Pre-invoke hook/);
    expect(mockRun).not.toHaveBeenCalled();
  });

  it('runs the pre-invoke hook shell command when allowed', async () => {
    const pm = new PermissionManager();
    const tool = createSkillTool({
      customCommandStore: storeWithHookedSkill(),
      permissionManager: pm,
      promptFn: promptReturning('allow-once'),
    });
    const result = await tool.toolFn({ skill: 'demo' });
    expect(mockRun).toHaveBeenCalledTimes(1);
    expect(String(result)).toContain('Skill Loaded');
  });
});
