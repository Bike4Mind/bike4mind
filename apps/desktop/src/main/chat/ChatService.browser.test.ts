import { mkdtemp, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import type { AuthenticatedApiClient } from '@bike4mind/client-auth';
import type { ChatModelOption, ChatStreamEvent } from '@shared/chat';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ChatService } from './ChatService';
import { MediaStore } from './media/MediaStore';
import type { ModelCatalog } from './ModelCatalog';
import { SessionStore } from './SessionStore';
import type { AccessStore } from './tools/AccessStore';
import type { BrowserPage, BrowserProvider } from './tools/types';

function frame(payload: unknown): string {
  return `data: ${typeof payload === 'string' ? payload : JSON.stringify(payload)}\n\n`;
}

type WireMessage = { role: string; content: unknown };

describe('ChatService agent browser', () => {
  let service: ChatService;
  let events: ChatStreamEvent[];
  let post: ReturnType<typeof vi.fn>;
  let streams: PassThrough[];
  let root: string;
  let closed: string[];
  let models: ChatModelOption[];

  const page: BrowserPage = {
    currentUrl: () => 'http://localhost:3080/app',
    navigate: async url => ({ url, title: 'App' }),
    back: async () => undefined,
    snapshot: async () => ({
      url: 'http://localhost:3080/app',
      title: 'App',
      text: '[1] button "Add"',
      truncated: false,
    }),
    click: async () => 'Add',
    fill: async () => 'filled',
    press: async () => undefined,
    screenshot: async () => Buffer.from([137, 80, 78, 71]),
    evaluate: async () => null,
    drainEvents: () => [],
    settle: async () => undefined,
    close: async () => undefined,
  };

  beforeEach(async () => {
    root = await realpath(await mkdtemp(join(tmpdir(), 'b4m-browser-')));
    events = [];
    streams = [];
    closed = [];
    models = [{ id: 'test-model', name: 'Test', backend: 'openai' }];
    post = vi.fn().mockImplementation(() => {
      const stream = new PassThrough();
      streams.push(stream);
      return Promise.resolve({ data: stream, status: 200 });
    });
    const browser: BrowserProvider = {
      context: (_sessionId, keepScreenshot) => ({ page: async () => page, keepScreenshot }),
      closeSession: async sessionId => {
        closed.push(sessionId);
      },
    };
    service = new ChatService({
      store: new SessionStore(await mkdtemp(join(tmpdir(), 'b4m-browser-sessions-')), 'test-model'),
      access: { list: async () => [root] } as unknown as AccessStore,
      media: new MediaStore(await mkdtemp(join(tmpdir(), 'b4m-browser-media-'))),
      models: { list: async () => ({ models }), cached: () => [] } as unknown as ModelCatalog,
      browser,
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

  /** Run one screenshot round and return the messages the follow-up request carried. */
  async function screenshotRound(sessionId: string): Promise<WireMessage[]> {
    await service.send(sessionId, 'check the page');
    await vi.waitUntil(() => streams.length === 1, { timeout: 3000, interval: 5 });
    streams[0].write(
      frame({ type: 'tool_use', tools: [{ id: 'shot_1', name: 'browser_screenshot', arguments: '{}' }] })
    );
    streams[0].write(frame('[DONE]'));
    await vi.waitUntil(() => post.mock.calls.length === 2, { timeout: 3000, interval: 5 });
    streams[1].write(frame({ type: 'content', text: 'Looks right.' }));
    streams[1].write(frame('[DONE]'));
    await vi.waitUntil(() => events.find(event => event.type === 'done'), { timeout: 3000, interval: 5 });
    return post.mock.calls[1][1].messages as WireMessage[];
  }

  it('declares the browser tools in a Code session and says how to use them', async () => {
    const id = await codeSession();
    await service.send(id, 'hi');
    await vi.waitUntil(() => streams.length === 1, { timeout: 3000, interval: 5 });
    const request = post.mock.calls[0][1];
    const names = request.options.tools.map((entry: { toolSchema: { name: string } }) => entry.toolSchema.name);
    expect(names).toEqual(expect.arrayContaining(['browser_navigate', 'browser_click', 'browser_screenshot']));
    expect(request.messages[0].content).toContain('You also have a browser');
  });

  it('offers the browser to a Chat session, which has no project, and still withholds the host tools', async () => {
    const { id } = await service.createSession();
    await service.send(id, 'hi');
    await vi.waitUntil(() => streams.length === 1, { timeout: 3000, interval: 5 });
    const request = post.mock.calls[0][1];
    const names = request.options.tools.map((entry: { toolSchema: { name: string } }) => entry.toolSchema.name);
    expect(names).toEqual(expect.arrayContaining(['browser_navigate', 'browser_click', 'browser_screenshot']));
    // Widening the browser must not widen the host family, which really is project-scoped.
    expect(names).not.toContain('session_spawn');
    expect(names).not.toContain('session_list');
    expect(request.messages[0].content).toContain('You also have a browser');
  });

  it('drives the browser from a Chat session and keeps its screenshot', async () => {
    const { id } = await service.createSession();
    const messages = await screenshotRound(id);
    expect(JSON.stringify(messages)).toContain('"type":"image"');
    const end = events.find(event => event.type === 'tool-end');
    expect(end && 'call' in end ? end.call.media?.[0] : undefined).toMatchObject({
      kind: 'image',
      mimeType: 'image/png',
    });
  });

  it('sends a screenshot to the model as its own user turn after the tool results, and shows it to the user', async () => {
    const id = await codeSession();
    const messages = await screenshotRound(id);
    const resultTurn = messages.findIndex(
      message => Array.isArray(message.content) && (message.content as { type: string }[])[0]?.type === 'tool_result'
    );
    expect(messages[resultTurn + 1]).toEqual({
      role: 'user',
      content: [
        { type: 'text', text: 'Screenshot from the browser_screenshot call above.' },
        {
          type: 'image',
          source: { type: 'base64', media_type: 'image/png', data: Buffer.from([137, 80, 78, 71]).toString('base64') },
        },
      ],
    });

    const end = events.find(event => event.type === 'tool-end');
    expect(end && 'call' in end ? end.call.media?.[0] : undefined).toMatchObject({
      kind: 'image',
      mimeType: 'image/png',
    });
  });

  it('keeps the screenshot away from a model that says it takes no images', async () => {
    models = [{ id: 'test-model', name: 'Test', backend: 'openai', supportsVision: false }];
    const id = await codeSession();
    const messages = await screenshotRound(id);
    expect(JSON.stringify(messages)).not.toContain('"type":"image"');
  });

  it('closes the browser with its conversation', async () => {
    const id = await codeSession();
    await service.deleteSession(id);
    expect(closed).toEqual([id]);
  });
});
