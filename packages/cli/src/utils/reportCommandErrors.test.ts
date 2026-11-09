import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ConfigStore } from '../storage/ConfigStore.js';
import { reportCommandErrors } from './reportCommandErrors.js';

let dir: string;
let configPath: string;

beforeEach(async () => {
  dir = await mkdtemp(path.join(os.tmpdir(), 'b4m-command-errors-'));
  configPath = path.join(dir, 'config.json');
  vi.stubEnv('HOME', dir);
  vi.stubEnv('B4M_NO_PROJECT_CONFIG', '1');
  vi.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(async () => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  await rm(dir, { recursive: true, force: true });
});

describe('reportCommandErrors', () => {
  it('prints a refused config save and lets the next command run', async () => {
    await writeFile(configPath, '[]', { mode: 0o600 });
    const store = new ConfigStore(configPath);
    const report = vi.fn();
    const ran: string[] = [];
    const handleCommand = reportCommandErrors(async (command, args) => {
      ran.push(command);
      if (command === 'untrust') await store.untrustTool(args[0]);
    }, report);

    await expect(handleCommand('untrust', ['file_read'])).resolves.toBeUndefined();
    await handleCommand('help', []);

    expect(report).toHaveBeenCalledTimes(1);
    expect(report).toHaveBeenCalledWith(
      expect.stringContaining(`/untrust failed: Could not save settings: ${configPath}`)
    );
    expect(ran).toEqual(['untrust', 'help']);
    expect(await readFile(configPath, 'utf-8')).toBe('[]');
  });
});
