import { describe, it, expect, vi, afterEach, beforeAll } from 'vitest';
import path from 'path';
import { promises as fs, existsSync } from 'fs';
import { tmpdir } from 'os';
import { createHash } from 'crypto';
import type { ICompletionOptionTools } from '@bike4mind/llm-adapters';

// executeTool routes through ToolRouter (server/WebSocket executors). Override
// just executeTool to invoke the tool's own fn, so these tests exercise ONLY the
// permission wrapper's cleanup guard and risk-driven force-prompt - not tool
// routing. The output stage still redacts and caps around it.
vi.mock('../../llm/ToolRouter', async importOriginal => {
  const actual = await importOriginal<typeof import('../../llm/ToolRouter')>();
  return {
    ...actual,
    executeTool: vi.fn(async (_name: string, args: unknown, _api: unknown, fn: (a: unknown) => Promise<string>) =>
      fn(args)
    ),
  };
});

import { wrapToolWithPermission } from './gateway.js';
import { PermissionManager } from '../../utils/PermissionManager.js';
import { ToolCatalog } from './toolCatalog.js';
import { PermissionDeniedError } from '@bike4mind/common';
import { useCliStore } from '../../store/index.js';
import { __resetHostAllowlistCacheForTests } from './stages/hostAllowlist.js';
import { executeTool } from '../../llm/ToolRouter';
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
  const agentContext = { currentAgent: null };
  return wrapToolWithPermission(t, {
    permissionManager: pm,
    showPermissionPrompt: prompt,
    agentContext,
    configStore: {},
    apiClient: {} as any,
  });
}

afterEach(() => useCliStore.getState().setInteractionMode('normal'));

// Resolved once for the whole file - shared by the edit_local_file, create_file, and
// delete_file describe blocks below, which all drive the REAL CLI tool implementations
// (not stubs) so the gate's authorized resolve runs the same code path production uses.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let editDef: any;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let createDef: any;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let deleteDef: any;
beforeAll(async () => {
  const tools = await getCliOnlyTools();
  editDef = tools.edit_local_file;
  createDef = tools.create_file;
  deleteDef = tools.delete_file;
});

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function realTool(def: any, allowedDirectories: string[]): ICompletionOptionTools {
  const logger = { info() {}, error() {}, warn() {}, debug() {} };
  return def.implementation({ logger, allowedDirectories }) as ICompletionOptionTools;
}

describe('wrapToolWithPermission: host allowlist in claude form (mcp__<server>__*)', () => {
  const original = process.env.B4M_ALLOWED_TOOLS;
  afterEach(() => {
    if (original === undefined) delete process.env.B4M_ALLOWED_TOOLS;
    else process.env.B4M_ALLOWED_TOOLS = original;
    __resetHostAllowlistCacheForTests();
  });

  function mcpTool(name: string): ICompletionOptionTools {
    return { ...tool(name), _isMcpTool: true };
  }

  it('runs an MCP tool named <server>__<tool> without a prompt when mcp__<server>__* is allowed', async () => {
    process.env.B4M_ALLOWED_TOOLS = JSON.stringify(['mcp__host__*']);
    __resetHostAllowlistCacheForTests();
    const prompt = vi.fn();
    const wrapped = wrap(mcpTool('host__read_self'), prompt, new PermissionManager(new ToolCatalog(), [], []));

    expect(await wrapped.toolFn({})).toBe('ok');
    expect(prompt).not.toHaveBeenCalled();
  });

  it('still prompts for a non-MCP tool with the same name shape', async () => {
    process.env.B4M_ALLOWED_TOOLS = JSON.stringify(['mcp__host__*']);
    __resetHostAllowlistCacheForTests();
    const prompt = vi.fn(async () => ({ action: 'allow-once' }));
    const wrapped = wrap(tool('host__read_self'), prompt, new PermissionManager(new ToolCatalog(), [], []));

    await wrapped.toolFn({});
    expect(prompt).toHaveBeenCalledTimes(1);
  });
});

