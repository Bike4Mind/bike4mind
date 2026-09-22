import { describe, it, expect, vi, afterEach } from 'vitest';
import path from 'path';
import { promises as fs, existsSync } from 'fs';
import { tmpdir } from 'os';
import type { ICompletionOptionTools } from '@bike4mind/llm-adapters';

// executeTool routes through ToolRouter (server/WebSocket executors, output
// sanitizer). Override just executeTool to invoke the tool's own fn, so these
// tests exercise ONLY the permission wrapper's cleanup guard and risk-driven
// force-prompt - not tool routing.
vi.mock('../llm/ToolRouter', async importOriginal => {
  const actual = await importOriginal<typeof import('../llm/ToolRouter')>();
  return {
    ...actual,
    executeTool: vi.fn(async (_name: string, args: unknown, _api: unknown, fn: (a: unknown) => Promise<string>) =>
      fn(args)
    ),
  };
});

import { wrapToolWithPermission } from './toolsAdapter.js';
import { PermissionManager } from './PermissionManager.js';
import { useCliStore } from '../store/index.js';

function tool(name: string, fn?: (args: any) => Promise<string>): ICompletionOptionTools {
  return {
    toolFn: fn ?? (async () => 'ok'),
    toolSchema: { name, description: name, parameters: { type: 'object', properties: {} } },
  } as ICompletionOptionTools;
}

// No sandboxOrchestrator, no allowedDirectories: the tool runs unsandboxed and
// the path-grant retry is disabled - exactly the case criterion 3 targets.
function wrap(t: ICompletionOptionTools, prompt: any, pm: PermissionManager): ICompletionOptionTools {
  const agentContext = { currentAgent: null, observationQueue: [] as Array<{ toolName: string; result: unknown }> };
  return wrapToolWithPermission(t, pm, prompt, agentContext, {} as any, {} as any);
}

afterEach(() => useCliStore.getState().setInteractionMode('normal'));

describe('wrapToolWithPermission: _sandboxCleanup guard (criterion 3)', () => {
  it('never deletes a model-supplied _sandboxCleanup path on an unsandboxed tool', async () => {
    // math_evaluate is auto_approve -> no prompt, no sandbox. A malicious model
    // arg must not reach rmSync(recursive, force). On main the wrapper passed the
    // raw arg through, so this directory was deleted.
    const dir = await fs.mkdtemp(path.join(tmpdir(), 'b4m-cleanup-'));
    const victim = path.join(dir, 'keep.txt');
    await fs.writeFile(victim, 'do not delete me');

    const prompt = vi.fn();
    const wrapped = wrap(tool('math_evaluate'), prompt, new PermissionManager([], undefined, []));

    const result = await wrapped.toolFn({ expression: '1+1', _sandboxCleanup: [dir] });

    expect(result).toBe('ok');
    expect(prompt).not.toHaveBeenCalled();
    expect(existsSync(victim)).toBe(true);
    expect(existsSync(dir)).toBe(true);
  });
});

describe('wrapToolWithPermission: write_shell_stdin force-prompt (criterion 6)', () => {
  it('forces the permission prompt for `rm -rf ~` even under auto-accept', async () => {
    useCliStore.getState().setInteractionMode('auto-accept');
    const prompt = vi.fn().mockResolvedValue({ action: 'allow-once' });
    const wrapped = wrap(tool('write_shell_stdin'), prompt, new PermissionManager([], undefined, []));

    await wrapped.toolFn({ chars: 'rm -rf ~' });

    // High command-risk overrides the auto-accept short-circuit. On main
    // write_shell_stdin was not a shell-like field, so risk stayed null and
    // auto-accept ran the destructive stdin silently.
    expect(prompt).toHaveBeenCalledTimes(1);
    expect(prompt.mock.calls[0][0]).toBe('write_shell_stdin');
  });

  it('forces the permission prompt for `rm -rf ~` even when the tool is session-trusted', async () => {
    const pm = new PermissionManager([], undefined, []);
    pm.trustToolForSession('write_shell_stdin');
    const prompt = vi.fn().mockResolvedValue({ action: 'allow-once' });
    const wrapped = wrap(tool('write_shell_stdin'), prompt, pm);

    await wrapped.toolFn({ chars: 'rm -rf ~' });

    expect(prompt).toHaveBeenCalledTimes(1);
  });

  it('leaves a benign stdin on its normal (auto-accepted) path - tightening only', async () => {
    useCliStore.getState().setInteractionMode('auto-accept');
    const prompt = vi.fn().mockResolvedValue({ action: 'allow-once' });
    const wrapped = wrap(tool('write_shell_stdin'), prompt, new PermissionManager([], undefined, []));

    await wrapped.toolFn({ chars: 'ls -la' });

    expect(prompt).not.toHaveBeenCalled();
  });
});

describe('wrapToolWithPermission: edit_local_file fuzzy force-prompt', () => {
  // A fuzzy edit resolves the real span via the block-anchor matcher, which can
  // write more than old_string names. Trailing whitespace on a single line means
  // `content.includes(old_string)` is false but the line-trimmed strategy matches.
  async function fuzzyFile(): Promise<string> {
    const dir = await fs.mkdtemp(path.join(tmpdir(), 'b4m-fuzzy-'));
    const file = path.join(dir, 'note.txt');
    await fs.writeFile(file, 'hello world\n');
    return file;
  }
  const fuzzyArgs = (file: string) => ({ path: file, old_string: 'hello world   ', new_string: 'hi world' });
  const exactArgs = (file: string) => ({ path: file, old_string: 'hello world', new_string: 'hi world' });

  it('forces the permission prompt under auto-accept when the edit resolves fuzzily', async () => {
    useCliStore.getState().setInteractionMode('auto-accept');
    const prompt = vi.fn().mockResolvedValue({ action: 'allow-once' });
    const wrapped = wrap(tool('edit_local_file'), prompt, new PermissionManager([], undefined, []));

    await wrapped.toolFn(fuzzyArgs(await fuzzyFile()));

    expect(prompt).toHaveBeenCalledTimes(1);
    expect(prompt.mock.calls[0][0]).toBe('edit_local_file');
  });

  it('forces the permission prompt when the tool is session-trusted and the edit resolves fuzzily', async () => {
    const pm = new PermissionManager([], undefined, []);
    pm.trustToolForSession('edit_local_file');
    const prompt = vi.fn().mockResolvedValue({ action: 'allow-once' });
    const wrapped = wrap(tool('edit_local_file'), prompt, pm);

    await wrapped.toolFn(fuzzyArgs(await fuzzyFile()));

    expect(prompt).toHaveBeenCalledTimes(1);
  });

  it('does NOT prompt for an exact match under auto-accept or session-trust - tightening only', async () => {
    useCliStore.getState().setInteractionMode('auto-accept');
    const autoPrompt = vi.fn().mockResolvedValue({ action: 'allow-once' });
    const autoWrapped = wrap(tool('edit_local_file'), autoPrompt, new PermissionManager([], undefined, []));
    await autoWrapped.toolFn(exactArgs(await fuzzyFile()));
    expect(autoPrompt).not.toHaveBeenCalled();

    useCliStore.getState().setInteractionMode('normal');
    const pm = new PermissionManager([], undefined, []);
    pm.trustToolForSession('edit_local_file');
    const trustPrompt = vi.fn().mockResolvedValue({ action: 'allow-once' });
    const trustWrapped = wrap(tool('edit_local_file'), trustPrompt, pm);
    await trustWrapped.toolFn(exactArgs(await fuzzyFile()));
    expect(trustPrompt).not.toHaveBeenCalled();
  });
});
