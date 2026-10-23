/**
 * Wrapper-level tests for the gateway's sandbox pre-step, file-change notification and tool
 * routing, driven through wrapToolWithPermission with stub collaborators.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import path from 'path';
import { promises as fs, existsSync } from 'fs';
import { tmpdir } from 'os';
import type { ICompletionOptionTools } from '@bike4mind/llm-adapters';
import type { ConfigStore } from '../../storage/ConfigStore.js';
import type { PermissionManager } from '../../utils/PermissionManager.js';
import type { ApiClient } from '../../auth/ApiClient.js';
import type { SandboxOrchestrator } from '../../sandbox/SandboxOrchestrator.js';
import { useCliStore } from '../../store/index.js';
import { PermissionManager as RealPermissionManager } from '../../utils/PermissionManager.js';
import { ToolCatalog } from './toolCatalog.js';
import { wrapToolWithPermission, wrapTools } from './gateway.js';

function createMockTool(name: string, fn?: (args: unknown) => Promise<string>): ICompletionOptionTools {
  return {
    toolFn: fn ?? vi.fn().mockResolvedValue('tool result'),
    toolSchema: {
      name,
      description: `Mock ${name} tool`,
      parameters: {
        type: 'object',
        properties: {
          input: { type: 'string', description: 'Test input' },
        },
        required: ['input'],
      },
    },
  };
}

describe('wrapToolWithPermission sandbox cwd confinement', () => {
  const noopPrompt = vi.fn(async () => ({ action: 'allow-session' as const }));

  function createOrchestrator() {
    return {
      shouldSandbox: vi.fn(() => ({
        type: 'sandbox',
        wrappedCommand: { commandString: 'sandboxed-command', cleanupPaths: [] },
      })),
      recordBlocked: vi.fn(),
      recordSandboxed: vi.fn(),
      recordUnsandboxed: vi.fn(),
      recordViolation: vi.fn().mockResolvedValue(undefined),
    } as unknown as SandboxOrchestrator;
  }

  function wrap(orchestrator: SandboxOrchestrator, allowedDirectories?: string[]) {
    const toolFn = vi.fn().mockResolvedValue('ok');
    const tool = createMockTool('bash_execute', toolFn);
    const permissionManager = {
      catalog: new ToolCatalog(),
      needsPermission: vi.fn(() => false),
      trustToolForSession: vi.fn(),
      trustCommandForSession: vi.fn(),
      isCommandScoped: vi.fn(() => true),
      sessionScopeFor: vi.fn(() => null),
    } as unknown as PermissionManager;
    const agentContext = { currentAgent: null };
    const wrapped = wrapToolWithPermission(tool, {
      permissionManager,
      showPermissionPrompt: noopPrompt,
      agentContext,
      configStore: {},
      apiClient: {} as ApiClient,
      sandboxOrchestrator: orchestrator,
      allowedDirectories,
    });
    return { wrapped, toolFn };
  }

  it('blocks a cwd outside the workspace and never runs the command', async () => {
    const orchestrator = createOrchestrator();
    const outside = path.join(path.parse(process.cwd()).root, 'definitely-outside-workspace');
    const { wrapped, toolFn } = wrap(orchestrator, []);

    const result = await wrapped.toolFn({ command: 'ls', cwd: outside });

    expect(result).toContain('Command blocked by sandbox');
    expect(orchestrator.recordBlocked).toHaveBeenCalledTimes(1);
    expect(orchestrator.recordSandboxed).not.toHaveBeenCalled();
    expect(toolFn).not.toHaveBeenCalled();
  });

  it('sandboxes and runs an in-workspace cwd', async () => {
    const orchestrator = createOrchestrator();
    const { wrapped, toolFn } = wrap(orchestrator, []);

    const result = await wrapped.toolFn({ command: 'ls' });

    expect(result).toBe('ok');
    expect(orchestrator.recordSandboxed).toHaveBeenCalledTimes(1);
    expect(orchestrator.recordBlocked).not.toHaveBeenCalled();
    expect(toolFn).toHaveBeenCalledTimes(1);
  });

  it('sandboxes a cwd granted via allowedDirectories', async () => {
    const orchestrator = createOrchestrator();
    const granted = path.join(path.parse(process.cwd()).root, 'granted-dir');
    const { wrapped, toolFn } = wrap(orchestrator, [granted]);

    await wrapped.toolFn({ command: 'ls', cwd: granted });

    expect(orchestrator.recordSandboxed).toHaveBeenCalledTimes(1);
    expect(orchestrator.recordBlocked).not.toHaveBeenCalled();
    expect(toolFn).toHaveBeenCalledTimes(1);
  });

  it('rejects a symlinked cwd that realpath-resolves outside the workspace', async () => {
    // A symlink inside an allowed dir that points outside must not let the sandbox
    // bind a writable root outside the workspace: realpathSync(cwd) resolves the link
    // before the allow-list check, so confinement is on the real target, not the lexical path.
    const orchestrator = createOrchestrator();
    const workspace = await fs.realpath(await fs.mkdtemp(path.join(tmpdir(), 'b4m-ws-')));
    const outside = await fs.realpath(await fs.mkdtemp(path.join(tmpdir(), 'b4m-out-')));
    const link = path.join(workspace, 'escape');
    await fs.symlink(outside, link);
    const { wrapped, toolFn } = wrap(orchestrator, [workspace]);

    const result = await wrapped.toolFn({ command: 'ls', cwd: link });

    expect(result).toContain('outside the sandbox writable root');
    expect(orchestrator.recordBlocked).toHaveBeenCalledTimes(1);
    expect(toolFn).not.toHaveBeenCalled();
  });

  // Point shouldSandbox at a real temp file standing in for the Seatbelt .sb
  // profile, so cleanup is observable via the filesystem rather than a bare [].
  async function orchestratorWithProfile(): Promise<{ orchestrator: SandboxOrchestrator; profile: string }> {
    const orchestrator = createOrchestrator();
    const profile = path.join(await fs.mkdtemp(path.join(tmpdir(), 'b4m-sb-')), 'sandbox.sb');
    await fs.writeFile(profile, '(version 1)');
    (orchestrator.shouldSandbox as ReturnType<typeof vi.fn>).mockReturnValue({
      type: 'sandbox',
      wrappedCommand: { commandString: 'sandboxed-command', cleanupPaths: [profile] },
    });
    return { orchestrator, profile };
  }

  it('cleans up the temp profile and records a violation when cwd is rejected', async () => {
    const { orchestrator, profile } = await orchestratorWithProfile();
    const outside = path.join(path.parse(process.cwd()).root, 'definitely-outside-workspace');
    const { wrapped, toolFn } = wrap(orchestrator, []);

    const result = await wrapped.toolFn({ command: 'ls', cwd: outside });

    expect(result).toContain('outside the sandbox writable root');
    expect(existsSync(profile)).toBe(false); // profile not leaked on the reject path
    expect(orchestrator.recordViolation).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'filesystem', blockedBy: 'config' })
    );
    expect(toolFn).not.toHaveBeenCalled();
  });

  afterEach(() => {
    useCliStore.setState({ interactionMode: 'normal' });
  });

  // Each success-path return MUST `await executeAndRecord()` inside the try/finally.
  // A bare `return <promise>` runs the finally synchronously at the return, rmSync'ing
  // the .sb profile before the spawned sandbox-exec opens it - breaking every sandboxed
  // macOS command. This drives the profile-present check through a given branch; the
  // `await Promise.resolve()` models the async gap (the real profile read is a tick
  // after the spawn), so reverting that branch's `await` turns the test red.
  async function assertProfileSurvivesRun(wrapFn: typeof wrapToolWithPermission, needsPermission: boolean) {
    const { orchestrator, profile } = await orchestratorWithProfile();
    let profilePresentDuringRun: boolean | null = null;
    const toolFn = vi.fn(async () => {
      await Promise.resolve();
      profilePresentDuringRun = existsSync(profile);
      return 'ok';
    });
    const permissionManager = {
      catalog: new ToolCatalog(),
      needsPermission: vi.fn(() => needsPermission),
      trustToolForSession: vi.fn(),
      trustCommandForSession: vi.fn(),
      isCommandScoped: vi.fn(() => true),
      sessionScopeFor: vi.fn(() => null),
    } as unknown as PermissionManager;
    const agentContext = { currentAgent: null };
    const wrapped = wrapFn(createMockTool('bash_execute', toolFn), {
      permissionManager,
      showPermissionPrompt: noopPrompt,
      agentContext,
      configStore: {},
      apiClient: {} as ApiClient,
      sandboxOrchestrator: orchestrator,
      allowedDirectories: [],
    });

    const result = await wrapped.toolFn({ command: 'ls' });

    expect(result).toBe('ok');
    expect(profilePresentDuringRun).toBe(true); // present while the command ran
    expect(existsSync(profile)).toBe(false); // cleaned up afterwards
    expect(toolFn).toHaveBeenCalledTimes(1);
  }

  it('profile survives the run: trusted / needs-no-permission branch', async () => {
    await assertProfileSurvivesRun(wrapToolWithPermission, false);
  });

  it('profile survives the run: prompt-allow branch', async () => {
    // needsPermission true + noopPrompt returns allow-session -> falls through to the
    // final return await after the prompt.
    await assertProfileSurvivesRun(wrapToolWithPermission, true);
  });

  it('profile survives the run: auto-accept branch', async () => {
    useCliStore.setState({ interactionMode: 'auto-accept' });
    await assertProfileSurvivesRun(wrapToolWithPermission, true);
  });

  it('profile survives the run: host-allowlist branch', async () => {
    // The allowlist patterns are read from a module-cached env, so exercise this
    // branch in a fresh module instance with the tool allowlisted; restore after.
    process.env.B4M_ALLOWED_TOOLS = JSON.stringify(['bash_execute']);
    vi.resetModules();
    try {
      const fresh = await import('./gateway.js');
      await assertProfileSurvivesRun(fresh.wrapToolWithPermission, false);
    } finally {
      delete process.env.B4M_ALLOWED_TOOLS;
      vi.resetModules();
    }
  });

  it('hands execution the realpath-resolved cwd, not the lexical symlink path', async () => {
    // Pins the writable-root threading: without `cwd,` in sandboxedArgs the tool would
    // run in the unresolved (symlinked) path, diverging from the profile's baked root.
    const orchestrator = createOrchestrator();
    const workspace = await fs.realpath(await fs.mkdtemp(path.join(tmpdir(), 'b4m-ws-')));
    const realTarget = path.join(workspace, 'real');
    await fs.mkdir(realTarget);
    const link = path.join(workspace, 'link');
    await fs.symlink(realTarget, link);
    const { wrapped, toolFn } = wrap(orchestrator, [workspace]);

    await wrapped.toolFn({ command: 'ls', cwd: link });

    expect(realTarget).not.toBe(link); // the resolved path really differs from the lexical one
    expect(orchestrator.recordSandboxed).toHaveBeenCalledTimes(1);
    expect(toolFn).toHaveBeenCalledWith(expect.objectContaining({ cwd: realTarget, command: 'sandboxed-command' }));
  });

  it('records a blocked decision as a violation and never runs the command', async () => {
    const orchestrator = createOrchestrator();
    (orchestrator.shouldSandbox as ReturnType<typeof vi.fn>).mockReturnValue({
      type: 'blocked',
      reason: 'excluded command',
    });
    const { wrapped, toolFn } = wrap(orchestrator, []);

    const result = await wrapped.toolFn({ command: 'docker run x' });

    expect(result).toContain('Command blocked by sandbox: excluded command');
    expect(orchestrator.recordBlocked).toHaveBeenCalledTimes(1);
    expect(orchestrator.recordViolation).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'filesystem', blockedBy: 'config' })
    );
    expect(orchestrator.recordSandboxed).not.toHaveBeenCalled();
    expect(toolFn).not.toHaveBeenCalled();
  });

  it('cleans up the temp profile on the happy path', async () => {
    const { orchestrator, profile } = await orchestratorWithProfile();
    const { wrapped, toolFn } = wrap(orchestrator, []);

    await wrapped.toolFn({ command: 'ls' });

    expect(existsSync(profile)).toBe(false);
    expect(toolFn).toHaveBeenCalledTimes(1);
  });
});

describe('wrapToolWithPermission sandbox escalation', () => {
  const EPERM_RESULT = 'touch: /etc/hosts: Operation not permitted\nExit code: 1';

  afterEach(async () => {
    const { useCliStore: liveStore } = await import('../../store/index.js');
    liveStore.setState({ interactionMode: 'normal' });
  });

  async function setup(options: { sandboxAutoAllow?: boolean; permissionManager?: PermissionManager } = {}) {
    const profile = path.join(await fs.mkdtemp(path.join(tmpdir(), 'b4m-sb-')), 'sandbox.sb');
    await fs.writeFile(profile, '(version 1)');
    const orchestrator = {
      shouldSandbox: vi.fn(() => ({
        type: 'sandbox',
        wrappedCommand: { commandString: 'sandboxed-command', cleanupPaths: [profile] },
      })),
      getConfig: () => ({ allowUnsandboxedCommands: true }),
      recordBlocked: vi.fn(),
      recordSandboxed: vi.fn(),
      recordUnsandboxed: vi.fn(),
      recordViolation: vi.fn().mockResolvedValue(undefined),
    } as unknown as SandboxOrchestrator;
    const permissionManager = options.permissionManager ?? new RealPermissionManager(new ToolCatalog());
    if (options.sandboxAutoAllow ?? true)
      (permissionManager as RealPermissionManager).setSandboxState('auto-allow', true);
    const profileStillThereOnRetry: boolean[] = [];
    const toolFn = vi.fn(async (args: unknown): Promise<string> => {
      const { command } = args as { command: string };
      if (command === 'sandboxed-command') return EPERM_RESULT;
      profileStillThereOnRetry.push(existsSync(profile));
      return 'done';
    });
    const showPermissionPrompt = vi.fn(async (..._args: unknown[]) => ({ action: 'allow-once' as const }));
    const wrapped = wrapToolWithPermission(createMockTool('bash_execute', toolFn), {
      permissionManager,
      showPermissionPrompt,
      agentContext: { currentAgent: null },
      configStore: {},
      apiClient: {} as ApiClient,
      sandboxOrchestrator: orchestrator,
      allowedDirectories: [],
    });
    return {
      wrapped,
      toolFn,
      showPermissionPrompt,
      orchestrator,
      permissionManager,
      profile,
      profileStillThereOnRetry,
    };
  }

  it('asks as its own question after a denial, then retries the original command unsandboxed', async () => {
    const { wrapped, toolFn, showPermissionPrompt, orchestrator, profileStillThereOnRetry } = await setup();

    await expect(wrapped.toolFn({ command: 'touch /etc/hosts' })).resolves.toBe('done');

    expect(showPermissionPrompt).toHaveBeenCalledTimes(1);
    expect(showPermissionPrompt.mock.calls[0][3]).toBe('sandbox-escalation');
    expect(toolFn).toHaveBeenNthCalledWith(1, expect.objectContaining({ command: 'sandboxed-command' }));
    expect(toolFn).toHaveBeenNthCalledWith(2, expect.objectContaining({ command: 'touch /etc/hosts' }));
    expect(orchestrator.recordUnsandboxed).toHaveBeenCalledTimes(1);
    // The retry runs before the profile is cleaned up in the wrapper's finally.
    expect(profileStillThereOnRetry).toEqual([true]);
  });

  it('still asks in auto-accept mode', async () => {
    // The gateway imports the store lazily; an earlier test resets the module registry, so set
    // the mode on the instance the gateway will see.
    const { useCliStore: liveStore } = await import('../../store/index.js');
    liveStore.setState({ interactionMode: 'auto-accept' });
    const { wrapped, showPermissionPrompt } = await setup({ sandboxAutoAllow: false });

    await wrapped.toolFn({ command: 'touch notes.txt' });

    expect(showPermissionPrompt.mock.calls.map(call => call[3])).toEqual(['sandbox-escalation']);
  });

  it('still asks when the tool is trusted for the session', async () => {
    const { wrapped, showPermissionPrompt, permissionManager } = await setup();
    (permissionManager as RealPermissionManager).trustToolForSession('bash_execute');

    await wrapped.toolFn({ command: 'touch /etc/hosts' });

    expect(showPermissionPrompt).toHaveBeenCalledTimes(1);
  });

  it('redacts both runs: the denial the prompt shows and the unsandboxed retry the model gets', async () => {
    const token = 'ghp_' + 'c'.repeat(36);
    const { wrapped, toolFn, showPermissionPrompt } = await setup();
    toolFn.mockImplementation(async (args: unknown) =>
      (args as { command: string }).command === 'sandboxed-command'
        ? `touch: ${token}: Operation not permitted\nExit code: 1`
        : `wrote ${token}`
    );

    const result = await wrapped.toolFn({ command: 'touch /etc/hosts' });

    const preview = String(showPermissionPrompt.mock.calls[0][2]);
    expect(preview).toContain('Operation not permitted');
    expect(preview).not.toContain(token);
    expect(result).toBe('wrote [REDACTED]');
  });

  it('returns the sandbox error when denied, and runs nothing unsandboxed', async () => {
    const { wrapped, toolFn, showPermissionPrompt } = await setup();
    showPermissionPrompt.mockResolvedValueOnce({ action: 'deny' as never });

    const result = await wrapped.toolFn({ command: 'touch /etc/hosts' });

    expect(result).toContain(EPERM_RESULT);
    expect(toolFn).toHaveBeenCalledTimes(1);
  });

  it('allow-session skips the second prompt for the same command', async () => {
    const { wrapped, showPermissionPrompt } = await setup();
    showPermissionPrompt.mockResolvedValueOnce({ action: 'allow-session' as never });

    await wrapped.toolFn({ command: 'touch /etc/hosts' });
    await wrapped.toolFn({ command: 'touch /etc/hosts' });

    expect(showPermissionPrompt).toHaveBeenCalledTimes(1);
  });

  it('shares the approval with another wrapped tool on the same permission manager', async () => {
    const first = await setup();
    first.showPermissionPrompt.mockResolvedValueOnce({ action: 'allow-session' as never });
    await first.wrapped.toolFn({ command: 'touch /etc/hosts' });

    const second = await setup({ permissionManager: first.permissionManager });
    await second.wrapped.toolFn({ command: 'touch /etc/hosts' });

    expect(second.showPermissionPrompt).not.toHaveBeenCalled();
  });

  it('cleans up the temp profile after the sandboxed attempt and the retry', async () => {
    const { wrapped, profile } = await setup();

    await wrapped.toolFn({ command: 'touch /etc/hosts' });

    expect(existsSync(profile)).toBe(false);
  });
});

describe('wrapToolWithPermission file-change notification', () => {
  const noopPrompt = vi.fn(async () => ({ action: 'allow-session' as const }));

  function wrap(toolName: string, toolResult: string) {
    const tool = createMockTool(toolName, vi.fn().mockResolvedValue(toolResult));
    const permissionManager = {
      catalog: new ToolCatalog(),
      needsPermission: vi.fn(() => false),
      trustToolForSession: vi.fn(),
      trustCommandForSession: vi.fn(),
      isCommandScoped: vi.fn(() => true),
      sessionScopeFor: vi.fn(() => null),
    } as unknown as PermissionManager;
    const onFileChanged = vi.fn();
    const agentContext = { currentAgent: null, onFileChanged };
    const wrapped = wrapToolWithPermission(tool, {
      permissionManager,
      showPermissionPrompt: noopPrompt,
      agentContext,
      configStore: {},
      apiClient: {} as ApiClient,
    });
    return { wrapped, onFileChanged };
  }

  it.each([
    ['create_file', 'File created successfully: src/a.ts\nSize: 10 bytes\nLines: 1'],
    ['create_file', 'File overwritten successfully: src/a.ts\nSize: 10 bytes\nLines: 1'],
  ])('notifies with the tool path after a successful %s', async (toolName, toolResult) => {
    const { wrapped, onFileChanged } = wrap(toolName, toolResult);

    await wrapped.toolFn({ path: 'src/a.ts', content: 'x' });

    expect(onFileChanged).toHaveBeenCalledWith('src/a.ts');
  });

  it('does not notify when the write tool returns a non-success result', async () => {
    const { wrapped, onFileChanged } = wrap('create_file', 'Error: File already exists');

    await wrapped.toolFn({ path: 'src/a.ts', content: 'x' });

    expect(onFileChanged).not.toHaveBeenCalled();
  });

  it('does not notify after a successful delete_file', async () => {
    const { wrapped, onFileChanged } = wrap('delete_file', 'File deleted successfully: src/a.ts');

    await wrapped.toolFn({ path: 'src/a.ts' });

    expect(onFileChanged).not.toHaveBeenCalled();
  });

  it('does not notify for tools that do not write files', async () => {
    const { wrapped, onFileChanged } = wrap('file_read', 'File created successfully: looks like a write');

    await wrapped.toolFn({ path: 'src/a.ts' });

    expect(onFileChanged).not.toHaveBeenCalled();
  });
});

describe('wrapTools with the real tool router', () => {
  it('runs a wrapped MCP tool instead of failing it as an unknown tool', async () => {
    const mcpTool = {
      toolFn: vi.fn(async () => 'pong'),
      toolSchema: { name: 'mcp__demo__ping', description: 'Ping', parameters: { type: 'object', properties: {} } },
    } as unknown as ICompletionOptionTools;
    const [wrapped] = wrapTools([mcpTool], {
      permissionManager: {
        catalog: new ToolCatalog(),
        needsPermission: () => false,
        isDenied: () => false,
      } as unknown as PermissionManager,
      showPermissionPrompt: vi.fn(),
      agentContext: {} as never,
      configStore: {} as ConfigStore,
      apiClient: {} as ApiClient,
      allowedDirectories: [process.cwd()],
    });
    await expect(wrapped.toolFn({})).resolves.toBe('pong');
    expect(mcpTool.toolFn).toHaveBeenCalledTimes(1);
  });
});

describe('gateway output stage with the real tool router', () => {
  function wrapAutoApproved(toolFn: () => Promise<string>): ICompletionOptionTools {
    return wrapToolWithPermission(createMockTool('math_evaluate', toolFn), {
      permissionManager: new RealPermissionManager(new ToolCatalog()),
      showPermissionPrompt: vi.fn(),
      agentContext: { currentAgent: null },
      configStore: {},
      apiClient: {} as ApiClient,
    });
  }

  it('redacts then caps what the tool returns', async () => {
    const token = 'ghp_' + 'd'.repeat(36);
    const wrapped = wrapAutoApproved(async () => `${token} ${'x'.repeat(200_000)}`);

    const result = await wrapped.toolFn({});

    expect(result.startsWith('[REDACTED] ')).toBe(true);
    expect(result).toContain('[output truncated:');
    expect(result.length).toBeLessThan(101_000);
  });

  it('redacts what the tool throws', async () => {
    const token = 'ghp_' + 'e'.repeat(36);
    const wrapped = wrapAutoApproved(async () => {
      throw new Error(`rejected ${token}`);
    });

    await expect(wrapped.toolFn({})).rejects.toThrow('rejected [REDACTED]');
  });
});