describe('wrapToolWithPermission: _sandboxCleanup guard (criterion 3)', () => {
  it('never deletes a model-supplied _sandboxCleanup path on an unsandboxed tool', async () => {
    // math_evaluate is auto_approve -> no prompt, no sandbox. A malicious model
    // arg must not reach rmSync(recursive, force). On main the wrapper passed the
    // raw arg through, so this directory was deleted.
    const dir = await fs.mkdtemp(path.join(tmpdir(), 'b4m-cleanup-'));
    const victim = path.join(dir, 'keep.txt');
    await fs.writeFile(victim, 'do not delete me');

    const prompt = vi.fn();
    const wrapped = wrap(tool('math_evaluate'), prompt, new PermissionManager(new ToolCatalog(), [], []));

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
    const wrapped = wrap(tool('write_shell_stdin'), prompt, new PermissionManager(new ToolCatalog(), [], []));

    await wrapped.toolFn({ chars: 'rm -rf ~' });

    // High command-risk overrides the auto-accept short-circuit. On main
    // write_shell_stdin was not a shell-like field, so risk stayed null and
    // auto-accept ran the destructive stdin silently.
    expect(prompt).toHaveBeenCalledTimes(1);
    expect(prompt.mock.calls[0][0]).toBe('write_shell_stdin');
  });

  it('forces the permission prompt for `rm -rf ~` even when the tool is session-trusted', async () => {
    const pm = new PermissionManager(new ToolCatalog(), [], []);
    pm.trustToolForSession('write_shell_stdin');
    const prompt = vi.fn().mockResolvedValue({ action: 'allow-once' });
    const wrapped = wrap(tool('write_shell_stdin'), prompt, pm);

    await wrapped.toolFn({ chars: 'rm -rf ~' });

    expect(prompt).toHaveBeenCalledTimes(1);
  });

  it('leaves a benign stdin on its normal (auto-accepted) path - tightening only', async () => {
    useCliStore.getState().setInteractionMode('auto-accept');
    const prompt = vi.fn().mockResolvedValue({ action: 'allow-once' });
    const wrapped = wrap(tool('write_shell_stdin'), prompt, new PermissionManager(new ToolCatalog(), [], []));

    await wrapped.toolFn({ chars: 'ls -la' });

    expect(prompt).not.toHaveBeenCalled();
  });
});

