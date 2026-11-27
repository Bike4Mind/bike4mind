import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

async function runMain(args: string[]) {
  process.argv = ['node', 'main.ts', ...args];
  vi.resetModules();
  await import('./main');
  return process.exitCode;
}

describe('main', () => {
  const argv = process.argv;
  let stdout: ReturnType<typeof vi.spyOn>;
  let stderr: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    stdout = vi.spyOn(process.stdout, 'write').mockReturnValue(true);
    stderr = vi.spyOn(process.stderr, 'write').mockReturnValue(true);
  });

  afterEach(() => {
    process.argv = argv;
    process.exitCode = undefined;
    vi.restoreAllMocks();
  });

  it('validates the committed matrix next to it', async () => {
    expect(await runMain(['validate'])).toBe(0);
    expect(stdout).toHaveBeenCalledWith(expect.stringMatching(/^Parity matrix OK: \d+ features\.\n$/));
  });

  it('uses the current date', async () => {
    expect(await runMain(['train-version'])).toBe(0);
    expect(stdout).toHaveBeenCalledWith(expect.stringMatching(/^\d+\.\d+\.0\n$/));
  });

  it('writes errors to stderr and sets the exit code', async () => {
    expect(await runMain(['nope'])).toBe(2);
    expect(stderr).toHaveBeenCalledWith(expect.stringMatching(/^Usage: mobile-release/));
  });
});
