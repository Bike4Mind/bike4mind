import { describe, it, expect } from 'vitest';
import { runBangCommand } from './runBangCommand';

const cwd = process.cwd();

describe('runBangCommand', () => {
  it('returns stdout on success', async () => {
    expect(await runBangCommand('printf hello', { cwd })).toEqual({ output: 'hello', isError: false });
  });

  it('returns stderr for a failing command', async () => {
    expect(await runBangCommand('echo broken >&2; exit 3', { cwd })).toEqual({ output: 'broken\n', isError: true });
  });

  it('runs in the given directory', async () => {
    const { output } = await runBangCommand('pwd', { cwd: '/' });
    expect(output.trim()).toBe('/');
  });

  it('does not wait on a command that reads stdin', async () => {
    const started = Date.now();
    const result = await runBangCommand('cat', { cwd, timeoutMs: 5_000 });

    expect(result).toEqual({ output: '', isError: false });
    expect(Date.now() - started).toBeLessThan(2_000);
  });

  it('kills a command that outlives the timeout and keeps its partial output', async () => {
    const result = await runBangCommand('echo partial; sleep 5', { cwd, timeoutMs: 1_000 });

    expect(result.isError).toBe(true);
    expect(result.output).toBe('partial\nCommand timed out after 1s');
  });

  it('keeps the event loop running while the command runs', async () => {
    const order: string[] = [];
    const pending = runBangCommand('sleep 0.2', { cwd }).then(() => order.push('command-done'));
    setTimeout(() => order.push('timer-fired'), 20);
    await pending;

    expect(order).toEqual(['timer-fired', 'command-done']);
  });
});