describe('wrapToolWithPermission: edit_local_file fuzzy force-prompt', () => {
  // These drive the REAL edit_local_file tool over real temp files, so the gate's
  // authorized resolve and the tool's snapshot-bound write both run - the same code
  // path production uses. editDef comes from the module-level beforeAll above.
  function realEditTool(allowedDirectories: string[]): ICompletionOptionTools {
    return realTool(editDef, allowedDirectories);
  }
  function wrapEdit(prompt: any, pm: PermissionManager, dirs: string[]): ICompletionOptionTools {
    const agentContext = { currentAgent: null };
    return wrapToolWithPermission(realEditTool(dirs), {
      permissionManager: pm,
      showPermissionPrompt: prompt,
      agentContext,
      configStore: {},
      apiClient: {} as any,
      allowedDirectories: dirs,
    });
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
    const wrapped = wrapEdit(prompt, new PermissionManager(new ToolCatalog(), [], []), [dir]);

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
    const pm = new PermissionManager(new ToolCatalog(), [], []);
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
    const autoWrapped = wrapEdit(autoPrompt, new PermissionManager(new ToolCatalog(), [], []), [a.dir]);
    await autoWrapped.toolFn({ path: a.file, old_string: 'hello world', new_string: 'hi world' });
    expect(autoPrompt).not.toHaveBeenCalled();
    expect(await fs.readFile(a.file, 'utf-8')).toBe('hi world\n');

    useCliStore.getState().setInteractionMode('normal');
    const b = await fuzzyFile();
    const pm = new PermissionManager(new ToolCatalog(), [], []);
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
    const pm = new PermissionManager(new ToolCatalog(), [], []);
    pm.trustToolForSession('edit_local_file');
    const prompt = vi.fn().mockResolvedValue({ action: 'allow-once' });
    const wrapped = wrapEdit(prompt, pm, [dir]);

    // Simulate a formatter/watcher rewriting the region AFTER the gate's exact read
    // but BEFORE the tool reads to write: mutate the file, then run the real tool.
    vi.mocked(executeTool).mockImplementationOnce(async (_name, callArgs, _api, fn) => {
      await fs.writeFile(file, 'hello   world\n');
      return (fn as (args: unknown) => Promise<string>)(callArgs);
    });
    vi.mocked(executeTool).mockImplementationOnce(
      async (_name, callArgs, _api, fn) =>
        `${await (fn as (args: unknown) => Promise<string>)(callArgs)} ${'ghp_' + 'f'.repeat(36)}`
    );

    const result = await wrapped.toolFn({ path: file, old_string: 'hello world', new_string: 'hi world' });

    expect(prompt).toHaveBeenCalledTimes(1);
    expect(await fs.readFile(file, 'utf-8')).toBe('hi world\n');
    expect(result).toContain('[REDACTED]');
    expect(result).not.toContain('ghp_');
  });

  it('strips an externally supplied gateSnapshot when the gate itself finds no match', async () => {
    // A gateSnapshot present in the raw args must never survive to the write path
    // when the gate's own resolveEditLocalFile() throws (editPlan stays null) -
    // only a gate-computed gateSnapshot, bound to a real resolveEdit() match, may
    // ever reach the write.
    const { dir, file } = await fuzzyFile();
    const pm = new PermissionManager(new ToolCatalog(), [], []);
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
          resolvedEdit: { startIndex: 0, matchedText: 'hello world', replacement: 'unexpected replacement' },
        },
      })
    ).rejects.toThrow(/not found/i);

    expect(prompt).not.toHaveBeenCalled();
    expect(await fs.readFile(file, 'utf-8')).toBe('hello world\n'); // untouched
  });

  // A model-supplied confirmedFuzzyHash must never pre-confirm a fuzzy edit: only
  // the gate and the fuzzy-confirmation retry may bind one.
  const sha256 = (content: string) => createHash('sha256').update(content, 'utf-8').digest('hex');

  it('ignores an externally supplied confirmedFuzzyHash when the gate itself finds no match', async () => {
    const { dir, file } = await fuzzyFile();
    await fs.writeFile(file, 'goodbye\n'); // gate resolve throws: no match
    const pm = new PermissionManager(new ToolCatalog(), [], []);
    pm.trustToolForSession('edit_local_file');
    const prompt = vi.fn().mockResolvedValue({ action: 'deny' });
    const wrapped = wrapEdit(prompt, pm, [dir]);

    vi.mocked(executeTool).mockImplementationOnce(async (_name, callArgs, _api, fn) => {
      await fs.writeFile(file, 'hello world\n');
      return (fn as (args: unknown) => Promise<string>)(callArgs);
    });

    await wrapped
      .toolFn({
        path: file,
        old_string: 'hello world   ',
        new_string: 'hi world',
        confirmedFuzzyHash: sha256('hello world\n'),
      })
      .catch(() => undefined);

    expect(prompt).toHaveBeenCalledTimes(1);
    expect(await fs.readFile(file, 'utf-8')).toBe('hello world\n'); // untouched
  });

  it('ignores an externally supplied confirmedFuzzyHash when the gate saw an exact match', async () => {
    const { dir, file } = await fuzzyFile();
    const pm = new PermissionManager(new ToolCatalog(), [], []);
    pm.trustToolForSession('edit_local_file');
    const prompt = vi.fn().mockResolvedValue({ action: 'deny' });
    const wrapped = wrapEdit(prompt, pm, [dir]);

    vi.mocked(executeTool).mockImplementationOnce(async (_name, callArgs, _api, fn) => {
      await fs.writeFile(file, 'hello   world\n');
      return (fn as (args: unknown) => Promise<string>)(callArgs);
    });

    await wrapped
      .toolFn({
        path: file,
        old_string: 'hello world',
        new_string: 'hi world',
        confirmedFuzzyHash: sha256('hello   world\n'),
      })
      .catch(() => undefined);

    expect(prompt).toHaveBeenCalledTimes(1);
    expect(await fs.readFile(file, 'utf-8')).toBe('hello   world\n'); // untouched
  });

  it('never force-prompts (or writes) a fuzzy edit whose path is outside the allowed directories', async () => {
    // The gate's resolve runs the SAME authorization as the tool, so an out-of-bounds
    // path is rejected before any content read - no raw-path read, no force prompt.
    // On main willEditResolveFuzzily read the raw path and force-prompted here.
    const { file } = await fuzzyFile();
    const pm = new PermissionManager(new ToolCatalog(), [], []);
    pm.trustToolForSession('edit_local_file');
    const prompt = vi.fn().mockResolvedValue({ action: 'allow-once' });
    // No allowedDirectories passed to the wrapper => the runtime grant flow is off,
    // and the temp file is outside cwd, so authorization rejects it.
    const agentContext = { currentAgent: null };
    const wrapped = wrapToolWithPermission(realEditTool([]), {
      permissionManager: pm,
      showPermissionPrompt: prompt,
      agentContext,
      configStore: {},
      apiClient: {} as any,
    });

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
    const agentContext = { currentAgent: null };
    // Untrusted + no allowedDirectories: the file is outside cwd, so it is denied,
    // but a prompt is still shown first (this is where the preview is built).
    const wrapped = wrapToolWithPermission(realEditTool([]), {
      permissionManager: new PermissionManager(new ToolCatalog(), [], []),
      showPermissionPrompt: prompt,
      agentContext,
      configStore: {},
      apiClient: {} as any,
    });
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
    const pm = new PermissionManager(new ToolCatalog(), [], []);
    pm.trustToolForSession('edit_local_file'); // main gate auto-approves; isolates grant + fuzzy prompts
    const { dir, file } = await fuzzyFile();
    const dirs: string[] = []; // shared live allow-list; the grant pushes onto it
    const prompt = vi.fn().mockResolvedValue({ action: 'allow-once' });
    const agentContext = { currentAgent: null };
    const wrapped = wrapToolWithPermission(realEditTool(dirs), {
      permissionManager: pm,
      showPermissionPrompt: prompt,
      agentContext,
      configStore: {},
      apiClient: {} as any,
      allowedDirectories: dirs,
    });

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
    const { wrapToolWithPermission: freshWrap } = await import('./gateway.js');
    const { getCliOnlyTools: freshGetCli } = await import('@bike4mind/services/llm/tools/cliTools');
    const { PermissionManager: FreshPM } = await import('../../utils/PermissionManager.js');
    const { ToolCatalog: FreshCatalog } = await import('./toolCatalog.js');

    const { dir, file } = await fuzzyFile();
    const prompt = vi.fn().mockResolvedValue({ action: 'allow-once' });
    const logger = { info() {}, error() {}, warn() {}, debug() {} };
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const freshDef = (await freshGetCli()).edit_local_file as any;
    const t = freshDef.implementation({ logger, allowedDirectories: [dir] });
    const agentContext = { currentAgent: null };
    const wrapped = freshWrap(t, {
      permissionManager: new FreshPM(new FreshCatalog(), [], []),
      showPermissionPrompt: prompt,
      agentContext,
      configStore: {},
      apiClient: {} as any,
      allowedDirectories: [dir],
    });

    await wrapped.toolFn({ path: file, old_string: 'hello world   ', new_string: 'hi world' });

    expect(prompt).toHaveBeenCalledTimes(1);
    vi.unstubAllEnvs();
    vi.resetModules();
  });
});

