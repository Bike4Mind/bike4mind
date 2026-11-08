import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
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
  it.each([
    ['enable', true],
    ['disable', false],
  ] as const)('refuses %s for an injected-only server even when its state already matches', async (action, enabled) => {
    await new ConfigStore(configPath).save();
    const contents = await readFile(configPath, 'utf-8');
    const injected = path.join(home, 'mcp.json');
    await writeFile(injected, JSON.stringify({ mcpServers: { host: { command: 'c', enabled } } }));
    vi.stubEnv('B4M_MCP_CONFIG_FILE', injected);

    await expect(handleMcpCommand(action, { _: [], name: 'host' })).rejects.toThrow('exit 1');

    expect(output.some(line => line.includes('comes from --mcp-config'))).toBe(true);
    expect(output.some(line => line.includes('already'))).toBe(false);
    expect(await readFile(configPath, 'utf-8')).toBe(contents);
  });

  it.each([
    ['pending', 'enable', true],
    ['pending', 'disable', true],
    ['approved', 'enable', true],
    ['approved', 'disable', true],
    ['disabled', 'enable', false],
    ['disabled', 'disable', false],
  ] as const)('names the project source for a %s server on %s', async (approval, action, enabled) => {
    const project = await realpath(home);
    await mkdir(path.join(project, '.git'));
    await writeFile(
      path.join(project, '.mcp.json'),
      JSON.stringify({ mcpServers: { host: { command: 'c', enabled } } })
    );
    vi.stubEnv('B4M_NO_PROJECT_CONFIG', '');
    vi.spyOn(process, 'cwd').mockReturnValue(project);
    const store = new ConfigStore(configPath);
    await store.trustProject(project);
    if (approval === 'approved') await store.approveMcpServers(store.getPendingMcpApprovals());
    const contents = await readFile(configPath, 'utf-8');

    await expect(handleMcpCommand(action, { _: [], name: 'host' })).rejects.toThrow('exit 1');

    expect(output.some(line => line.includes("comes from this project's config"))).toBe(true);
    expect(output.some(line => line.includes('not found') || line.includes('already'))).toBe(false);
    expect(await readFile(configPath, 'utf-8')).toBe(contents);
  });

  it.each(['enable', 'disable'] as const)('reports an unknown name on %s', async action => {
    await new ConfigStore(configPath).save();
    const contents = await readFile(configPath, 'utf-8');

    await expect(handleMcpCommand(action, { _: [], name: 'missing' })).rejects.toThrow('exit 1');

    expect(output).toContain('❌ MCP server "missing" not found.');
    expect(output.some(line => line.includes('comes from'))).toBe(false);
    expect(await readFile(configPath, 'utf-8')).toBe(contents);
  });

  it.each([
    ['enable', true, false, false],
    ['disable', false, false, false],
    ['enable', true, true, false],
    ['disable', false, true, false],
    ['enable', true, false, true],
    ['disable', false, false, true],
    ['enable', true, true, true],
    ['disable', false, true, true],
  ] as const)(
    'keeps a saved no-op write-free on %s (enabled: %s, injected: %s, invalid: %s)',
    async (action, enabled, injected, invalid) => {
      await new ConfigStore(configPath).addMcpServer({ name: 'local', command: 'c', env: {}, enabled });
      if (invalid) {
        await writeFile(
          configPath,
          JSON.stringify({ toolApiKeys: 'bad', mcpServers: { local: { command: 'c', enabled } } })
        );
      }
      const contents = await readFile(configPath, 'utf-8');
      if (injected) {
        const injectedPath = path.join(home, 'mcp.json');
        await writeFile(
          injectedPath,
          JSON.stringify({ mcpServers: { local: { command: 'other', enabled: !enabled } } })
        );
        vi.stubEnv('B4M_MCP_CONFIG_FILE', injectedPath);
      }

      await handleMcpCommand(action, { _: [], name: 'local' });

      expect(output.some(line => line.includes('already'))).toBe(true);
      expect(output.some(line => line.includes('--mcp-config also defines this server'))).toBe(injected);
      expect(await readFile(configPath, 'utf-8')).toBe(contents);
    }
  );

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

  it('says the --mcp-config definition still applies when the saved server is already disabled', async () => {
    await new ConfigStore(configPath).addMcpServer({ name: 'local', command: 'c', args: [], env: {}, enabled: false });
    const injected = path.join(home, 'mcp.json');
    await writeFile(injected, JSON.stringify({ mcpServers: { local: { command: 'other' } } }));
    vi.stubEnv('B4M_MCP_CONFIG_FILE', injected);

    await handleMcpCommand('disable', { _: [], name: 'local' });

    expect(output.some(line => line.includes('is already disabled'))).toBe(true);
    expect(output.some(line => line.includes('--mcp-config also defines this server'))).toBe(true);
  });

  it('names the project config for a project server still waiting for approval', async () => {
    const project = path.join(home, 'proj');
    await mkdir(path.join(project, '.git'), { recursive: true });
    await writeFile(path.join(project, '.mcp.json'), JSON.stringify({ mcpServers: { repo: { command: 'r' } } }));
    const cwd = process.cwd();
    process.chdir(project);
    try {
      vi.stubEnv('B4M_NO_PROJECT_CONFIG', '');
      await new ConfigStore(configPath).trustProject();
      const before = await readFile(configPath, 'utf-8');

      for (const subcommand of ['enable', 'disable']) {
        output = [];
        await expect(handleMcpCommand(subcommand, { _: [], name: 'repo' })).rejects.toThrow('exit 1');
        expect(output).toEqual([
          `\u274C MCP server "repo" comes from this project's config, not ${configPath}; enable or disable it there.`,
        ]);
      }
      expect(await readFile(configPath, 'utf-8')).toBe(before);
    } finally {
      process.chdir(cwd);
    }
  });

  it('says --strict-mcp-config ignores the user config when enabling a saved server', async () => {
    await new ConfigStore(configPath).addMcpServer({ name: 'local', command: 'c', args: [], env: {}, enabled: false });
    const injected = path.join(home, 'mcp.json');
    await writeFile(injected, JSON.stringify({ mcpServers: { host: { command: 'h' } } }));
    vi.stubEnv('B4M_MCP_CONFIG_FILE', injected);
    vi.stubEnv('B4M_STRICT_MCP_CONFIG', '1');

    await handleMcpCommand('enable', { _: [], name: 'local' });

    expect(JSON.parse(await readFile(configPath, 'utf-8')).mcpServers[0].enabled).toBe(true);
    expect(output.some(line => line.includes('--strict-mcp-config'))).toBe(true);
    expect(output).not.toContain('The server will connect next time you start the CLI.');
  });

  it.each(
    ['enable', 'disable'].flatMap(action =>
      ['array', 'map'].flatMap(shape => ['false', 'true', '', 0, 1, null].map(value => ({ action, shape, value })))
    )
  )('repairs $shape enabled: $value on $action and the loader accepts it', async ({ action, shape, value }) => {
    const entry = { command: 'c', enabled: value };
    const mcpServers = shape === 'array' ? [{ name: 'local', ...entry }] : { local: entry };
    await new ConfigStore(configPath).save();
    const saved: Record<string, unknown> = JSON.parse(await readFile(configPath, 'utf-8'));
    await writeFile(configPath, JSON.stringify({ ...saved, mcpServers }), { mode: 0o600 });
    expect((await new ConfigStore(configPath).load()).mcpServers).toEqual([]);

    await handleMcpCommand(action, { _: [], name: 'local' });

    expect(
      output.some(line => line.includes(`${action === 'enable' ? 'Enabled' : 'Disabled'} MCP server "local"`))
    ).toBe(true);
    expect((await new ConfigStore(configPath).load()).mcpServers).toMatchObject([
      { name: 'local', enabled: action === 'enable' },
    ]);
  });

  it('prints a source refusal without the save-failure prefix', async () => {
    const injected = path.join(home, 'mcp.json');
    await writeFile(injected, JSON.stringify({ mcpServers: { host: { command: 'h' } } }));
    vi.stubEnv('B4M_MCP_CONFIG_FILE', injected);

    await expect(handleMcpCommand('disable', { _: [], name: 'host' })).rejects.toThrow('exit 1');

    expect(output).toEqual([
      `\u274C MCP server "host" comes from --mcp-config, not ${configPath}; enable or disable it in that file.`,
    ]);
  });
});
