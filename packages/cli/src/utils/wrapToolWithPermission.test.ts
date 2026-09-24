import { describe, it, expect, vi, afterEach, beforeAll } from 'vitest';
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
import { executeTool } from '../llm/ToolRouter';
import { getCliOnlyTools, resolveEditLocalFile } from '@bike4mind/services/llm/tools/cliTools';

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
  // These drive the REAL edit_local_file tool over real temp files, so the gate's
  // authorized resolve and the tool's snapshot-bound write both run - the same code
  // path production uses. The tool definition comes from the CLI tool registry.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let editDef: any;
  beforeAll(async () => {
    editDef = (await getCliOnlyTools()).edit_local_file;
  });
  function realEditTool(allowedDirectories: string[]): ICompletionOptionTools {
    const logger = { info() {}, error() {}, warn() {}, debug() {} };
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    return editDef.implementation({ logger, allowedDirectories } as any) as ICompletionOptionTools;
  }
  function wrapEdit(prompt: any, pm: PermissionManager, dirs: string[]): ICompletionOptionTools {
    const agentContext = { currentAgent: null, observationQueue: [] as Array<{ toolName: string; result: unknown }> };
    return wrapToolWithPermission(realEditTool(dirs), pm, prompt, agentContext, {} as any, {} as any, undefined, dirs);
  }
  // 'hello world\n' is an exact substring of `old_string: 'hello world'` but not of
  // `old_string: 'hello world   '` (trailing spaces), which resolves fuzzily instead.
  async function fuzzyFile(): Promise<{ dir: string; file: string }> {
    const dir = await fs.mkdtemp(path.join(tmpdir(), 'b4m-fuzzy-'));
    const file = path.join(dir, 'note.txt');
    await fs.writeFile(file, 'hello world\n');
    return { dir, file };
  }

  it('forces one prompt under auto-accept when the edit resolves fuzzily, shows the span, and applies it', async () => {
    useCliStore.getState().setInteractionMode('auto-accept');
    const { dir, file } = await fuzzyFile();
    const prompt = vi.fn().mockResolvedValue({ action: 'allow-once' });
    const wrapped = wrapEdit(prompt, new PermissionManager([], undefined, []), [dir]);

    await wrapped.toolFn({ path: file, old_string: 'hello world   ', new_string: 'hi world' });

    expect(prompt).toHaveBeenCalledTimes(1);
    expect(prompt.mock.calls[0][0]).toBe('edit_local_file');
    const preview = prompt.mock.calls[0][2] as string;
    expect(preview).toContain('was not an exact match'); // fuzzy banner
    expect(preview).toContain('hello world'); // the real resolved span (deleted)
    expect(preview).toContain('hi world'); // the replacement
    expect(await fs.readFile(file, 'utf-8')).toBe('hi world\n');
  });

  it('forces one prompt when the tool is session-trusted and the edit resolves fuzzily', async () => {
    const { dir, file } = await fuzzyFile();
    const pm = new PermissionManager([], undefined, []);
    pm.trustToolForSession('edit_local_file');
    const prompt = vi.fn().mockResolvedValue({ action: 'allow-once' });
    const wrapped = wrapEdit(prompt, pm, [dir]);

    await wrapped.toolFn({ path: file, old_string: 'hello world   ', new_string: 'hi world' });

    expect(prompt).toHaveBeenCalledTimes(1);
    expect(await fs.readFile(file, 'utf-8')).toBe('hi world\n');
  });

  it('does NOT prompt for an exact match under auto-accept or session-trust - tightening only', async () => {
    useCliStore.getState().setInteractionMode('auto-accept');
    const a = await fuzzyFile();
    const autoPrompt = vi.fn().mockResolvedValue({ action: 'allow-once' });
    const autoWrapped = wrapEdit(autoPrompt, new PermissionManager([], undefined, []), [a.dir]);
    await autoWrapped.toolFn({ path: a.file, old_string: 'hello world', new_string: 'hi world' });
    expect(autoPrompt).not.toHaveBeenCalled();
    expect(await fs.readFile(a.file, 'utf-8')).toBe('hi world\n');

    useCliStore.getState().setInteractionMode('normal');
    const b = await fuzzyFile();
    const pm = new PermissionManager([], undefined, []);
    pm.trustToolForSession('edit_local_file');
    const trustPrompt = vi.fn().mockResolvedValue({ action: 'allow-once' });
    const trustWrapped = wrapEdit(trustPrompt, pm, [b.dir]);
    await trustWrapped.toolFn({ path: b.file, old_string: 'hello world', new_string: 'hi world' });
    expect(trustPrompt).not.toHaveBeenCalled();
    expect(await fs.readFile(b.file, 'utf-8')).toBe('hi world\n');
  });

  it('re-prompts exactly once when an edit is exact at gate time but resolves fuzzily at write time', async () => {
    // The TOCTOU: the gate sees an exact match, the file changes to a fuzzy region
    // before the write. On main this completed with prompts: 0 (silent fuzzy write).
    const { dir, file } = await fuzzyFile();
    const pm = new PermissionManager([], undefined, []);
    pm.trustToolForSession('edit_local_file');
    const prompt = vi.fn().mockResolvedValue({ action: 'allow-once' });
    const wrapped = wrapEdit(prompt, pm, [dir]);

    // Simulate a formatter/watcher rewriting the region AFTER the gate's exact read
    // but BEFORE the tool reads to write: mutate the file, then run the real tool.
    vi.mocked(executeTool).mockImplementationOnce(async (_name, callArgs, _api, fn) => {
      await fs.writeFile(file, 'hello   world\n');
      return (fn as (args: unknown) => Promise<string>)(callArgs);
    });

    await wrapped.toolFn({ path: file, old_string: 'hello world', new_string: 'hi world' });

    expect(prompt).toHaveBeenCalledTimes(1);
    expect(await fs.readFile(file, 'utf-8')).toBe('hi world\n');
  });

  it('strips a forged gateSnapshot when the gate itself finds no match, so a hijacked write cannot slip through (security)', async () => {
    // A model-supplied gateSnapshot must never survive to the write path when the
    // gate's own resolveEditLocalFile() throws (editPlan stays null) - on main this
    // let a caller who already knows the file's real hash (e.g. via a shell tool)
    // forge an arbitrary span/replacement and have it applied verbatim, with no
    // permission prompt, under a trusted/auto-accept session.
    const { dir, file } = await fuzzyFile();
    const pm = new PermissionManager([], undefined, []);
    pm.trustToolForSession('edit_local_file');
    const prompt = vi.fn().mockResolvedValue({ action: 'allow-once' });
    const wrapped = wrapEdit(prompt, pm, [dir]);

    const realPlan = await resolveEditLocalFile({ path: file, old_string: 'hello world', new_string: 'x' }, [dir]);

    await expect(
      wrapped.toolFn({
        path: file,
        old_string: 'this string does not exist in the file',
        new_string: 'irrelevant',
        gateSnapshot: {
          contentHash: realPlan.contentHash,
          resolvedEdit: { startIndex: 0, matchedText: 'hello world', replacement: 'PWNED' },
        },
      })
    ).rejects.toThrow(/not found/i);

    expect(prompt).not.toHaveBeenCalled();
    expect(await fs.readFile(file, 'utf-8')).toBe('hello world\n'); // untouched
  });

  it('never force-prompts (or writes) a fuzzy edit whose path is outside the allowed directories', async () => {
    // The gate's resolve runs the SAME authorization as the tool, so an out-of-bounds
    // path is rejected before any content read - no raw-path read, no force prompt.
    // On main willEditResolveFuzzily read the raw path and force-prompted here.
    const { file } = await fuzzyFile();
    const pm = new PermissionManager([], undefined, []);
    pm.trustToolForSession('edit_local_file');
    const prompt = vi.fn().mockResolvedValue({ action: 'allow-once' });
    // No allowedDirectories passed to the wrapper => the runtime grant flow is off,
    // and the temp file is outside cwd, so authorization rejects it.
    const agentContext = { currentAgent: null, observationQueue: [] as Array<{ toolName: string; result: unknown }> };
    const wrapped = wrapToolWithPermission(realEditTool([]), pm, prompt, agentContext, {} as any, {} as any);

    const result = await wrapped.toolFn({ path: file, old_string: 'hello world   ', new_string: 'hi world' });

    expect(prompt).not.toHaveBeenCalled();
    expect(result).toMatch(/Access denied/);
    expect(await fs.readFile(file, 'utf-8')).toBe('hello world\n'); // untouched
  });

  it('previews an out-of-bounds edit as denied WITHOUT reading the raw path (preview auth parity)', async () => {
    // In normal mode a prompt IS shown, so the preview runs. It must not read a
    // path the tool would refuse - previewing old_string alone would open a raw
    // out-of-bounds path (a /dev/zero could hang the preview).
    useCliStore.getState().setInteractionMode('normal');
    const { file } = await fuzzyFile();
    const prompt = vi.fn().mockResolvedValue({ action: 'deny' });
    const agentContext = { currentAgent: null, observationQueue: [] as Array<{ toolName: string; result: unknown }> };
    // Untrusted + no allowedDirectories: the file is outside cwd, so it is denied,
    // but a prompt is still shown first (this is where the preview is built).
    const wrapped = wrapToolWithPermission(
      realEditTool([]),
      new PermissionManager([], undefined, []),
      prompt,
      agentContext,
      {} as any,
      {} as any
    );
    const readSpy = vi.spyOn(fs, 'readFile');

    await expect(
      wrapped.toolFn({ path: file, old_string: 'hello world   ', new_string: 'hi world' })
    ).rejects.toThrow();

    const preview = prompt.mock.calls[0][2] as string;
    expect(preview).toContain('Path outside allowed directories');
    expect(preview).not.toContain('hello world'); // the file was never read/diffed
    expect(readSpy).not.toHaveBeenCalledWith(file, expect.anything());
    readSpy.mockRestore();
  });

  it('re-confirms a granted edit that resolves fuzzily instead of applying it silently', async () => {
    // onoya: a directory grant must not double as a confirmation bypass. Grant the
    // out-of-bounds dir, then the retry resolves fuzzily and must re-prompt.
    const pm = new PermissionManager([], undefined, []);
    pm.trustToolForSession('edit_local_file'); // main gate auto-approves; isolates grant + fuzzy prompts
    const { dir, file } = await fuzzyFile();
    const dirs: string[] = []; // shared live allow-list; the grant pushes onto it
    const prompt = vi.fn().mockResolvedValue({ action: 'allow-once' });
    const agentContext = { currentAgent: null, observationQueue: [] as Array<{ toolName: string; result: unknown }> };
    const wrapped = wrapToolWithPermission(
      realEditTool(dirs),
      pm,
      prompt,
      agentContext,
      {} as any,
      {} as any,
      undefined,
      dirs
    );

    await wrapped.toolFn({ path: file, old_string: 'hello world   ', new_string: 'hi world' });

    // Prompt 1 = grant the directory; prompt 2 = confirm the fuzzy span. Not silent.
    expect(prompt).toHaveBeenCalledTimes(2);
    expect(prompt.mock.calls[1][2] as string).toContain('was not an exact match');
    expect(await fs.readFile(file, 'utf-8')).toBe('hi world\n');
    expect(dir).toBe(path.dirname(file));
  });

  it('forces the prompt for a fuzzy edit even when the tool is host-allowlisted', async () => {
    // The host-allowlist short-circuit is gated on !forcePrompt, so a fuzzy edit is
    // still re-confirmed. A fresh module picks up B4M_ALLOWED_TOOLS (parsed once).
    vi.resetModules();
    vi.stubEnv('B4M_ALLOWED_TOOLS', JSON.stringify(['edit_local_file']));
    const { wrapToolWithPermission: freshWrap } = await import('./toolsAdapter.js');
    const { getCliOnlyTools: freshGetCli } = await import('@bike4mind/services/llm/tools/cliTools');
    const { PermissionManager: FreshPM } = await import('./PermissionManager.js');

    const { dir, file } = await fuzzyFile();
    const prompt = vi.fn().mockResolvedValue({ action: 'allow-once' });
    const logger = { info() {}, error() {}, warn() {}, debug() {} };
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const freshDef = (await freshGetCli()).edit_local_file as any;
    const t = freshDef.implementation({ logger, allowedDirectories: [dir] });
    const agentContext = { currentAgent: null, observationQueue: [] as Array<{ toolName: string; result: unknown }> };
    const wrapped = freshWrap(
      t,
      new FreshPM([], undefined, []),
      prompt,
      agentContext,
      {} as any,
      {} as any,
      undefined,
      [dir]
    );

    await wrapped.toolFn({ path: file, old_string: 'hello world   ', new_string: 'hi world' });

    expect(prompt).toHaveBeenCalledTimes(1);
    vi.unstubAllEnvs();
    vi.resetModules();
  });
});
