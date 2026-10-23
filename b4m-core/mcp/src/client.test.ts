import { describe, it, expect, afterEach, vi } from 'vitest';
import { createServer, type IncomingMessage, type Server } from 'http';
import { randomUUID } from 'crypto';
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
  async function startServer(authHeaders: (string | undefined)[], toolCalls?: { count: number; fail404: boolean }) {
    httpServer = createServer(async (req, res) => {
      // Record the Authorization header on every request (the assertion target).
      authHeaders.push(req.headers['authorization']);
      if (toolCalls && req.method === 'POST') {
        const chunks: Buffer[] = [];
        for await (const chunk of req) chunks.push(chunk as Buffer);
        const body = JSON.parse(Buffer.concat(chunks).toString('utf8')) as { method?: string };
        if (body.method === 'tools/call') {
          toolCalls.count++;
          if (toolCalls.fail404) {
            res.writeHead(404).end('Not Found');
            return;
          }
        }
        const server = new McpServer({ name: 'test-server', version: '1.0.0' });
        server.registerTool('echo', { inputSchema: { msg: z.string() } }, async ({ msg }) => ({
          content: [{ type: 'text', text: `echo:${msg}` }],
        }));
        const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
        await server.connect(transport);
        await transport.handleRequest(req, res, body);
        return;
      }

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

  it('does not retry a 404 from a server that issued no session id', async () => {
    const toolCalls = { count: 0, fail404: false };
    const url = await startServer([], toolCalls);
    const client = new MCPClient({ envVariables: [], name: 'host', url });
    await client.connectToServer();
    toolCalls.fail404 = true;

    await expect(client.callTool('echo', { msg: 'x' })).rejects.toThrow(/Not Found/);
    expect(toolCalls.count).toBe(1);
    await client.disconnect();
  });

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
 * A server that expires sessions, the way a host with an idle keep-alive does. After expiry it answers
 * every request carrying the old `Mcp-Session-Id` with 404 "Session not found", and the MCP spec says
 * the client must then start a new session. Driven against a real stateful SDK server transport.
 */
describe('MCPClient (expired streamable-HTTP session)', () => {
  let httpServer: Server | undefined;
  let client: MCPClient | undefined;

  afterEach(async () => {
    vi.restoreAllMocks();
    await client?.disconnect();
    client = undefined;
    if (httpServer) {
      httpServer.closeAllConnections();
      await new Promise<void>(resolve => httpServer!.close(() => resolve()));
      httpServer = undefined;
    }
  });

  async function readJson(req: IncomingMessage): Promise<unknown> {
    if (req.method !== 'POST') return undefined;
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(chunk as Buffer);
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  }

  async function startServer() {
    const sessions = new Map<string, StreamableHTTPServerTransport>();
    const state = {
      initializeCount: 0,
      toolCallCount: 0,
      slowRuns: 0,
      failToolCallsWith: undefined as number | undefined,
      failInitializeWith: undefined as number | undefined,
    };
    // `slow` signals when it starts running and finishes only when the test releases it.
    let slowStarted!: () => void;
    const slowRunning = new Promise<void>(resolve => (slowStarted = resolve));
    let releaseSlow!: () => void;
    const slowReleased = new Promise<void>(resolve => (releaseSlow = resolve));

    httpServer = createServer(async (req, res) => {
      const body = (await readJson(req)) as { method?: string } | undefined;
      const sessionId = req.headers['mcp-session-id'] as string | undefined;

      if (body?.method === 'tools/call') {
        state.toolCallCount++;
        if (state.failToolCallsWith) {
          res.writeHead(state.failToolCallsWith).end('boom');
          return;
        }
      }

      if (sessionId) {
        const transport = sessions.get(sessionId);
        if (!transport) {
          res
            .writeHead(404, { 'content-type': 'application/json' })
            .end(JSON.stringify({ jsonrpc: '2.0', error: { code: -32001, message: 'Session not found' }, id: null }));
          return;
        }
        await transport.handleRequest(req, res, body);
        return;
      }

      if (state.failInitializeWith) {
        res.writeHead(state.failInitializeWith).end('down');
        return;
      }
      state.initializeCount++;
      const server = new McpServer({ name: 'test-server', version: '1.0.0' });
      server.registerTool(
        'echo',
        { description: 'Echoes its input', inputSchema: { msg: z.string() } },
        async ({ msg }) => ({ content: [{ type: 'text', text: `echo:${msg}` }] })
      );
      server.registerTool('slow', { description: 'Runs until released', inputSchema: {} }, async () => {
        state.slowRuns++;
        slowStarted();
        await slowReleased;
        return { content: [{ type: 'text', text: 'slow' }] };
      });
      const transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: () => randomUUID(),
        onsessioninitialized: id => {
          sessions.set(id, transport);
        },
      });
      await server.connect(transport);
      await transport.handleRequest(req, res, body);
    });

    await new Promise<void>(resolve => httpServer!.listen(0, '127.0.0.1', () => resolve()));
    const { port } = httpServer!.address() as AddressInfo;

    /** Forget every session and close its streams, as an idle timeout does. */
    const expireSessions = async () => {
      const transports = [...sessions.values()];
      sessions.clear();
      await Promise.all(transports.map(t => t.close()));
    };

    /** Forget every session but leave open streams alone, so a response already being computed still arrives. */
    const forgetSessions = () => sessions.clear();

    return { url: `http://127.0.0.1:${port}/mcp`, state, expireSessions, forgetSessions, slowRunning, releaseSlow };
  }

  async function connect(url: string) {
    client = new MCPClient({ envVariables: [], name: 'host', url });
    await client.connectToServer();
    return client;
  }

  const textOf = (result: unknown) => (result as { content: Array<{ text: string }> }).content[0].text;

  it('starts a new session and retries the call once when the server has dropped the old one', async () => {
    const { url, state, expireSessions } = await startServer();
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
    const mcp = await connect(url);
    expect(textOf(await mcp.callTool('echo', { msg: 'before' }))).toBe('echo:before');

    await expireSessions();
    // Let the SDK's idle GET stream notice and fail its first reconnect (default delay 1s) - the
    // path that used to print stack traces into the terminal.
    await new Promise(resolve => setTimeout(resolve, 1200));

    expect(textOf(await mcp.callTool('echo', { msg: 'after' }))).toBe('echo:after');
    expect(state.initializeCount).toBe(2);
    // The failed POST plus its retry.
    expect(state.toolCallCount).toBe(3);
    expect(mcp.tools.map(t => t.name)).toEqual(['echo', 'slow']);
    expect(errors).not.toHaveBeenCalled();

    // The new session keeps working without another initialize.
    expect(textOf(await mcp.callTool('echo', { msg: 'again' }))).toBe('echo:again');
    expect(state.initializeCount).toBe(2);
  });

  it('opens one new session for calls that fail together', async () => {
    const { url, state, expireSessions } = await startServer();
    const mcp = await connect(url);
    await expireSessions();

    const results = await Promise.all([mcp.callTool('echo', { msg: 'a' }), mcp.callTool('echo', { msg: 'b' })]);

    expect(results.map(textOf)).toEqual(['echo:a', 'echo:b']);
    expect(state.initializeCount).toBe(2);
  });

  it('does not retry an error that is not an expired session', async () => {
    const { url, state } = await startServer();
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const mcp = await connect(url);
    state.failToolCallsWith = 500;

    await expect(mcp.callTool('echo', { msg: 'x' })).rejects.toThrow(/boom/);
    expect(state.toolCallCount).toBe(1);
    expect(state.initializeCount).toBe(1);
  });

  it('throws when the retry on the new session gets a 404 too, without retrying again', async () => {
    const { url, state, expireSessions } = await startServer();
    const mcp = await connect(url);
    await expireSessions();
    state.failToolCallsWith = 404;

    await expect(mcp.callTool('echo', { msg: 'x' })).rejects.toThrow(/boom/);
    // The first call and one retry, on one new session.
    expect(state.toolCallCount).toBe(2);
    expect(state.initializeCount).toBe(2);
  });

  it('tries again on the next call when opening the new session failed', async () => {
    const { url, state, expireSessions } = await startServer();
    const mcp = await connect(url);
    await expireSessions();
    state.failInitializeWith = 503;

    await expect(mcp.callTool('echo', { msg: 'down' })).rejects.toThrow();
    expect(state.initializeCount).toBe(1);

    state.failInitializeWith = undefined;
    expect(textOf(await mcp.callTool('echo', { msg: 'up' }))).toBe('echo:up');
    expect(state.initializeCount).toBe(2);
  });

  it('shares one renewal between concurrent calls after a failed one', async () => {
    const { url, state, expireSessions } = await startServer();
    const mcp = await connect(url);
    await expireSessions();
    state.failInitializeWith = 503;
    await expect(mcp.callTool('echo', { msg: 'down' })).rejects.toThrow();
    state.failInitializeWith = undefined;

    const results = await Promise.all([mcp.callTool('echo', { msg: 'a' }), mcp.callTool('echo', { msg: 'b' })]);

    expect(results.map(textOf)).toEqual(['echo:a', 'echo:b']);
    expect(state.initializeCount).toBe(2);
  });

  it('does not cut off or re-run a call in flight when another call renews the session', async () => {
    const { url, state, forgetSessions, slowRunning, releaseSlow } = await startServer();
    const mcp = await connect(url);

    const slow = mcp.callTool('slow', {});
    await slowRunning;
    // The server forgets the session while `slow` is running; the next call gets the 404 and renews.
    forgetSessions();
    expect(textOf(await mcp.callTool('echo', { msg: 'b' }))).toBe('echo:b');
    expect(state.initializeCount).toBe(2);

    releaseSlow();
    expect(textOf(await slow)).toBe('slow');
    expect(state.slowRuns).toBe(1);
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
