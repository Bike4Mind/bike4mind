import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { CliConfig } from '../storage/types';

const h = vi.hoisted(() => {
  type Client = { connectToServer: () => Promise<void>; disconnect: ReturnType<typeof vi.fn>; tools: unknown[] };
  return {
    clients: [] as Client[],
    /** Resolves the next connect; null connects at once. */
    gate: null as Promise<void> | null,
  };
});

vi.mock('@bike4mind/mcp', () => ({
  MCPClient: class {
    tools = [{ name: 'echo', description: 'Echo', inputSchema: { type: 'object', properties: {} } }];
    disconnect = vi.fn(async () => {});
    constructor() {
      h.clients.push(this as never);
    }
    async connectToServer() {
      if (h.gate) await h.gate;
    }
  },
}));

vi.mock('@bike4mind/services/llm/tools/cliTools', () => ({
  generateMcpTools: async () => [],
  generateMcpToolsFromCache: () => [],
}));

const config = {
  mcpServers: [{ name: 'files', enabled: true, command: 'files-mcp', args: [], env: {} }],
} as unknown as CliConfig;

let home: string;

beforeEach(async () => {
  home = await mkdtemp(path.join(os.tmpdir(), 'b4m-mcp-dispose-'));
  vi.stubEnv('HOME', home);
  vi.resetModules();
  h.clients = [];
  h.gate = null;
});

afterEach(async () => {
  vi.unstubAllEnvs();
  await rm(home, { recursive: true, force: true });
});

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>(r => (resolve = r));
  return { promise, resolve };
}

describe('McpManager.disconnect with a connect still in flight', () => {
  it('closes a server that finishes connecting after a first-run disconnect', async () => {
    const { McpManager } = await import('./mcpAdapter.js');
    const gate = deferred();
    h.gate = gate.promise;
    const manager = new McpManager(config);

    const initializing = manager.initialize();
    await vi.waitFor(() => expect(h.clients).toHaveLength(1));
    await manager.disconnect();
    gate.resolve();
    await initializing;

    expect(h.clients[0].disconnect).toHaveBeenCalledOnce();
    expect(manager.getToolCount()).toEqual([]);
  });

  it('closes a server that finishes a background connect after disconnect', async () => {
    const { McpManager } = await import('./mcpAdapter.js');
    const warm = new McpManager(config);
    await warm.initialize();
    await warm.disconnect();
    const gate = deferred();
    h.gate = gate.promise;
    const manager = new McpManager(config);

    await manager.initialize();
    await vi.waitFor(() => expect(h.clients).toHaveLength(2));
    await manager.disconnect();
    gate.resolve();

    await vi.waitFor(() => expect(h.clients[1].disconnect).toHaveBeenCalledOnce());
    expect(manager.getToolCount()).toEqual([]);
  });
});
