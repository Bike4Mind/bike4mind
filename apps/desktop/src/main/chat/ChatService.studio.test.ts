import { mkdtemp, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import type { AuthenticatedApiClient } from '@bike4mind/client-auth';
import type { ChatModelOption, ChatStreamEvent } from '@shared/chat';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ChatService } from './ChatService';
import { MediaStore } from './media/MediaStore';
import { SessionActivity } from './SessionActivity';
import type { ModelCatalog } from './ModelCatalog';
import { SessionStore } from './SessionStore';
import type { AccessStore } from './tools/AccessStore';
import { ApprovalGate } from './tools/ApprovalGate';
import type { BrowserProvider } from './tools/types';

vi.mock('../git/hostGitArgs', async importOriginal =>
  (await import('./plainFolderGit.testHelper')).skipGitOutsideRepositories(await importOriginal())
);

const MEDIA_TOOL_NAMES = [
  'generate_image',
  'generate_speech',
  'generate_sound_effect',
  'generate_music',
  'generate_video',
];

function frame(payload: unknown): string {
  return `data: ${typeof payload === 'string' ? payload : JSON.stringify(payload)}\n\n`;
}

const toolNames = (request: { options: { tools?: { toolSchema: { name: string } }[] } }) =>
  (request.options.tools ?? []).map(entry => entry.toolSchema.name);

describe('ChatService Studio sessions', () => {
  let service: ChatService;
  let events: ChatStreamEvent[];
  let post: ReturnType<typeof vi.fn>;
  let streams: PassThrough[];
  let root: string;
  let store: SessionStore;

  beforeEach(async () => {
    // A folder shared with the app globally: a Chat session would get it, a Studio one must not.
    root = await realpath(await mkdtemp(join(tmpdir(), 'b4m-studio-')));
    const emitted: ChatStreamEvent[] = [];
    events = emitted;
    const opened: PassThrough[] = [];
    streams = opened;
    const models: ChatModelOption[] = [{ id: 'test-model', name: 'Test', backend: 'openai' }];
    const boundPost = vi.fn().mockImplementation(() => {
      const stream = new PassThrough();
      opened.push(stream);
      return Promise.resolve({ data: stream, status: 200 });
    });
    post = boundPost;
    // Every conversation is handed a browser context; only the offer decides what it can call.
    const browser = {
      context: () => ({}),
      closeSession: async () => undefined,
    } as unknown as BrowserProvider;
    store = new SessionStore(await mkdtemp(join(tmpdir(), 'b4m-studio-sessions-')), 'test-model');
    service = new ChatService({
      store,
      approvals: new ApprovalGate(),
      activity: new SessionActivity(() => undefined),
      access: { list: async () => [root] } as unknown as AccessStore,
      media: new MediaStore(await mkdtemp(join(tmpdir(), 'b4m-studio-media-'))),
      models: { list: async () => ({ models }), cached: () => [] } as unknown as ModelCatalog,
      browser,
      logger: { debug: vi.fn(), warn: vi.fn() },
      getApiClient: () =>
        ({
          get: vi.fn().mockResolvedValue({}),
          getAxiosInstance: () => ({ post: boundPost }),
        }) as unknown as AuthenticatedApiClient,
      getEnvironmentUrl: () => 'http://localhost:3000',
      emit: event => emitted.push(event),
    });
  });

  afterEach(() => {
    service.dispose();
    for (const stream of streams) stream.end();
  });

  it('starts a Studio session that reads back as one', async () => {
    const created = await service.createSession('studio');
    expect(created.mode).toBe('studio');
    expect((await store.get(created.id))?.mode).toBe('studio');
    expect((await service.createSession()).mode).toBe('chat');
  });

  it('offers only the generation tools, and its prompt names nothing else', async () => {
    const { id } = await service.createSession('studio');
    await service.send(id, 'a poster for a jazz night');
    await vi.waitUntil(() => streams.length === 1, { timeout: 3000, interval: 5 });
    const request = post.mock.calls[0][1];
    const names = toolNames(request);
    expect(names).toContain('generate_image');
    expect(names.filter(name => !MEDIA_TOOL_NAMES.includes(name))).toEqual([]);
    const system = String(request.messages[0].content);
    expect(system).not.toContain('You also have a browser');
    expect(system).not.toContain('todo_write');
    expect(system).not.toContain(root);
  });

  it('resolves no folder for a Studio session, whatever it or the app was granted', async () => {
    const { id } = await service.createSession('studio');
    const own = await realpath(await mkdtemp(join(tmpdir(), 'b4m-studio-own-')));
    await store.addGrantedDirectory(id, own);
    expect((await service.fileLinkScope(id))?.roots).toEqual([]);
    expect(await service.studioContextRoots(id)).toEqual([]);
    const chat = await service.createSession();
    expect((await service.fileLinkScope(chat.id))?.roots).toContain(root);
  });

  it('keeps the Chat tool set for a Chat session in the same app', async () => {
    const { id } = await service.createSession();
    await service.send(id, 'hi');
    await vi.waitUntil(() => streams.length === 1, { timeout: 3000, interval: 5 });
    const names = toolNames(post.mock.calls[0][1]);
    expect(names).toEqual(expect.arrayContaining(['bash_execute', 'file_read', 'browser_navigate']));
  });

  it('refuses a tool it never offered, even one a Chat session would run', async () => {
    const { id } = await service.createSession('studio');
    await service.send(id, 'list my files');
    await vi.waitUntil(() => streams.length === 1, { timeout: 3000, interval: 5 });
    streams[0].write(
      frame({
        type: 'tool_use',
        tools: [
          { id: 'shell_1', name: 'bash_execute', arguments: JSON.stringify({ command: 'ls' }) },
          { id: 'web_1', name: 'browser_navigate', arguments: JSON.stringify({ url: 'https://example.com' }) },
        ],
      })
    );
    streams[0].write(frame('[DONE]'));
    await vi.waitUntil(() => post.mock.calls.length === 2, { timeout: 3000, interval: 5 });
    const ended = events.flatMap(event => (event.type === 'tool-end' ? [event.call] : []));
    expect(ended.map(call => [call.name, call.status])).toEqual([
      ['bash_execute', 'error'],
      ['browser_navigate', 'error'],
    ]);
    for (const call of ended) expect(call.error).toContain('not available in this conversation');
  });
});
