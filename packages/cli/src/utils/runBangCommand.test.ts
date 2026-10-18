import { describe, it, expect } from 'vitest';
import { runBangCommand, killRunningBangCommands } from './runBangCommand';

const cwd = process.cwd();

describe('runBangCommand', () => {
  it('returns stdout on success', async () => {
    expect(await runBangCommand('printf hello', { cwd })).toEqual({ output: 'hello', isError: false });
  });

  it('returns stderr for a failing command', async () => {
    expect(await runBangCommand('echo broken >&2; exit 3', { cwd })).toEqual({ output: 'broken\n', isError: true });
  });

  it('falls back to stdout when a failing command writes nothing to stderr', async () => {
    expect(await runBangCommand('echo differences; exit 1', { cwd })).toEqual({
      output: 'differences\n',
      isError: true,
    });
  });

  it('keeps multi-byte characters intact across pipe chunks', async () => {
    const result = await runBangCommand(`node -e "process.stdout.write('\u3042'.repeat(100000))"`, { cwd });

    expect(result?.output).toBe('\u3042'.repeat(100000));
  });

  it('stops a command whose output passes the cap', async () => {
    const result = await runBangCommand('yes', { cwd });

    expect(result).toEqual({ output: 'Command output exceeded 10 MB', isError: true });
  });

  it('runs in the given directory', async () => {
    const result = await runBangCommand('pwd', { cwd: '/' });
    expect(result?.output.trim()).toBe('/');
  });

  it('does not wait on a command that reads stdin', async () => {
    const started = Date.now();
    const result = await runBangCommand('cat', { cwd, timeoutMs: 5_000 });

    expect(result).toEqual({ output: '', isError: false });
    expect(Date.now() - started).toBeLessThan(2_000);
  });

  it('kills a command that outlives the timeout and keeps its partial output', async () => {
    const result = await runBangCommand('echo partial; sleep 5', { cwd, timeoutMs: 1_000 });

    expect(result).toEqual({ output: 'partial\nCommand timed out after 1s', isError: true });
  });

  it('kills the whole process tree on timeout, not just the shell', async () => {
    const result = await runBangCommand('sleep 30 & echo $!; wait', { cwd, timeoutMs: 1_000 });
    const grandchildPid = Number(result?.output.split('\n')[0]);
    await new Promise(resolve => setTimeout(resolve, 100));

    expect(grandchildPid).toBeGreaterThan(0);
    expect(() => process.kill(grandchildPid, 0)).toThrow();
  });

  it('kills commands still running when the CLI exits and records nothing for them', async () => {
    const started = Date.now();
    const pending = runBangCommand('sleep 30', { cwd });
    await new Promise(resolve => setTimeout(resolve, 100));
    killRunningBangCommands();

    expect(await pending).toBeNull();
    expect(Date.now() - started).toBeLessThan(5_000);
  });

  it('kills the command when its signal aborts (ESC)', async () => {
    const controller = new AbortController();
    const pending = runBangCommand('sleep 30', { cwd, signal: controller.signal });
    await new Promise(resolve => setTimeout(resolve, 100));
    controller.abort();

    expect(await pending).toEqual({ output: 'Command cancelled', isError: true });
  });

  it('keeps the event loop running while the command runs', async () => {
    const order: string[] = [];
    const pending = runBangCommand('sleep 0.2', { cwd }).then(() => order.push('command-done'));
    setTimeout(() => order.push('timer-fired'), 20);
    await pending;

    expect(order).toEqual(['timer-fired', 'command-done']);
  });
});