describe('wrapToolWithPermission: create_file / delete_file preview guard', () => {
  // The isPathAllowed guard in generateToolPreview (toolsAdapter.ts) covers create_file and
  // delete_file as well as edit_local_file. Target files are pre-created so that, without
  // the guard, the preview would take its read-and-diff / stat branch. Asserted on the
  // preview text rather than fs spies: diffPreview.ts calls through the fs/promises ESM
  // namespace, which vi.spyOn(fs.promises, ...) does not patch. createDef/deleteDef/realTool
  // come from the module-level beforeAll and helper above.

  it('previews an out-of-bounds create_file as denied WITHOUT reading the raw path (preview auth parity)', async () => {
    useCliStore.getState().setInteractionMode('normal');
    const dir = await fs.mkdtemp(path.join(tmpdir(), 'b4m-create-'));
    const file = path.join(dir, 'existing.txt');
    await fs.writeFile(file, 'do not read me\n');
    const prompt = vi.fn().mockResolvedValue({ action: 'deny' });
    // No allowedDirectories => the temp file is outside cwd, so authorization rejects it.
    const wrapped = wrap(realTool(createDef, []), prompt, new PermissionManager(new ToolCatalog(), [], []));

    await expect(wrapped.toolFn({ path: file, content: 'new content' })).rejects.toThrow();

    const preview = prompt.mock.calls[0][2] as string;
    expect(preview).toContain('Path outside allowed directories');
    expect(preview).not.toContain('do not read me'); // the existing file was never diffed
    expect(await fs.readFile(file, 'utf-8')).toBe('do not read me\n'); // untouched
  });

  it('previews an out-of-bounds delete_file as denied WITHOUT statting the raw path (preview auth parity)', async () => {
    useCliStore.getState().setInteractionMode('normal');
    const dir = await fs.mkdtemp(path.join(tmpdir(), 'b4m-delete-'));
    const file = path.join(dir, 'existing.txt');
    await fs.writeFile(file, 'do not delete me\n');
    const prompt = vi.fn().mockResolvedValue({ action: 'deny' });
    const wrapped = wrap(realTool(deleteDef, []), prompt, new PermissionManager(new ToolCatalog(), [], []));

    await expect(wrapped.toolFn({ path: file })).rejects.toThrow();

    const preview = prompt.mock.calls[0][2] as string;
    expect(preview).toContain('Path outside allowed directories');
    expect(preview).not.toContain('bytes'); // generateFileDeletePreview's size/mtime line never ran
    expect(existsSync(file)).toBe(true); // untouched
  });
});

