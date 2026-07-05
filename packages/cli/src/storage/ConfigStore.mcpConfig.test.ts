import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { ConfigStore } from './ConfigStore';

/**
 * --mcp-config (claude-compat) loading + strict-vs-merge.
 *
 * The portable OBJECT-format schema must carry `type`/`url`/`headers`, else the
 * HTTP transport connects to `undefined`. Drives ConfigStore.load() with
 * B4M_MCP_CONFIG_FILE set and project config disabled, so only the global config
 * plus injected --mcp-config participate.
 */
describe('ConfigStore --mcp-config', () => {
  let dir: string;
  let globalConfigPath: string;
  let mcpConfigPath: string;
  const savedEnv: Record<string, string | undefined> = {};

  /** A minimal valid global config carrying one pre-existing stdio MCP server. */
  function writeGlobalConfig() {
    writeFileSync(
      globalConfigPath,
      JSON.stringify({
        version: '1.0.0',
        userId: 'test-user',
        defaultModel: 'claude-sonnet-4-6',
        mcpServers: [{ name: 'existing-stdio', command: 'node', args: ['srv.js'], env: {}, enabled: true }],
        preferences: {
          maxTokens: 4096,
          temperature: 0.7,
          autoSave: true,
          theme: 'dark',
          exportFormat: 'markdown',
        },
        tools: { enabled: [], disabled: [], config: {} },
      }),
      { mode: 0o600 }
    );
  }

  /** A claude-shape --mcp-config: object form, http transport with Bearer header. */
  function writeMcpConfig() {
    writeFileSync(
      mcpConfigPath,
      JSON.stringify({
        mcpServers: {
          host: {
            type: 'http',
            url: 'https://example.test/mcp',
            headers: { Authorization: 'Bearer minted-token' },
          },
        },
      })
    );
  }

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'b4m-cfg-'));
    globalConfigPath = join(dir, 'config.json');
    mcpConfigPath = join(dir, 'mcp-config.json');
    for (const k of ['B4M_NO_PROJECT_CONFIG', 'B4M_MCP_CONFIG_FILE', 'B4M_STRICT_MCP_CONFIG']) {
      savedEnv[k] = process.env[k];
    }
    process.env.B4M_NO_PROJECT_CONFIG = '1';
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
    for (const [k, v] of Object.entries(savedEnv)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  });

  it('merges the injected HTTP server (with url+headers) alongside existing servers', async () => {
    writeGlobalConfig();
    writeMcpConfig();
    process.env.B4M_MCP_CONFIG_FILE = mcpConfigPath;
    delete process.env.B4M_STRICT_MCP_CONFIG;

    const config = await new ConfigStore(globalConfigPath).load();
    const names = config.mcpServers.map(s => s.name);
    expect(names).toContain('existing-stdio');
    expect(names).toContain('host');

    const host = config.mcpServers.find(s => s.name === 'host');
    // object-format url/headers must survive parse+normalize
    expect(host?.type).toBe('http');
    expect(host?.url).toBe('https://example.test/mcp');
    expect(host?.headers?.Authorization).toBe('Bearer minted-token');
  });

  it('--strict-mcp-config uses ONLY the injected servers (drops file-config servers)', async () => {
    writeGlobalConfig();
    writeMcpConfig();
    process.env.B4M_MCP_CONFIG_FILE = mcpConfigPath;
    process.env.B4M_STRICT_MCP_CONFIG = '1';

    const config = await new ConfigStore(globalConfigPath).load();
    expect(config.mcpServers.map(s => s.name)).toEqual(['host']);
  });

  it('a missing --mcp-config file does not brick load (existing servers remain)', async () => {
    writeGlobalConfig();
    process.env.B4M_MCP_CONFIG_FILE = join(dir, 'nope.json');
    delete process.env.B4M_STRICT_MCP_CONFIG;

    const config = await new ConfigStore(globalConfigPath).load();
    expect(config.mcpServers.map(s => s.name)).toContain('existing-stdio');
  });

  it('--strict-mcp-config with a missing file locks to an empty set (no fall-back leak)', async () => {
    // Strict means strict: a malformed/missing injected file must NOT silently fall
    // back to the broader merged config, or a locked pane (e.g. YAML) would leak the
    // user's other MCP servers.
    writeGlobalConfig();
    process.env.B4M_MCP_CONFIG_FILE = join(dir, 'nope.json');
    process.env.B4M_STRICT_MCP_CONFIG = '1';

    const config = await new ConfigStore(globalConfigPath).load();
    expect(config.mcpServers).toEqual([]);
  });
});
