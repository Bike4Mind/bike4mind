import { describe, it, expect, vi } from 'vitest';
import type { SandboxOrchestrator } from '../../../sandbox/SandboxOrchestrator.js';
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