// An earlier test calls vi.resetModules(), so the wrapper's lazy store import can resolve to a
// fresh instance; set the mode on the instance the wrapper actually reads.
async function setLiveMode(mode: 'plan' | 'normal' | 'auto-accept'): Promise<void> {
  const { useCliStore: liveStore } = await import('../../store/index.js');
  liveStore.getState().setInteractionMode(mode);
}

describe('checkpoint before a file write', () => {
  afterEach(() => setLiveMode('normal'));
  function checkpointing(t: ICompletionOptionTools, prompt: any) {
    const createCheckpoint = vi.fn().mockResolvedValue(undefined);
    const wrapped = wrapToolWithPermission(t, {
      permissionManager: new PermissionManager(new ToolCatalog(), [], []),
      showPermissionPrompt: prompt,
      agentContext: { currentAgent: null },
      configStore: {},
      apiClient: {} as any,
      checkpointStore: { createCheckpoint } as any,
    });
    return { wrapped, createCheckpoint };
  }

  it('snapshots the target after the write is approved and before it runs', async () => {
    const order: string[] = [];
    const write = tool('create_file', async () => {
      order.push('write');
      return 'File created successfully: a.ts';
    });
    const prompt = vi.fn(async () => {
      order.push('prompt');
      return { action: 'allow-once' };
    });
    const { wrapped, createCheckpoint } = checkpointing(write, prompt);
    createCheckpoint.mockImplementation(async () => {
      order.push('checkpoint');
    });

    await wrapped.toolFn({ path: 'src/a.ts', content: 'x' });

    expect(order).toEqual(['prompt', 'checkpoint', 'write']);
    expect(createCheckpoint).toHaveBeenCalledWith('create_file', ['src/a.ts'], 'before-create_file-a.ts');
  });

  it('takes no checkpoint for a denied write, and still shows the prompt', async () => {
    const prompt = vi.fn().mockResolvedValue({ action: 'deny' });
    const { wrapped, createCheckpoint } = checkpointing(tool('delete_file'), prompt);

    await expect(wrapped.toolFn({ path: 'src/a.ts' })).rejects.toThrow(PermissionDeniedError);
    expect(prompt).toHaveBeenCalledTimes(1);
    expect(createCheckpoint).not.toHaveBeenCalled();
  });

  it('takes no checkpoint for a write blocked by plan mode', async () => {
    await setLiveMode('plan');
    const write = vi.fn(async () => 'ok');
    const { wrapped, createCheckpoint } = checkpointing(tool('edit_local_file', write), vi.fn());

    const result = await wrapped.toolFn({ path: 'src/a.ts', old_string: 'a', new_string: 'b' });

    expect(result).toMatch(/blocked while plan mode is active/);
    expect(write).not.toHaveBeenCalled();
    expect(createCheckpoint).not.toHaveBeenCalled();
  });

  it('snapshots a write the auto-accept mode approves without a prompt', async () => {
    await setLiveMode('auto-accept');
    const prompt = vi.fn();
    const { wrapped, createCheckpoint } = checkpointing(tool('create_file'), prompt);

    await wrapped.toolFn({ path: 'src/a.ts', content: 'x' });

    expect(prompt).not.toHaveBeenCalled();
    expect(createCheckpoint).toHaveBeenCalledWith('create_file', ['src/a.ts'], 'before-create_file-a.ts');
  });

  it('takes no checkpoint for a write with no usable path', async () => {
    const { wrapped, createCheckpoint } = checkpointing(
      tool('create_file'),
      vi.fn().mockResolvedValue({ action: 'allow-once' })
    );

    await wrapped.toolFn({ path: '' });

    expect(createCheckpoint).not.toHaveBeenCalled();
  });

  it('still writes when the checkpoint fails', async () => {
    const write = vi.fn(async () => 'File created successfully: a.ts');
    const { wrapped, createCheckpoint } = checkpointing(
      tool('create_file', write),
      vi.fn().mockResolvedValue({ action: 'allow-once' })
    );
    createCheckpoint.mockRejectedValue(new Error('disk full'));

    await wrapped.toolFn({ path: 'src/a.ts', content: 'x' });

    expect(write).toHaveBeenCalled();
  });

  it('does not checkpoint a tool that does not write a file', async () => {
    const { wrapped, createCheckpoint } = checkpointing(
      tool('file_read'),
      vi.fn().mockResolvedValue({ action: 'allow-once' })
    );

    await wrapped.toolFn({ path: 'src/a.ts' });

    expect(createCheckpoint).not.toHaveBeenCalled();
  });
});

