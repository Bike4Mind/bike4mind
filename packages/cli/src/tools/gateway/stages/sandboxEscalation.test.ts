import { describe, it, expect, vi } from 'vitest';
import type { SandboxOrchestrator } from '../../../sandbox/SandboxOrchestrator.js';
import { PermissionManager } from '../../../utils/PermissionManager.js';
import type { PermissionResponse } from '../../../components/PermissionPrompt.js';
import { CORE_TOOL_DESCRIPTORS } from '../coreToolDescriptors.js';
import { ToolCatalog } from '../toolCatalog.js';
import { detectSandboxDenial, runSandboxed } from './sandboxEscalation.js';

const EPERM_RESULT = 'touch: /etc/hosts: Operation not permitted\nExit code: 1';

describe('detectSandboxDenial', () => {
  it('is null when the command was not sandboxed', () => {
    expect(detectSandboxDenial(false, 'sandbox-exec: deny(1) file-write-data /x')).toBeNull();
    expect(detectSandboxDenial(false, EPERM_RESULT)).toBeNull();
  });

  it('treats a launcher marker alone as a denial', () => {
    expect(detectSandboxDenial(true, 'sandbox-exec: deny(1) file-write-data /x')).toMatchObject({ reason: 'launcher' });
    expect(detectSandboxDenial(true, 'bwrap: Creating new namespace failed')).toMatchObject({ reason: 'launcher' });
  });

  it('treats EPERM with a non-zero exit code as a denial', () => {
    expect(detectSandboxDenial(true, EPERM_RESULT)).toMatchObject({ reason: 'eperm' });
    expect(
      detectSandboxDenial(true, 'curl: (7) Failed to connect: Operation not permitted\nExit code: 7')
    ).toMatchObject({ reason: 'eperm' });
  });

  it('ignores EPERM text when the command exited 0 or reported no exit code', () => {
    expect(detectSandboxDenial(true, 'kill: 1: Operation not permitted\nExit code: 0')).toBeNull();
    expect(detectSandboxDenial(true, 'kill: 1: Operation not permitted')).toBeNull();
  });

  it('returns null for ordinary output', () => {
    expect(detectSandboxDenial(true, 'file.txt\nExit code: 0')).toBeNull();
  });

  it('caps the snippet', () => {
    const denial = detectSandboxDenial(true, `bwrap: ${'x'.repeat(500)}`);
    expect(denial?.snippet).toHaveLength(200);
  });
});

