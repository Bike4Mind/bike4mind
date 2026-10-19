import { describe, it, expect, vi } from 'vitest';
import type { SandboxOrchestrator } from '../../../sandbox/SandboxOrchestrator.js';
import { isSandboxFailure, prepareSandbox } from './sandbox.js';

describe('isSandboxFailure', () => {
  it('is false when the command was not sandboxed', () => {
    expect(isSandboxFailure(false, 'sandbox-exec: deny(1) file-write-data /x')).toBe(false);
    expect(isSandboxFailure(false, 'touch: /etc/hosts: Operation not permitted')).toBe(false);
  });

  it('matches the sandbox launcher/denial markers', () => {
    expect(isSandboxFailure(true, 'sandbox-exec: deny(1) file-write-data /x')).toBe(true);
    expect(isSandboxFailure(true, 'bwrap: Creating new namespace failed')).toBe(true);
  });

  it('matches a real macOS Seatbelt denial (EPERM with no marker prefix)', () => {
    // A real Seatbelt denial surfaces as the denied syscall's own EPERM printed by
    // the tool that hit it, with NO `sandbox-exec:` prefix. Matching it is what keeps
    // the unsandboxed-retry offer and the `/sandbox:network on` tip reachable on macOS
    // for the two most common cases: a write outside the workspace and a blocked connect.
    expect(isSandboxFailure(true, 'touch: /etc/hosts: Operation not permitted')).toBe(true);
    expect(isSandboxFailure(true, 'curl: (7) Failed to connect to example.com port 443: Operation not permitted')).toBe(
      true
    );
  });

  it('accepts the cheap false positive on a bare EPERM (deniable prompt only)', () => {
    // e.g. `kill` on a foreign pid also prints this. We accept the deniable retry
    // prompt because a false NEGATIVE would silently drop the recovery path entirely.
    expect(isSandboxFailure(true, 'kill: 1: Operation not permitted')).toBe(true);
  });
});

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
    expect(prepareSandbox('file_read', { command: 'ls' }, sandbox, [process.cwd()])).toEqual({ kind: 'unchanged' });
    expect(sandbox.shouldSandbox).not.toHaveBeenCalled();
  });

  it('leaves a call unchanged when there is no orchestrator or no command', () => {
    expect(prepareSandbox('bash_execute', { command: 'ls' }, undefined, [process.cwd()])).toEqual({
      kind: 'unchanged',
    });
    const sandbox = orchestrator({ type: 'unsandboxed' } as never);
    expect(prepareSandbox('bash_execute', {}, sandbox, [process.cwd()])).toEqual({ kind: 'unchanged' });
    expect(sandbox.shouldSandbox).not.toHaveBeenCalled();
  });

  it('records an unsandboxed decision and leaves the call unchanged', () => {
    const sandbox = orchestrator({ type: 'unsandboxed' } as never);
    expect(prepareSandbox('bash_execute', { command: 'ls' }, sandbox, [process.cwd()])).toEqual({ kind: 'unchanged' });
    expect(sandbox.recordUnsandboxed).toHaveBeenCalledOnce();
  });

  it('rewrites the command and keeps the original args for a sandboxed decision', () => {
    const sandbox = orchestrator({
      type: 'sandbox',
      wrappedCommand: { commandString: 'sandbox-exec ls', cleanupPaths: ['/tmp/profile.sb'] },
    } as never);
    const result = prepareSandbox('bash_execute', { command: 'ls', timeout: 5 }, sandbox, [process.cwd()]);
    expect(result).toMatchObject({
      kind: 'sandboxed',
      cleanupPaths: ['/tmp/profile.sb'],
      args: { command: 'sandbox-exec ls', timeout: 5, _sandboxCleanup: ['/tmp/profile.sb'] },
    });
  });
});
