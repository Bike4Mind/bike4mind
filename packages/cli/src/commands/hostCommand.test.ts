import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const bin = fileURLToPath(new URL('../../bin/bike4mind-cli.mjs', import.meta.url));

describe('b4m host', () => {
  it('refuses a flag before host instead of starting the agent with "host" as its prompt', () => {
    const run = spawnSync(process.execPath, [bin, '--verbose', 'host', 'status'], {
      encoding: 'utf8',
      input: '',
      timeout: 60_000,
    });
    expect(run.status).toBe(2);
    expect(run.stderr).toContain('b4m host must be the first argument: b4m host <command> (see: b4m host --help)');
    expect(run.stdout).toBe('');
  }, 70_000);
});