describe('runSandboxed', () => {
  const descriptor = CORE_TOOL_DESCRIPTORS.get('bash_execute');
  const RESOLVED_CWD = '/real/workspace';

  type Options = {
    command?: string;
    results?: string[];
    answer?: PermissionResponse;
    allowUnsandboxedCommands?: boolean;
    extraArgs?: Record<string, unknown>;
    permissionManager?: PermissionManager;
    isSandboxed?: boolean;
  };

  function setup(options: Options = {}) {
    const command = options.command ?? 'touch /etc/hosts';
    const results = options.results ?? [EPERM_RESULT, 'done'];
    const attempt = vi.fn(async () => results[Math.min(attempt.mock.calls.length - 1, results.length - 1)]);
    const showPermissionPrompt = vi.fn(async () => ({
      action: options.answer ?? ('allow-once' as PermissionResponse),
    }));
    const sandboxOrchestrator = {
      getConfig: () => ({ allowUnsandboxedCommands: options.allowUnsandboxedCommands ?? true }),
      recordUnsandboxed: vi.fn(),
      recordViolation: vi.fn().mockResolvedValue(undefined),
    } as unknown as SandboxOrchestrator & { recordUnsandboxed: ReturnType<typeof vi.fn> };
    const permissionManager = options.permissionManager ?? new PermissionManager(new ToolCatalog());
    const run = () =>
      runSandboxed({
        toolName: 'bash_execute',
        descriptor,
        rawArgs: { command, cwd: './link', ...options.extraArgs },
        execArgs: { command: `sandbox-exec ${command}`, cwd: RESOLVED_CWD, ...options.extraArgs },
        isSandboxed: options.isSandboxed ?? true,
        attempt,
        permissionManager,
        showPermissionPrompt,
        sandboxOrchestrator,
      });
    return { run, attempt, showPermissionPrompt, sandboxOrchestrator, permissionManager };
  }

  it('returns a clean sandboxed result without prompting', async () => {
    const { run, attempt, showPermissionPrompt } = setup({ results: ['ok\nExit code: 0'] });
    await expect(run()).resolves.toBe('ok\nExit code: 0');
    expect(attempt).toHaveBeenCalledTimes(1);
    expect(showPermissionPrompt).not.toHaveBeenCalled();
  });

  it('never escalates a call that was not sandboxed', async () => {
    const { run, showPermissionPrompt } = setup({ isSandboxed: false });
    await expect(run()).resolves.toBe(EPERM_RESULT);
    expect(showPermissionPrompt).not.toHaveBeenCalled();
  });

  it('asks as a sandbox-escalation and retries unsandboxed with the original command and resolved cwd', async () => {
    const { run, attempt, showPermissionPrompt, sandboxOrchestrator } = setup();

    await expect(run()).resolves.toBe('done');

    expect(showPermissionPrompt).toHaveBeenCalledWith(
      'bash_execute',
      expect.objectContaining({ command: 'touch /etc/hosts' }),
      expect.stringContaining('SANDBOX BLOCKED'),
      'sandbox-escalation'
    );
    expect(attempt).toHaveBeenCalledTimes(2);
    expect(attempt).toHaveBeenLastCalledWith(
      expect.objectContaining({ command: 'touch /etc/hosts', cwd: RESOLVED_CWD })
    );
    expect(sandboxOrchestrator.recordUnsandboxed).toHaveBeenCalledTimes(1);
  });

  it('returns the original result with the network tip when denied, and does not retry', async () => {
    const { run, attempt } = setup({ answer: 'deny' });
    const result = await run();
    expect(result).toContain(EPERM_RESULT);
    expect(result).toContain('/sandbox:network on');
    expect(attempt).toHaveBeenCalledTimes(1);
  });

  it('refuses without prompting when unsandboxed commands are disabled', async () => {
    const { run, attempt, showPermissionPrompt } = setup({ allowUnsandboxedCommands: false });
    const result = await run();
    expect(result).toContain(EPERM_RESULT);
    expect(result).toContain('disabled');
    expect(showPermissionPrompt).not.toHaveBeenCalled();
    expect(attempt).toHaveBeenCalledTimes(1);
  });

  it('does not escalate a background run', async () => {
    const { run, showPermissionPrompt } = setup({ extraArgs: { run_in_background: true } });
    await expect(run()).resolves.toBe(EPERM_RESULT);
    expect(showPermissionPrompt).not.toHaveBeenCalled();
  });

  describe('session approval', () => {
    it('allow-session skips the prompt for the same command and cwd next time', async () => {
      const first = setup({ answer: 'allow-session' });
      await first.run();
      expect(first.showPermissionPrompt).toHaveBeenCalledTimes(1);

      const second = setup({ permissionManager: first.permissionManager });
      await expect(second.run()).resolves.toBe('done');
      expect(second.showPermissionPrompt).not.toHaveBeenCalled();
      expect(second.attempt).toHaveBeenCalledTimes(2); // still tries the sandbox first
    });

    it('does not carry over to a different command', async () => {
      const first = setup({ answer: 'allow-session' });
      await first.run();

      const other = setup({ permissionManager: first.permissionManager, command: 'touch /etc/other' });
      await other.run();
      expect(other.showPermissionPrompt).toHaveBeenCalledTimes(1);
    });

    it('allow-once is not remembered', async () => {
      const first = setup({ answer: 'allow-once' });
      await first.run();
      const second = setup({ permissionManager: first.permissionManager });
      await second.run();
      expect(second.showPermissionPrompt).toHaveBeenCalledTimes(1);
    });

    it('always asks for a high-risk command and never remembers it', async () => {
      const command = 'sudo rm -rf /tmp/x';
      const manager = new PermissionManager(new ToolCatalog());
      const first = setup({ command, answer: 'allow-session', permissionManager: manager });
      await first.run();
      expect(first.showPermissionPrompt).toHaveBeenCalledTimes(1);
      expect(manager.isSandboxEscalationApproved(JSON.stringify([RESOLVED_CWD, command]))).toBe(false);

      manager.approveSandboxEscalation(JSON.stringify([RESOLVED_CWD, command]));
      const second = setup({ command, permissionManager: manager });
      await second.run();
      expect(second.showPermissionPrompt).toHaveBeenCalledTimes(1);
    });
  });
});
