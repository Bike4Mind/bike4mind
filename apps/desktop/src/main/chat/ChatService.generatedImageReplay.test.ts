import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import type { AuthenticatedApiClient } from '@bike4mind/client-auth';
import type { ChatStreamEvent } from '@shared/chat';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ChatService } from './ChatService';
import { MediaStore } from './media/MediaStore';
import type { ModelCatalog } from './ModelCatalog';
import { SessionStore } from './SessionStore';
import type { AccessStore } from './tools/AccessStore';

function frame(payload: unknown): string {
  return `data: ${typeof payload === 'string' ? payload : JSON.stringify(payload)}\n\n`;
}

type WireMessage = { role: string; content: unknown };

const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.from('lantern')]);
const IMAGE_BLOCK = {
  type: 'image',
  source: { type: 'base64', media_type: 'image/png', data: PNG.toString('base64') },
};

describe('ChatService re-shows images generate_image made in the previous reply', () => {
  let service: ChatService;
  let events: ChatStreamEvent[];
  let post: ReturnType<typeof vi.fn>;
  let streams: PassThrough[];
  let store: SessionStore;
  let media: MediaStore;
  let supportsVision: boolean;

  beforeEach(async () => {
    supportsVision = true;
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
    store = new SessionStore(await mkdtemp(join(tmpdir(), 'b4m-replay-sessions-')), 'test-model');
    media = new MediaStore(await mkdtemp(join(tmpdir(), 'b4m-replay-media-')));
    service = new ChatService({
      store,
      access: { list: async () => [] } as unknown as AccessStore,
      media,
      models: {
        list: async () => ({ models: [{ id: 'test-model', name: 'Test', backend: 'anthropic', supportsVision }] }),
        cached: () => [],
      } as unknown as ModelCatalog,
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

  /** A conversation whose last reply ran generate_image, as a reloaded one stores it. */
  async function afterGeneratedImage(): Promise<string> {
    const { id } = await service.createSession();
    const saved = await media.save(id, PNG, 'image/png');
    const createdAt = new Date().toISOString();
    await store.appendMessage(id, { id: 'u1', role: 'user', content: 'Generate an image of a lantern', createdAt });
    await store.appendMessage(id, {
      id: 'a1',
      role: 'assistant',
      content: 'Here is your lantern.',
      createdAt,
      toolCalls: [
        {
          id: 'call_1',
          name: 'generate_image',
          input: { prompt: 'a lantern' },
          status: 'done',
          preview: 'Generated 1 image(s).',
          media: [
            { kind: 'image', url: saved.url, mimeType: saved.mimeType, byteLength: PNG.length, caption: 'a lantern' },
          ],
        },
      ],
    });
    return id;
  }

  /** Send one prompt, answer it in plain text, and return the messages its request carried. */
  async function turn(sessionId: string, prompt: string): Promise<WireMessage[]> {
    const before = post.mock.calls.length;
    const done = events.filter(event => event.type === 'done').length;
    await service.send(sessionId, prompt);
    await vi.waitUntil(() => streams.length === before + 1, { timeout: 3000, interval: 5 });
    streams[before].write(frame({ type: 'content', text: 'OK.' }));
    streams[before].write(frame('[DONE]'));
    await vi.waitUntil(() => events.filter(event => event.type === 'done').length > done, {
      timeout: 3000,
      interval: 5,
    });
    return post.mock.calls[before][1].messages as WireMessage[];
  }

  it('shows the generated image again with the next user message', async () => {
    const id = await afterGeneratedImage();
    const messages = await turn(id, 'Turn this into a 3D model');

    expect(messages.at(-1)).toMatchObject({
      role: 'user',
      content: [
        {
          type: 'text',
          text: 'Image generate_image made in the previous reply, shown again because the user may be referring to it.',
        },
        IMAGE_BLOCK,
        { type: 'text', text: 'Turn this into a 3D model' },
      ],
    });
  });

  it('does not show it to a model that reads no images', async () => {
    supportsVision = false;
    const id = await afterGeneratedImage();
    const messages = await turn(id, 'Turn this into a 3D model');

    expect(JSON.stringify(messages)).not.toContain('"type":"image"');
  });

  it('does not show it two turns later', async () => {
    const id = await afterGeneratedImage();
    await turn(id, 'Turn this into a 3D model');
    const messages = await turn(id, 'Make it taller');

    expect(JSON.stringify(messages)).not.toContain('"type":"image"');
  });
});
