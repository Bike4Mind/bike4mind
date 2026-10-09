import { mkdtemp, readdir, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import { fileURLToPath } from 'node:url';
import type { AuthenticatedApiClient } from '@bike4mind/client-auth';
import type { ChatApprovalMode, ChatStreamEvent, ChatToolCall } from '@shared/chat';
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest';
import { ChatService } from './ChatService';
import { McpManager } from './mcp/McpManager';
import { McpServerStore, type SecretCipher, type StoreFile } from './mcp/McpServerStore';
import { SessionStore } from './SessionStore';
import type { AccessStore } from './tools/AccessStore';
import { ApprovalGate } from './tools/ApprovalGate';

/**
 * The assistant installing an MCP server: the card only a click answers, the secret that never
 * comes back, and the new server's tools arriving in the same turn. Every server here is a
 * fixture under mcp/__fixtures__, and the store is in memory - nothing touches the real profile.
 */
const ECHO_SERVER = fileURLToPath(new URL('./mcp/__fixtures__/echoServer.mjs', import.meta.url));
const CRASH_SERVER = fileURLToPath(new URL('./mcp/__fixtures__/crashServer.mjs', import.meta.url));

const SECRET = 'value-the-model-must-never-see-7Q2x';

function frame(payload: unknown): string {
  return `data: ${typeof payload === 'string' ? payload : JSON.stringify(payload)}\n\n`;
}

const cipher: SecretCipher = {
  isEncryptionAvailable: () => true,
  encryptString: plain => Buffer.from(plain, 'utf8'),
  decryptString: encrypted => encrypted.toString('utf8'),
};

function memoryFile(): StoreFile {
  let contents: string | null = null;
  return {
    read: () => Promise.resolve(contents),
    write: next => {
      contents = next;
      return Promise.resolve();
    },
  };
}

describe('ChatService installing an MCP server', () => {
  let service: ChatService;
  let approvals: ApprovalGate;
  let mcp: McpManager;
  let events: ChatStreamEvent[];
  let post: ReturnType<typeof vi.fn>;
  let streams: PassThrough[];
  let logger: { debug: Mock<(message: string) => void>; warn: Mock<(message: string) => void> };
  let sessionsDir: string;

  const awaiting = () =>
    events.filter(
      (event): event is Extract<ChatStreamEvent, { type: 'tool-start' }> =>
        event.type === 'tool-start' && event.call.status === 'awaiting-approval'
    );

  async function card(): Promise<ChatToolCall> {
    const event = await vi.waitUntil(() => awaiting()[0], { timeout: 10_000, interval: 5 });
    return event.call;
  }

  async function startTurn(mode: ChatApprovalMode, tool: string, args: Record<string, unknown>): Promise<string> {
    const { id } = await service.createSession();
    await service.setApprovalMode(id, mode);
    await service.send(id, 'connect it');
    await vi.waitUntil(() => streams.length === 1, { timeout: 10_000, interval: 5 });
    streams[0].write(
      frame({ type: 'tool_use', tools: [{ id: 'call_1', name: tool, arguments: JSON.stringify(args) }] })
    );
    streams[0].write(frame('[DONE]'));
    return id;
  }

  /** The tool_result the second request carried back, and the tool names it declared. */
  async function secondRequest(): Promise<{
    result: { content: string; is_error?: boolean };
    tools: string[];
    system: string;
  }> {
    await vi.waitUntil(() => post.mock.calls.length === 2, { timeout: 20_000, interval: 10 });
    const body = post.mock.calls[1][1];
    return {
      result: body.messages[3].content[0],
      tools: body.options.tools.map((entry: { toolSchema: { name: string } }) => entry.toolSchema.name),
      system: body.messages[0].content,
    };
  }

  async function finish(sessionId: string): Promise<void> {
    await vi.waitUntil(() => streams.length === 2, { timeout: 10_000, interval: 5 });
    streams[1].write(frame({ type: 'content', text: 'done' }));
    streams[1].write(frame('[DONE]'));
    await vi.waitUntil(() => events.some(event => event.type === 'done' && event.sessionId === sessionId), {
      timeout: 10_000,
      interval: 5,
    });
  }

  beforeEach(async () => {
    logger = { debug: vi.fn<(message: string) => void>(), warn: vi.fn<(message: string) => void>() };
    approvals = new ApprovalGate();
    events = [];
    streams = [];
    post = vi.fn().mockImplementation(() => {
      const stream = new PassThrough();
      streams.push(stream);
      return Promise.resolve({ data: stream, status: 200 });
    });
    mcp = new McpManager(new McpServerStore(cipher, memoryFile(), logger), logger, () => undefined);
    sessionsDir = await mkdtemp(join(tmpdir(), 'b4m-mcp-install-'));

    service = new ChatService({
      store: new SessionStore(sessionsDir, 'test-model'),
      access: { list: async () => [] } as unknown as AccessStore,
      approvals,
      mcp,
      logger,
      getApiClient: () =>
        ({
          get: vi.fn().mockResolvedValue({}),
          getAxiosInstance: () => ({ post }),
        }) as unknown as AuthenticatedApiClient,
      getEnvironmentUrl: () => 'http://localhost:3000',
      emit: event => events.push(event),
    });
  });

  afterEach(async () => {
    await mcp.shutdown();
  });

  it('tells the model which app it is in and that no server is configured', async () => {
    const { id } = await service.createSession();
    await service.send(id, 'connect to my CAD app');
    await vi.waitUntil(() => streams.length === 1, { timeout: 10_000, interval: 5 });

    const body = post.mock.calls[0][1];
    const system: string = body.messages[0].content;
    expect(system).toContain('Bike4Mind desktop app');
    expect(system).toContain('MCP servers configured in this app: none configured.');
    expect(system).not.toMatch(/Settings\s*->\s*Computer use/i);
    const declared = body.options.tools.map((entry: { toolSchema: { name: string } }) => entry.toolSchema.name);
    expect(declared).toEqual(expect.arrayContaining(['mcp_list_servers', 'mcp_add_server', 'mcp_remove_server']));
  }, 30_000);

  it('lists every configured server with its state', async () => {
    await mcp.addServer({ name: 'echo', transport: 'stdio', command: process.execPath, args: [ECHO_SERVER] });
    await mcp.addServer({ name: 'crash', transport: 'stdio', command: process.execPath, args: [CRASH_SERVER] });
    await mcp.addServer({ name: 'off', transport: 'stdio', command: 'nothing', enabled: false });

    const { id } = await service.createSession();
    await service.send(id, 'hi');
    await vi.waitUntil(() => streams.length === 1, { timeout: 20_000, interval: 5 });

    const system: string = post.mock.calls[0][1].messages[0].content;
    expect(system).toContain('- echo: connected, 4 tools');
    expect(system).toMatch(/- crash: failed: /);
    expect(system).toContain('- off: disabled');
    // The list is last, after everything stable.
    expect(system.trimEnd().endsWith('- off: disabled')).toBe(true);
  }, 30_000);

  it('asks for a click on mcp_add_server even with full access on', async () => {
    await startTurn('full', 'mcp_add_server', {
      name: 'echo',
      transport: 'stdio',
      command: process.execPath,
      args: [ECHO_SERVER],
      reason: 'test fixture',
    });

    const shown = await card();
    expect(shown.name).toBe('mcp_add_server');
    expect(shown.input.command).toBe(process.execPath);
    expect(shown.input.args).toEqual([ECHO_SERVER]);
    // Parked: nothing saved, no further request while the card is up.
    await new Promise(resolve => setTimeout(resolve, 150));
    expect(post).toHaveBeenCalledTimes(1);
    expect((await mcp.state()).servers).toHaveLength(0);
  }, 30_000);

  it('connects an approved server and offers its tools on the next round of the same turn', async () => {
    await startTurn('ask', 'mcp_add_server', {
      name: 'echo',
      transport: 'stdio',
      command: process.execPath,
      args: [ECHO_SERVER],
      reason: 'test fixture',
    });
    approvals.resolve((await card()).approvalId!, { decision: 'once' });

    const { result, tools, system } = await secondRequest();
    expect(result.is_error).toBeUndefined();
    expect(result.content).toContain('mcp__echo_echo');
    expect(tools).toContain('mcp__echo_echo');
    expect(system).toContain('- echo: connected, 4 tools');
    const [server] = (await mcp.state()).servers;
    expect(server.addedBy?.sessionTitle).toBeTruthy();
  }, 30_000);

  it('keeps the typed secret out of the result, the transcript, the events and the log', async () => {
    const id = await startTurn('ask', 'mcp_add_server', {
      name: 'echo',
      transport: 'stdio',
      command: process.execPath,
      args: [ECHO_SERVER],
      env_keys: [{ name: 'MCP_FIXTURE_TOKEN', description: 'from the fixture' }],
      reason: 'test fixture',
    });
    const shown = await card();
    expect(shown.input.env_keys).toEqual([{ name: 'MCP_FIXTURE_TOKEN', description: 'from the fixture' }]);
    approvals.resolve(shown.approvalId!, {
      decision: 'once',
      // A key the card never showed must not reach the child's environment either.
      secrets: { env: { MCP_FIXTURE_TOKEN: SECRET, NODE_OPTIONS: '--require=evil' } },
    });

    await secondRequest();
    await finish(id);

    const [server] = (await mcp.state()).servers;
    expect(server.envKeys).toEqual(['MCP_FIXTURE_TOKEN']);

    const transcripts = await Promise.all(
      (await readdir(sessionsDir, { recursive: true }))
        .filter(file => file.endsWith('.json'))
        .map(file => readFile(join(sessionsDir, file), 'utf8'))
    );
    // Not vacuous: the stored transcript is there, and holds the call with its key NAME.
    expect(transcripts.join('\n')).toContain('MCP_FIXTURE_TOKEN');

    const everything = [
      JSON.stringify(post.mock.calls.map(call => call[1])),
      JSON.stringify(events),
      JSON.stringify(logger.debug.mock.calls),
      JSON.stringify(logger.warn.mock.calls),
      JSON.stringify(await mcp.state()),
      ...transcripts,
    ].join('\n');
    expect(everything).not.toContain(SECRET);
  }, 30_000);

  it('refuses a call that passes secret values itself, without a card', async () => {
    await startTurn('ask', 'mcp_add_server', {
      name: 'echo',
      transport: 'stdio',
      command: process.execPath,
      env: { API_KEY: SECRET },
      reason: 'test fixture',
    });

    const { result } = await secondRequest();
    expect(result.is_error).toBe(true);
    expect(result.content).toContain('env_keys');
    expect(awaiting()).toHaveLength(0);
    const stored = events.filter(event => event.type === 'tool-end').map(event => JSON.stringify(event));
    expect(stored.join('\n')).not.toContain(SECRET);
  }, 30_000);

  it('flags a token-looking argument on the card and tells the model to use env_keys', async () => {
    await startTurn('ask', 'mcp_add_server', {
      name: 'echo',
      transport: 'stdio',
      command: process.execPath,
      args: [ECHO_SERVER, '--api-key', 'ghp_a1B2c3D4e5F6g7H8i9J0k1L2m3N4'],
      reason: 'test fixture',
    });
    const shown = await card();
    expect(shown.approvalWarning).toMatch(/argument 3/);
    approvals.resolve(shown.approvalId!, { decision: 'once' });

    const { result } = await secondRequest();
    expect(result.content).toContain('env_keys');
    // The replayed tool_use and the result carry the position of the flag, never the token.
    expect(JSON.stringify(post.mock.calls[1][1])).not.toContain('ghp_a1B2c3D4e5F6g7H8i9J0k1L2m3N4');
  }, 30_000);

  it('returns the error and a stderr tail when the added server fails', async () => {
    await startTurn('ask', 'mcp_add_server', {
      name: 'crash',
      transport: 'stdio',
      command: process.execPath,
      args: [CRASH_SERVER],
      reason: 'test fixture',
    });
    approvals.resolve((await card()).approvalId!, { decision: 'once' });

    const { result } = await secondRequest();
    expect(result.is_error).toBe(true);
    expect(result.content).toContain('FATAL: MCP_FIXTURE_TOKEN is not set');
    expect(result.content).toContain('mcp_update_server');
  }, 30_000);

  it('saves nothing when the card is declined', async () => {
    await startTurn('ask', 'mcp_add_server', {
      name: 'echo',
      transport: 'stdio',
      command: process.execPath,
      args: [ECHO_SERVER],
      reason: 'test fixture',
    });
    approvals.resolve((await card()).approvalId!, { decision: 'deny' });

    const { result } = await secondRequest();
    expect(result.is_error).toBe(true);
    expect((await mcp.state()).servers).toHaveLength(0);
  }, 30_000);

  it('closes the card on a stop, so a late click saves nothing', async () => {
    const id = await startTurn('ask', 'mcp_add_server', {
      name: 'echo',
      transport: 'stdio',
      command: process.execPath,
      args: [ECHO_SERVER],
      reason: 'test fixture',
    });
    const shown = await card();
    await service.stop(id);
    approvals.resolve(shown.approvalId!, { decision: 'once', secrets: { env: {} } });

    const done = await vi.waitUntil(
      () => events.find((event): event is Extract<ChatStreamEvent, { type: 'done' }> => event.type === 'done'),
      { timeout: 10_000, interval: 5 }
    );
    expect((await mcp.state()).servers).toHaveLength(0);
    // The renderer swaps in these settled calls on 'done', so no live approve button remains.
    expect(done.toolCalls?.some(call => call.status === 'awaiting-approval' || call.approvalId)).toBe(false);
  }, 30_000);

  it('asks before removing a server, even with full access on', async () => {
    await mcp.addServer({ name: 'off', transport: 'stdio', command: 'nothing', enabled: false });
    await startTurn('full', 'mcp_remove_server', { server: 'off' });

    const shown = await card();
    expect(shown.approvalIrreversible).toBe(true);
    expect((await mcp.state()).servers).toHaveLength(1);
  }, 30_000);

  it('asks before switching a server off', async () => {
    await mcp.addServer({ name: 'echo', transport: 'stdio', command: process.execPath, args: [ECHO_SERVER] });
    await startTurn('ask', 'mcp_set_server_enabled', { server: 'echo', enabled: false });

    const shown = await card();
    expect(shown.approvalDetail).toContain('Turn off');
    expect((await mcp.state()).servers[0].enabled).toBe(true);
  }, 30_000);
});