describe('session bookkeeping and delegation tools', () => {
  afterEach(() => setLiveMode('normal'));

  it('blocks a writing tool in the same plan-mode setup (control)', async () => {
    await setLiveMode('plan');
    const wrapped = wrap(tool('bash_execute'), vi.fn(), new PermissionManager(new ToolCatalog(), [], []));

    expect(await wrapped.toolFn({ command: 'ls' })).toMatch(/blocked while plan mode is active/);
  });

  it.each(['agent_delegate', 'write_todos', 'shared_context_write', 'tool_search'])(
    'runs %s without a prompt, in plan mode too',
    async name => {
      await setLiveMode('plan');
      const prompt = vi.fn();
      const wrapped = wrap(tool(name), prompt, new PermissionManager(new ToolCatalog(), [], []));

      expect(await wrapped.toolFn({})).toBe('ok');
      expect(prompt).not.toHaveBeenCalled();
    }
  );

  it('prompts for one the project has denied', async () => {
    const prompt = vi.fn().mockResolvedValue({ action: 'deny' });
    const wrapped = wrap(
      tool('agent_delegate'),
      prompt,
      new PermissionManager(new ToolCatalog(), [], ['agent_delegate'])
    );

    await expect(wrapped.toolFn({})).rejects.toThrow();
    expect(prompt).toHaveBeenCalledTimes(1);
  });
});

