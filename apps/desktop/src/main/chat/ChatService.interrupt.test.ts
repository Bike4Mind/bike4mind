import { mkdtemp, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import type { AuthenticatedApiClient } from '@bike4mind/client-auth';
import type { ChatModelOption, ChatStreamEvent } from '@shared/chat';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ChatService } from './ChatService';
import type { McpManager } from './mcp/McpManager';
import { MessageQueue } from './MessageQueue';
import type { ModelCatalog } from './ModelCatalog';
import { SessionStore } from './SessionStore';
import type { AccessStore } from './tools/AccessStore';
import type { BrowserPage, BrowserProvider, ToolDefinition, ToolReporter } from './tools/types';

function frame(payload: unknown): string {
  return `data: ${typeof payload === 'string' ? payload : JSON.stringify(payload)}\n\n`;
}

type WireMessage = { role: string; content: unknown };

/**
 * Stop and "send now" while a tool is still running.
 *
 * The fixture is an MCP tool that never resolves and never reads the turn's signal - the shape of
 * any tool the executor has to stop waiting on rather than wait out.
 */
describe('ChatService interrupting a running tool', () => {
  let service: ChatService;
  let store: SessionStore;
  let queue: MessageQueue;
  let events: ChatStreamEvent[];
  let post: ReturnType<typeof vi.fn>;
  let streams: PassThrough[];
  let root: string;
  let finishNavigation: ((value: { url: string; title: string }) => void) | undefined;
  let stoppedLoading: number;
  let finishHung: ((value: string) => void) | undefined;
  let hungReport: ToolReporter | undefined;

  const hungTool: ToolDefinition = {
    schema: { name: 'mcp__slow_wait', description: 'Waits.', parameters: { type: 'object', properties: {} } },
    run: (input, context) =>
      new Promise(resolve => {
        if (input.write === true) context.beginWrite?.();
        hungReport = context.report;
        finishHung = resolve;
      }),
  };

  const page: BrowserPage = {
    currentUrl: () => 'http://localhost:3080/app',
    navigate: () =>
      new Promise(resolve => {
        finishNavigation = resolve;
      }),
    back: async () => undefined,
    snapshot: async () => ({ url: 'http://localhost:3080/app', title: 'App', text: 'late page', truncated: false }),
    click: async () => 'Add',
    fill: async () => 'filled',
    press: async () => undefined,
    screenshot: async () => Buffer.from([137, 80, 78, 71]),
    evaluate: async () => null,
    drainEvents: () => [],
    settle: async () => undefined,
    close: async () => undefined,
    stop: () => {
      stoppedLoading += 1;
    },
  };

  beforeEach(async () => {
    root = await realpath(await mkdtemp(join(tmpdir(), 'b4m-interrupt-')));
    events = [];
    streams = [];
    finishNavigation = undefined;
    finishHung = undefined;
    hungReport = undefined;
    stoppedLoading = 0;
    post = vi.fn().mockImplementation(() => {
      const stream = new PassThrough();
      streams.push(stream);
      return Promise.resolve({ data: stream, status: 200 });
    });
    const models: ChatModelOption[] = [{ id: 'test-model', name: 'Test', backend: 'openai' }];
    const browser: BrowserProvider = {
      context: (_sessionId, keepScreenshot) => ({
        page: async () => page,
        keepScreenshot,
        usesImportedCookies: () => false,
      }),
      closeSession: async () => undefined,
    };
    store = new SessionStore(await mkdtemp(join(tmpdir(), 'b4m-interrupt-sessions-')), 'test-model');
    queue = new MessageQueue(() => undefined);
    service = new ChatService({
      store,
      queue,
      access: { list: async () => [root] } as unknown as AccessStore,
      models: { list: async () => ({ models }), cached: () => [] } as unknown as ModelCatalog,
      browser,
      mcp: {
        ensureConnected: async () => undefined,
        tools: () => [],
        connectedServerNames: () => [],
        findTool: (name: string) => (name === hungTool.schema.name ? hungTool : undefined),
      } as unknown as McpManager,
      logger: { debug: vi.fn(), warn: vi.fn() },
      getApiClient: () =>
        ({
          get: vi.fn().mockResolvedValue({}),
          getAxiosInstance: () => ({ post }),
        }) as unknown as AuthenticatedApiClient,
      getEnvironmentUrl: () => 'http://localhost:3000',
      emit: event => events.push(event),
    });
  });

  afterEach(() => {
    service.dispose();
    for (const stream of streams) stream.end();
  });

  async function codeSession(): Promise<string> {
    const created = await service.createCodeSession({ directory: root, branch: '', workspace: false });
    if (!created.ok) throw new Error(created.error);
    return created.session.id;
  }

  /** A turn whose first round calls `name` and is still waiting on it. */
  async function hangOn(name: string, args: string, started: () => boolean): Promise<string> {
    const id = await codeSession();
    await service.send(id, 'open the app');
    await vi.waitUntil(() => streams.length === 1, { timeout: 3000, interval: 5 });
    streams[0].write(frame({ type: 'tool_use', tools: [{ id: 'call_1', name, arguments: args }] }));
    streams[0].write(frame('[DONE]'));
    await vi.waitUntil(started, { timeout: 3000, interval: 5 });
    return id;
  }

  const hangOnTool = () => hangOn(hungTool.schema.name, '{}', () => finishHung !== undefined);
  const turnDone = (id: string) =>
    vi.waitUntil(() => events.some(event => event.type === 'done' && event.sessionId === id), {
      timeout: 3000,
      interval: 5,
    });
  const storedCall = async (id: string) => (await service.getSession(id))?.messages.at(-1)?.toolCalls?.[0];

  it('ends a stopped turn promptly and records the hung call as interrupted', async () => {
    const id = await hangOnTool();

    const stoppedAt = Date.now();
    service.stop(id);
    await turnDone(id);

    expect(Date.now() - stoppedAt).toBeLessThan(2000);
    expect(events.find(event => event.type === 'done' && event.sessionId === id)).toMatchObject({
      stopReason: 'aborted',
    });
    const ended = events.find(event => event.type === 'tool-end' && event.sessionId === id);
    expect(ended?.type === 'tool-end' && ended.call).toMatchObject({
      id: 'call_1',
      status: 'error',
      error: expect.stringMatching(/^Interrupted/),
    });
    expect(await storedCall(id)).toMatchObject({
      id: 'call_1',
      status: 'error',
      error: expect.stringMatching(/^Interrupted/),
    });
  });

  it('drops a result that arrives after the turn has moved on', async () => {
    const id = await hangOnTool();
    service.stop(id);
    await turnDone(id);
    const settledEvents = events.length;

    hungReport?.progress('still going');
    hungReport?.image(Buffer.from('late'), 'image/png');
    finishHung?.('late result');
    await new Promise(resolve => setTimeout(resolve, 50));

    expect(events.slice(settledEvents).filter(event => event.sessionId === id)).toEqual([]);
    const stored = await storedCall(id);
    expect(stored).toMatchObject({ status: 'error', error: expect.stringMatching(/^Interrupted/) });
    expect(stored?.preview).toBeUndefined();

    // The next turn's wire carries the interrupted row, never the late result or its image.
    await service.send(id, 'what happened?');
    await vi.waitUntil(() => post.mock.calls.length === 2, { timeout: 3000, interval: 5 });
    const wire = JSON.stringify((post.mock.calls[1][1] as { messages: WireMessage[] }).messages);
    expect(wire).toContain('Interrupted');
    expect(wire).not.toContain('late result');
    expect(wire).not.toContain(Buffer.from('late').toString('base64'));
  });

  it('sends a promoted message exactly once while a tool is hung', async () => {
    const id = await hangOnTool();
    const queued = await service.send(id, 'Whats taking too long?');
    const queuedId = queued.ok && queued.queued ? queued.message.id : '';

    service.sendQueuedNow(id, queuedId);
    // A second click while the first is unwinding.
    service.sendQueuedNow(id, queuedId);

    await vi.waitUntil(() => post.mock.calls.length === 2, { timeout: 2000, interval: 5 });
    // The abandoned call finishing now must not bring a second copy, or a second turn.
    finishHung?.('late result');
    await new Promise(resolve => setTimeout(resolve, 100));

    expect(post).toHaveBeenCalledTimes(2);
    expect(queue.list(id)).toEqual([]);
    const session = await service.getSession(id);
    expect(session?.messages.filter(message => message.role === 'user').map(message => message.content)).toEqual([
      'open the app',
      'Whats taking too long?',
    ]);
    expect(session?.messages[1]?.toolCalls?.[0]).toMatchObject({
      status: 'error',
      error: expect.stringMatching(/^Interrupted/),
    });
  });

  it('waits out a call that has started writing, and records what it wrote', async () => {
    const id = await hangOn(hungTool.schema.name, '{"write":true}', () => finishHung !== undefined);

    service.stop(id);
    await new Promise(resolve => setTimeout(resolve, 1000));
    expect(events.some(event => event.type === 'done' && event.sessionId === id)).toBe(false);

    finishHung?.('Written.');
    await turnDone(id);
    expect(await storedCall(id)).toMatchObject({ status: 'done', preview: 'Written.' });
  });

  it('stops a browser load when the turn is stopped, and says so', async () => {
    const id = await hangOn(
      'browser_navigate',
      '{"url":"http://localhost:3080/app"}',
      () => finishNavigation !== undefined
    );

    service.stop(id);
    await turnDone(id);

    expect(stoppedLoading).toBe(1);
    expect(await storedCall(id)).toMatchObject({ status: 'error', error: expect.stringMatching(/^Stopped/) });
  });
});
