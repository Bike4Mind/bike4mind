import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ConfigStore } from '../storage/ConfigStore.js';
import { handleMcpCommand } from './mcpCommand.js';

let home: string;
let configPath: string;
let output: string[];

beforeEach(async () => {
  home = await mkdtemp(path.join(os.tmpdir(), 'b4m-mcp-command-'));
  configPath = path.join(home, '.bike4mind', 'config.json');
  await mkdir(path.dirname(configPath), { recursive: true });
  vi.stubEnv('HOME', home);
  vi.stubEnv('B4M_NO_PROJECT_CONFIG', '1');
  vi.stubEnv('B4M_MCP_CONFIG_FILE', '');
  output = [];
  const record = (...args: unknown[]) => {
    output.push(args.map(String).join(' '));
  };
  vi.spyOn(console, 'log').mockImplementation(record);
  vi.spyOn(console, 'error').mockImplementation(record);
  vi.spyOn(process, 'exit').mockImplementation(((code?: number) => {
    throw new Error(`exit ${code}`);
  }) as typeof process.exit);
});

afterEach(async () => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  await rm(home, { recursive: true, force: true });
});

describe('b4m mcp enable/disable', () => {
  it('disables a server saved in a config that fails validation', async () => {
    const saved = { toolApiKeys: 'bad', newerSetting: 1, mcpServers: [{ name: 'local', command: 'c', enabled: true }] };
    await writeFile(configPath, JSON.stringify(saved), { mode: 0o600 });

    await handleMcpCommand('disable', { _: [], name: 'local' });

    expect(JSON.parse(await readFile(configPath, 'utf-8'))).toEqual({
      ...saved,
      mcpServers: [{ name: 'local', command: 'c', enabled: false }],
    });
    expect(output).toContain('The server will not connect next time you start the CLI.');
  });

  it('says the --mcp-config definition still applies to a server it also defines', async () => {
    await new ConfigStore(configPath).addMcpServer({ name: 'local', command: 'c', args: [], env: {}, enabled: true });
    const injected = path.join(home, 'mcp.json');
    await writeFile(injected, JSON.stringify({ mcpServers: { local: { command: 'other' } } }));
    vi.stubEnv('B4M_MCP_CONFIG_FILE', injected);

    await handleMcpCommand('disable', { _: [], name: 'local' });

    expect(output.some(line => line.includes('--mcp-config also defines this server'))).toBe(true);
    expect(output).not.toContain('The server will not connect next time you start the CLI.');
  });
});