describe('wrapToolWithPermission: session approval scope', () => {
  function allowSessionOnce() {
    return vi.fn().mockResolvedValueOnce({ action: 'allow-session' }).mockResolvedValue({ action: 'allow-once' });
  }

  it('covers later runs of the approved subcommand and asks for anything else', async () => {
    const pm = new PermissionManager(new ToolCatalog(), [], []);
    const prompt = allowSessionOnce();
    const wrapped = wrap(tool('bash_execute'), prompt, pm);

    await wrapped.toolFn({ command: 'git status' });
    await wrapped.toolFn({ command: 'git status -s' });
    expect(prompt).toHaveBeenCalledTimes(1);

    await wrapped.toolFn({ command: 'git log' });
    expect(prompt).toHaveBeenCalledTimes(2);
    await wrapped.toolFn({ command: 'curl https://example.com' });
    expect(prompt).toHaveBeenCalledTimes(3);
    await wrapped.toolFn({ command: 'git rebase -x true main' });
    expect(prompt).toHaveBeenCalledTimes(4);
    expect(prompt.mock.calls[3][4]).toEqual({ sessionScope: null });
    expect(pm.isSessionTrusted('bash_execute')).toBe(false);
  });

  it('covers an approved test script with extra args but not another script', async () => {
    const pm = new PermissionManager(new ToolCatalog(), [], []);
    const prompt = allowSessionOnce();
    const wrapped = wrap(tool('bash_execute'), prompt, pm);

    await wrapped.toolFn({ command: 'npm test' });
    await wrapped.toolFn({ command: 'npm test -- --watch=false' });
    expect(prompt).toHaveBeenCalledTimes(1);

    await wrapped.toolFn({ command: 'npm run x' });
    expect(prompt).toHaveBeenCalledTimes(2);
    expect(prompt.mock.calls[1][4]).toEqual({ sessionScope: null });
  });

  it.each([
    'sed -i s/a/b/ f',
    'cp a .git/hooks/pre-commit',
    'find . -delete',
    "awk 'BEGIN{}'",
    'Git status',
    'npm create x',
  ])('offers no session option for %j', async command => {
    const prompt = vi.fn().mockResolvedValue({ action: 'allow-once' });
    const wrapped = wrap(tool('bash_execute'), prompt, new PermissionManager(new ToolCatalog(), [], []));

    await wrapped.toolFn({ command });

    expect(prompt.mock.calls[0][4]).toEqual({ sessionScope: null });
  });

  it('asks when an approved command is chained with another command', async () => {
    const pm = new PermissionManager(new ToolCatalog(), [], []);
    pm.trustCommandForSession('bash_execute', 'git status');
    const prompt = vi.fn().mockResolvedValue({ action: 'allow-once' });
    const wrapped = wrap(tool('bash_execute'), prompt, pm);

    for (const command of [
      'git status && rm notes.txt',
      'git status; touch x',
      'git status | sh',
      'git status\ntouch x',
      'for f in *; do git status; done',
    ]) {
      await wrapped.toolFn({ command });
    }

    expect(prompt).toHaveBeenCalledTimes(5);
  });

  it('asks for an outbound or high-risk command even when its scope was approved', async () => {
    const pm = new PermissionManager(new ToolCatalog(), [], []);
    pm.trustCommandForSession('bash_execute', 'ls');
    const prompt = vi.fn().mockResolvedValue({ action: 'allow-session' });
    const wrapped = wrap(tool('bash_execute'), prompt, pm);

    await wrapped.toolFn({ command: 'git push origin main' });
    await wrapped.toolFn({ command: 'git push origin main' });
    await wrapped.toolFn({ command: 'ls | xargs curl https://example.com' });

    expect(prompt).toHaveBeenCalledTimes(3);
  });

  it('passes the scope the session option would remember to the prompt', async () => {
    const pm = new PermissionManager(new ToolCatalog(), [], []);
    const prompt = vi.fn().mockResolvedValue({ action: 'allow-once' });
    const wrapped = wrap(tool('bash_execute'), prompt, pm);

    await wrapped.toolFn({ command: 'git status | head' });
    await wrapped.toolFn({ command: 'curl https://example.com' });

    expect(prompt.mock.calls[0][4]).toEqual({ sessionScope: ['git status', 'head'] });
    expect(prompt.mock.calls[1][4]).toEqual({ sessionScope: null });
  });

  it('never remembers shell stdin for the session', async () => {
    const pm = new PermissionManager(new ToolCatalog(), [], []);
    const prompt = vi.fn().mockResolvedValue({ action: 'allow-session' });
    const wrapped = wrap(tool('write_shell_stdin'), prompt, pm);

    await wrapped.toolFn({ chars: 'ls' });
    await wrapped.toolFn({ chars: 'ls' });

    expect(prompt).toHaveBeenCalledTimes(2);
    expect(prompt.mock.calls[0][4]).toEqual({ sessionScope: null });
  });

  it('keeps whole-tool session trust for a tool without a command', async () => {
    const pm = new PermissionManager(new ToolCatalog(), [], []);
    const prompt = allowSessionOnce();
    const wrapped = wrap(tool('git_commit'), prompt, pm);

    await wrapped.toolFn({ message: 'first' });
    await wrapped.toolFn({ message: 'second' });

    expect(prompt).toHaveBeenCalledTimes(1);
    expect(prompt.mock.calls[0][4]).toEqual({ sessionScope: undefined });
    expect(pm.isSessionTrusted('git_commit')).toBe(true);
  });
});
