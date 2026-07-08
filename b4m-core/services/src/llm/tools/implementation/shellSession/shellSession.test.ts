import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { EventEmitter } from 'events';
import type { spawn } from 'child_process';
import { ShellSessionManager } from '../bashExecute/ShellSessionManager';
import { checkShellOutput, writeShellStdin, listBackgroundShells, killBackgroundShell } from './index';

class MockChild extends EventEmitter {
  stdout = new EventEmitter();
  stderr = new EventEmitter();
  stdin = Object.assign(new EventEmitter(), { write: vi.fn(), end: vi.fn() });
  exitCode: number | null = null;
  signalCode: NodeJS.Signals | null = null;
  constructor(public pid = 4242) {
    super();
  }
  emitStdout(chunk: string) {
    this.stdout.emit('data', Buffer.from(chunk));
  }
  close(code: number | null) {
    this.exitCode = code;
    this.emit('close', code);
  }
}

function managerWith(children: MockChild[]) {
  let i = 0;
  const spawnFn = (() => children[i++]) as unknown as typeof spawn;
  return new ShellSessionManager({ spawnFn });
}

describe('shell session tools', () => {
  let killSpy: ReturnType<typeof vi.spyOn>;
  beforeEach(() => {
    killSpy = vi.spyOn(process, 'kill').mockImplementation(() => true);
  });
  afterEach(() => killSpy.mockRestore());

  describe('checkShellOutput', () => {
    it('reports unknown sessions', () => {
      expect(checkShellOutput(managerWith([]), 'nope')).toContain('No background shell found');
    });

    it('returns incremental output and the next offset', () => {
      const child = new MockChild();
      const manager = managerWith([child]);
      const { id } = manager.spawn('tail -f log', '/tmp', process.env);
      child.emitStdout('line1\n');

      const out = checkShellOutput(manager, id);
      expect(out).toContain('running');
      expect(out).toContain('line1');
      expect(out).toContain('still running');
      expect(out).toContain('Next poll offset: 6');
    });

    it('flags truncation when the offset predates the buffer', () => {
      const child = new MockChild();
      const manager = new ShellSessionManager({
        spawnFn: (() => child) as unknown as typeof spawn,
        maxOutputChars: 4,
      });
      const { id } = manager.spawn('yes', '/tmp', process.env);
      child.emitStdout('abcdefgh');
      const out = checkShellOutput(manager, id, 0);
      expect(out).toContain('earlier output dropped');
    });

    it('shows the exit code once finished', () => {
      const child = new MockChild();
      const manager = managerWith([child]);
      const { id } = manager.spawn('true', '/tmp', process.env);
      child.close(0);
      const out = checkShellOutput(manager, id);
      expect(out).toContain('exited (exit 0)');
      expect(out).not.toContain('still running');
    });
  });

  describe('writeShellStdin', () => {
    it('writes characters to a running session', () => {
      const child = new MockChild();
      const manager = managerWith([child]);
      const { id } = manager.spawn('cat', '/tmp', process.env);
      const out = writeShellStdin(manager, id, 'hello\n');
      expect(out).toContain('Wrote input');
      expect(child.stdin.write).toHaveBeenCalledWith('hello\n');
    });

    it('recognizes an interrupt', () => {
      const child = new MockChild(77);
      const manager = managerWith([child]);
      const { id } = manager.spawn('cat', '/tmp', process.env);
      const out = writeShellStdin(manager, id, '\x03');
      expect(out).toContain('interrupt');
      expect(killSpy).toHaveBeenCalledWith(-77, 'SIGINT');
    });

    it('refuses to write to a finished session', () => {
      const child = new MockChild();
      const manager = managerWith([child]);
      const { id } = manager.spawn('true', '/tmp', process.env);
      child.close(0);
      expect(writeShellStdin(manager, id, 'x')).toContain('Cannot write');
    });
  });

  describe('listBackgroundShells', () => {
    it('reports when empty', () => {
      expect(listBackgroundShells(managerWith([]))).toBe('No background shell sessions.');
    });

    it('summarizes each session with a status icon', () => {
      const a = new MockChild(1);
      const b = new MockChild(2);
      const manager = managerWith([a, b]);
      manager.spawn('pnpm dev', '/tmp', process.env);
      const second = manager.spawn('true', '/tmp', process.env);
      b.close(0);

      const out = listBackgroundShells(manager);
      expect(out).toContain('pnpm dev');
      expect(out).toContain('⏳'); // running
      expect(out).toContain('✅'); // exited
      expect(out).toContain(second.id);
    });
  });

  describe('killBackgroundShell', () => {
    it('terminates a running session', () => {
      const child = new MockChild(9);
      const manager = managerWith([child]);
      const { id } = manager.spawn('sleep 100', '/tmp', process.env);
      expect(killBackgroundShell(manager, id)).toContain('has been terminated');
      expect(killSpy).toHaveBeenCalledWith(-9, 'SIGTERM');
    });

    it('reports unknown sessions', () => {
      expect(killBackgroundShell(managerWith([]), 'nope')).toContain('No background shell found');
    });

    it('is a no-op on an already-finished session', () => {
      const child = new MockChild();
      const manager = managerWith([child]);
      const { id } = manager.spawn('true', '/tmp', process.env);
      child.close(0);
      expect(killBackgroundShell(manager, id)).toContain('already');
    });
  });
});
