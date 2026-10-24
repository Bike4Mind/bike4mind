import { mkdtemp, realpath, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import type { AuthenticatedApiClient } from '@bike4mind/client-auth';
import type { ChatApprovalMode, ChatStreamEvent } from '@shared/chat';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ChatService } from './ChatService';
import { MediaStore } from './media/MediaStore';
import type { ModelCatalog } from './ModelCatalog';
import { SessionStore } from './SessionStore';
import type { AccessStore } from './tools/AccessStore';
import { ApprovalGate } from './tools/ApprovalGate';
import type { ScreenCapturer } from './tools/types';

function frame(payload: unknown): string {
  return `data: ${typeof payload === 'string' ? payload : JSON.stringify(payload)}\n\n`;
}

type WireMessage = { role: string; content: unknown };

const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.from('pixels')]);

describe('ChatService images shown by tools', () => {
  let service: ChatService;
  let events: ChatStreamEvent[];
  let post: ReturnType<typeof vi.fn>;
  let streams: PassThrough[];
  let root: string;
  let store: SessionStore;
  let capture: ReturnType<typeof vi.fn<ScreenCapturer['capture']>>;

  beforeEach(async () => {
    root = await realpath(await mkdtemp(join(tmpdir(), 'b4m-images-')));
    await writeFile(join(root, 'shot.png'), PNG);
    const emitted: ChatStreamEvent[] = [];
    events = emitted;
    const opened: PassThrough[] = [];
    streams = opened;
    post = vi.fn().mockImplementation(() => {
      const stream = new PassThrough();
      opened.push(stream);
      return Promise.resolve({ data: stream, status: 200 });
    });
    const boundPost = post;
    capture = vi.fn<ScreenCapturer['capture']>(async () => PNG);
    const screen: ScreenCapturer = {
      access: () => ({ state: 'granted' }),
      list: async () => [{ id: 'window:7:0', kind: 'window', name: 'My App - Dev' }],
      capture,
    };
    store = new SessionStore(await mkdtemp(join(tmpdir(), 'b4m-images-sessions-')), 'test-model');
    service = new ChatService({
      store,
      approvals: new ApprovalGate(),
      access: { list: async () => [root] } as unknown as AccessStore,
      media: new MediaStore(await mkdtemp(join(tmpdir(), 'b4m-images-media-'))),
      models: {
        list: async () => ({ models: [{ id: 'test-model', name: 'Test', backend: 'anthropic' }] }),
        cached: () => [],
      } as unknown as ModelCatalog,
      screen,
      prepareImage: (bytes, mediaType) => ({
        bytes,
        mediaType,
        width: 10,
        height: 10,
        sourceWidth: 10,
        sourceHeight: 10,
      }),
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

  async function codeSession(mode: ChatApprovalMode = 'ask'): Promise<string> {
    const created = await service.createCodeSession({ directory: root, branch: '', workspace: false });
    if (!created.ok) throw new Error(created.error);
    await store.setApprovalMode(created.session.id, mode);
    return created.session.id;
  }

  /** One round calling `tool`, then a plain answer; resolves with the follow-up request's messages. */
  async function toolRound(sessionId: string, name: string, args: Record<string, unknown>): Promise<WireMessage[]> {
    const before = post.mock.calls.length;
    await service.send(sessionId, 'look at it');
    await vi.waitUntil(() => streams.length === before + 1, { timeout: 3000, interval: 5 });
    streams[before].write(
      frame({ type: 'tool_use', tools: [{ id: `${name}_1`, name, arguments: JSON.stringify(args) }] })
    );
    streams[before].write(frame('[DONE]'));
    await vi.waitUntil(() => post.mock.calls.length === before + 2, { timeout: 3000, interval: 5 });
    streams[before + 1].write(frame({ type: 'content', text: 'Seen.' }));
    streams[before + 1].write(frame('[DONE]'));
    await vi.waitUntil(() => events.filter(event => event.type === 'done').length > 0, { timeout: 3000, interval: 5 });
    return post.mock.calls[before + 1][1].messages as WireMessage[];
  }

  it('shows the model a file_read image on the next request only, and never stores it', async () => {
    const id = await codeSession();
    const messages = await toolRound(id, 'file_read', { path: join(root, 'shot.png') });
    expect(messages.at(-1)).toMatchObject({
      role: 'user',
      content: [
        { type: 'text', text: 'Image from the file_read call above.' },
        { type: 'image', source: { type: 'base64', media_type: 'image/png', data: PNG.toString('base64') } },
      ],
    });

    const stored = JSON.stringify(await store.get(id));
    expect(stored).not.toContain(PNG.toString('base64'));
    expect(stored).toContain('is a PNG image');

    events.length = 0;
    await service.send(id, 'and now?');
    await vi.waitUntil(() => post.mock.calls.length === 3, { timeout: 3000, interval: 5 });
    expect(JSON.stringify(post.mock.calls[2][1].messages)).not.toContain('"type":"image"');
  });

  it('caps the images one round sends and tells the model how many were left out', async () => {
    const id = await codeSession('full');
    await service.send(id, 'look at them all');
    await vi.waitUntil(() => streams.length === 1, { timeout: 3000, interval: 5 });
    const tools = Array.from({ length: 10 }, (_, index) => ({
      id: `read_${index}`,
      name: 'file_read',
      arguments: JSON.stringify({ path: join(root, 'shot.png') }),
    }));
    streams[0].write(frame({ type: 'tool_use', tools }));
    streams[0].write(frame('[DONE]'));
    await vi.waitUntil(() => post.mock.calls.length === 2, { timeout: 3000, interval: 5 });
    const turn = (post.mock.calls[1][1].messages as WireMessage[]).at(-1);
    const content = turn?.content as { type: string; text?: string }[];
    expect(content.filter(block => block.type === 'image')).toHaveLength(8);
    expect(content[0].text).toBe(
      "Images from the file_read calls above. 2 more were left out to keep the request under the provider's size limit; read or capture them in smaller batches."
    );
  });

  it('declares screen_capture and tells the model what it is for', async () => {
    const id = await codeSession();
    await service.send(id, 'hi');
    await vi.waitUntil(() => streams.length === 1, { timeout: 3000, interval: 5 });
    const request = post.mock.calls[0][1];
    const names = request.options.tools.map((entry: { toolSchema: { name: string } }) => entry.toolSchema.name);
    expect(names).toContain('screen_capture');
    expect(request.messages[0].content).toContain('screen_capture looks at other apps');
    expect(request.messages[0].content).toContain('PNG, JPEG, GIF or WebP file as an image');
  });

  it('captures unasked in full access, and shows the capture to both the model and the user', async () => {
    const id = await codeSession('full');
    const messages = await toolRound(id, 'screen_capture', { target: 'My App' });
    expect(capture).toHaveBeenCalledWith('window:7:0', 1568);
    expect(JSON.stringify(messages.at(-1))).toContain('Image from the screen_capture call above.');
    const end = events.find(event => event.type === 'tool-end');
    expect(end && 'call' in end ? end.call.media?.[0] : undefined).toMatchObject({ kind: 'image' });
  });

  it('asks before a capture in auto mode', async () => {
    const id = await codeSession('auto');
    await service.send(id, 'look at it');
    await vi.waitUntil(() => streams.length === 1, { timeout: 3000, interval: 5 });
    streams[0].write(
      frame({ type: 'tool_use', tools: [{ id: 'cap_1', name: 'screen_capture', arguments: '{"target":"My App"}' }] })
    );
    streams[0].write(frame('[DONE]'));
    await vi.waitUntil(
      () => events.some(event => event.type === 'tool-start' && event.call.status === 'awaiting-approval'),
      { timeout: 3000, interval: 5 }
    );
    expect(capture).not.toHaveBeenCalled();
  });
});
