import { describe, it, expect, afterEach } from 'vitest';
import { createServer, type Server } from 'http';
import { AddressInfo } from 'net';
import { z } from 'zod';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { MCPClient } from './client';
import path from 'path';

/**
 * AC#6 - streamable-HTTP MCP transport.
 *
 * Spins up an in-process streamable-HTTP MCP server (stateless mode), connects
 * `MCPClient` over HTTP with a Bearer token, and asserts:
 *  - every HTTP request carries `Authorization: Bearer <tok>`
 *  - tools list over HTTP
 *  - a tool call round-trips over HTTP
 */
describe('MCPClient (streamable-HTTP transport)', () => {
  let httpServer: Server | undefined;

  afterEach(async () => {
    if (httpServer) {
      await new Promise<void>(resolve => httpServer!.close(() => resolve()));
      httpServer = undefined;
    }
  });

  /** Start a stateless streamable-HTTP MCP server exposing a single `echo` tool. */
  async function startServer(authHeaders: (string | undefined)[]): Promise<string> {
    httpServer = createServer(async (req, res) => {
      // Record the Authorization header on every request (the assertion target).
      authHeaders.push(req.headers['authorization']);

      // Stateless: fresh server + transport per request.
      const server = new McpServer({ name: 'test-server', version: '1.0.0' });
      server.registerTool(
        'echo',
        { description: 'Echoes its input', inputSchema: { msg: z.string() } },
        async ({ msg }) => ({ content: [{ type: 'text', text: `echo:${msg}` }] })
      );

      const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
      res.on('close', () => {
        void transport.close();
        void server.close();
      });
      await server.connect(transport);
      await transport.handleRequest(req, res);
    });

    await new Promise<void>(resolve => httpServer!.listen(0, '127.0.0.1', () => resolve()));
    const { port } = httpServer!.address() as AddressInfo;
    return `http://127.0.0.1:${port}/mcp`;
  }

  it('connects over HTTP, sends Bearer token on every request, lists and calls a tool', async () => {
    const authHeaders: (string | undefined)[] = [];
    const url = await startServer(authHeaders);
    const token = 'test-token-abc123';

    const client = new MCPClient({
      envVariables: [],
      name: 'host',
      url,
      headers: { Authorization: `Bearer ${token}` },
    });

    await client.connectToServer();

    // Tools listed over HTTP.
    expect(client.tools.map(t => t.name)).toContain('echo');

    // Tool call round-trips over HTTP.
    const result = (await client.callTool('echo', { msg: 'hi' })) as {
      content: Array<{ type: string; text: string }>;
    };
    expect(result.content[0].text).toBe('echo:hi');

    await client.disconnect();

    // Every request carried the Bearer token.
    expect(authHeaders.length).toBeGreaterThan(0);
    for (const h of authHeaders) {
      expect(h).toBe(`Bearer ${token}`);
    }
  });
});

/**
 * The stdio transport spawns a child of the process holding this platform's credentials, so what
 * that child inherits is the security boundary. This drives a real spawn against a fixture MCP
 * server that reports its own `process.env`, which is the only way to prove the boundary end to
 * end - the transport merges the SDK's own defaults underneath whatever MCPClient passes. The
 * per-branch filtering rules are unit-tested in childEnv.test.ts.
 */
describe('MCPClient (stdio child environment)', () => {
  const probeScript = path.resolve(import.meta.dirname, '__fixtures__', 'envProbeServer.mjs');

  it('starts the child with its configured variables and no inherited secret', async () => {
    process.env.B4M_TEST_PLATFORM_SECRET = 'must-not-reach-the-child';

    const client = new MCPClient({
      name: 'env-probe',
      command: process.execPath,
      args: [probeScript],
      suppressStderr: true,
      envVariables: [
        { key: 'THIRD_PARTY_TOKEN', value: 'abc' },
        { key: 'NODE_OPTIONS', value: '--require /tmp/payload.js' },
        { key: 'HTTPS_PROXY', value: 'http://corp-proxy.internal:8080' },
      ],
    });

    try {
      await client.connectToServer();
      const result = (await client.callTool('dumpEnv', {})) as { content: Array<{ text: string }> };
      const env = JSON.parse(result.content[0].text) as Record<string, string>;

      expect(env.THIRD_PARTY_TOKEN).toBe('abc');
      // The whole point: a secret held by this process is not in the child's environment.
      expect(env.B4M_TEST_PLATFORM_SECRET).toBeUndefined();
      expect(env.NODE_OPTIONS).toBeUndefined();
      // A caller-supplied command already owns its argv, so a proxy it configures is honoured.
      expect(env.HTTPS_PROXY).toBe('http://corp-proxy.internal:8080');
    } finally {
      delete process.env.B4M_TEST_PLATFORM_SECRET;
      await client.disconnect();
    }
  });
});
