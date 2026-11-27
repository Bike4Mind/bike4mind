import { describe, it, expect, vi } from 'vitest';
import { SandboxOrchestrator } from '../../../sandbox/SandboxOrchestrator.js';
import { DEFAULT_SANDBOX_CONFIG } from '../../../sandbox/types.js';
import type { SandboxRuntime } from '../../../sandbox/runtime/SandboxRuntimeAdapter.js';
import { mkdtempSync, mkdirSync, existsSync, rmSync } from 'fs';
import os from 'os';
import path from 'path';
import { prepareSandbox } from './sandbox.js';
import type { ToolDescriptor } from '../toolDescriptor.js';
import { CORE_TOOL_DESCRIPTORS } from '../coreToolDescriptors.js';

const bashDescriptor = CORE_TOOL_DESCRIPTORS.get('bash_execute');

describe('prepareSandbox', () => {
  function orchestrator(decision: ReturnType<SandboxOrchestrator['shouldSandbox']>) {
    return {
      shouldSandbox: vi.fn(() => decision),
      recordSandboxed: vi.fn(),
      recordUnsandboxed: vi.fn(),
      recordBlocked: vi.fn(),
    } as unknown as SandboxOrchestrator & {
      shouldSandbox: ReturnType<typeof vi.fn>;
      recordUnsandboxed: ReturnType<typeof vi.fn>;
    };
  }

  it('leaves a non-shell tool unchanged without consulting the orchestrator', () => {
    const sandbox = orchestrator({ type: 'unsandboxed' } as never);
    expect(prepareSandbox(CORE_TOOL_DESCRIPTORS.get('file_read'), { command: 'ls' }, sandbox, [process.cwd()])).toEqual(
      { kind: 'unchanged' }
    );
    expect(sandbox.shouldSandbox).not.toHaveBeenCalled();
  });

  it('leaves a call unchanged when there is no orchestrator or no command', () => {
    expect(prepareSandbox(bashDescriptor, { command: 'ls' }, undefined, [process.cwd()])).toEqual({
      kind: 'unchanged',
    });
    const sandbox = orchestrator({ type: 'unsandboxed' } as never);
    expect(prepareSandbox(bashDescriptor, {}, sandbox, [process.cwd()])).toEqual({ kind: 'unchanged' });
    expect(sandbox.shouldSandbox).not.toHaveBeenCalled();
  });

  it('records an unsandboxed decision and leaves the call unchanged', () => {
    const sandbox = orchestrator({ type: 'unsandboxed' } as never);
    expect(prepareSandbox(bashDescriptor, { command: 'ls' }, sandbox, [process.cwd()])).toEqual({ kind: 'unchanged' });
    expect(sandbox.recordUnsandboxed).toHaveBeenCalledOnce();
  });

  it('rewrites the command and keeps the original args for a sandboxed decision', () => {
    const sandbox = orchestrator({
      type: 'sandbox',
      wrappedCommand: { commandString: 'sandbox-exec ls', cleanupPaths: ['/tmp/profile.sb'] },
    } as never);
    const result = prepareSandbox(bashDescriptor, { command: 'ls', timeout: 5 }, sandbox, [process.cwd()]);
    expect(result).toMatchObject({
      kind: 'sandboxed',
      cleanupPaths: ['/tmp/profile.sb'],
      args: { command: 'sandbox-exec ls', timeout: 5 },
    });
  });

  it('checks cwd confinement before the runtime can create workspace metadata', () => {
    const directory = mkdtempSync(path.join(os.tmpdir(), 'sandbox-cwd-check-'));
    const workspace = path.join(directory, 'workspace');
    const outside = path.join(directory, 'outside');
    mkdirSync(workspace);
    mkdirSync(outside);
    const runtime: SandboxRuntime = {
      platform: 'linux',
      name: 'test',
      isAvailable: () => true,
      wrapCommand: vi.fn(options => {
        mkdirSync(path.join(options.cwd, '.bike4mind'));
        throw new Error('Runtime must not run before confinement validation');
      }),
    };
    const config = structuredClone(DEFAULT_SANDBOX_CONFIG);
    config.enabled = true;
    config.mode = 'auto-allow';
    const sandbox = new SandboxOrchestrator(config, runtime);
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      expect(prepareSandbox(bashDescriptor, { command: 'ls', cwd: outside }, sandbox, [workspace])).toMatchObject({
        kind: 'blocked',
      });
      expect(runtime.wrapCommand).not.toHaveBeenCalled();
      expect(existsSync(path.join(outside, '.bike4mind'))).toBe(false);

      expect(prepareSandbox(bashDescriptor, { command: 'docker ps', cwd: outside }, sandbox, [workspace])).toEqual({
        kind: 'unchanged',
      });
      sandbox.setMode('disabled');
      expect(prepareSandbox(bashDescriptor, { command: 'ls', cwd: outside }, sandbox, [workspace])).toEqual({
        kind: 'unchanged',
      });
      expect(runtime.wrapCommand).not.toHaveBeenCalled();
    } finally {
      consoleError.mockRestore();
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it('does not wrap write_shell_stdin, which has a commandArg but no sandbox declaration', () => {
    const sandbox = orchestrator({ type: 'unsandboxed' } as never);
    const result = prepareSandbox(CORE_TOOL_DESCRIPTORS.get('write_shell_stdin'), { chars: 'ls' }, sandbox, [
      process.cwd(),
    ]);
    expect(result).toEqual({ kind: 'unchanged' });
    expect(sandbox.shouldSandbox).not.toHaveBeenCalled();
  });

  it('ignores a sandbox declaration from a non-core source', () => {
    const sandbox = orchestrator({ type: 'unsandboxed' } as never);
    const pluginDescriptor: ToolDescriptor = {
      source: { kind: 'plugin', packageName: 'x' },
      effect: 'execute',
      approval: 'prompt_always',
      commandArg: 'command',
      sandbox: 'command',
    };
    expect(prepareSandbox(pluginDescriptor, { command: 'ls' }, sandbox, [process.cwd()])).toEqual({
      kind: 'unchanged',
    });
    expect(sandbox.shouldSandbox).not.toHaveBeenCalled();
  });

  it('wraps the descriptor commandArg rather than a hardcoded argument name', () => {
    const sandbox = orchestrator({
      type: 'sandbox',
      wrappedCommand: { commandString: 'sandbox-exec run', cleanupPaths: [] },
    } as never);
    const descriptor: ToolDescriptor = {
      source: { kind: 'core' },
      effect: 'execute',
      approval: 'prompt_always',
      commandArg: 'script',
      sandbox: 'command',
    };
    expect(prepareSandbox(descriptor, { script: 'run' }, sandbox, [process.cwd()])).toMatchObject({
      kind: 'sandboxed',
      args: { script: 'sandbox-exec run' },
    });
  });
});
