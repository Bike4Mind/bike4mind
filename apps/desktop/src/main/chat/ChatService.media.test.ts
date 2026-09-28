import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import type { AuthenticatedApiClient } from '@bike4mind/client-auth';
import type { ChatStreamEvent } from '@shared/chat';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ChatService } from './ChatService';
import { MediaStore } from './media/MediaStore';
import { ModelCatalog } from './ModelCatalog';
import { SessionStore } from './SessionStore';
import type { AccessStore } from './tools/AccessStore';

function frame(payload: unknown): string {
  return `data: ${typeof payload === 'string' ? payload : JSON.stringify(payload)}\n\n`;
}

describe('ChatService generation tools', () => {
  let service: ChatService;
  let events: ChatStreamEvent[];
  let streams: PassThrough[];
  /** Client-level calls: AuthenticatedApiClient.get/post resolve to the BODY, not the response. */
  let apiGet: ReturnType<typeof vi.fn>;
  let apiPost: ReturnType<typeof vi.fn>;
  /** Axios-instance calls: the completion stream, and the arraybuffer download. */
  let axiosGet: ReturnType<typeof vi.fn>;
  let axiosPost: ReturnType<typeof vi.fn>;

  async function build(options: { media: boolean; roots: string[] }): Promise<void> {
    const store = new SessionStore(await mkdtemp(join(tmpdir(), 'b4m-media-sessions-')), 'test-model');
    events = [];
    streams = [];
    axiosPost = vi.fn().mockImplementation(() => {
      const stream = new PassThrough();
      streams.push(stream);
      return Promise.resolve({ data: stream, status: 200 });
    });
    axiosGet = vi.fn().mockResolvedValue({ data: Buffer.from('png'), headers: { 'content-type': 'image/png' } });
    // The self-host shape: a relative file-proxy base, so a download goes back through the
    // authenticated client rather than out to a CDN.
    apiGet = vi.fn().mockResolvedValue({ cdnUrl: '/api/app-files/serve' });
    apiPost = vi.fn();

    const logger = { debug: vi.fn(), warn: vi.fn() };
    const getApiClient = () =>
      ({
        get: apiGet,
        post: apiPost,
        getAxiosInstance: () => ({ post: axiosPost, get: axiosGet }),
      }) as unknown as AuthenticatedApiClient;

    service = new ChatService({
      store,
      access: { list: async () => options.roots } as unknown as AccessStore,
      logger,
      // The image tool resolves its model through this, so it has to be real here.
      models: new ModelCatalog({ logger, getApiClient, getEnvironmentUrl: () => 'http://localhost:3000' }),
      ...(options.media ? { media: new MediaStore(await mkdtemp(join(tmpdir(), 'b4m-media-files-'))) } : {}),
      getApiClient,
      getEnvironmentUrl: () => 'http://localhost:3000',
      emit: event => events.push(event),
    });
  }

  function declaredTools(): string[] {
    return axiosPost.mock.calls[0][1].options.tools.map(
      (entry: { toolSchema: { name: string } }) => entry.toolSchema.name
    );
  }

  beforeEach(() => {
    vi.clearAllMocks();
  });

  // The generation tools touch no file the user owns, so a folder grant is the wrong gate for
  // them; a signed-in session is the only thing they need.
  it('offers the generation tools with no folder granted, and no others', async () => {
    await build({ media: true, roots: [] });
    const { id } = await service.createSession();
    await service.send(id, 'draw me a bicycle');
    await vi.waitUntil(() => streams.length === 1, { timeout: 3000, interval: 5 });

    expect(declaredTools()).toEqual(['generate_image', 'generate_speech', 'generate_sound_effect', 'generate_music']);
  });

  it('declares no generation tools when the app has nowhere to put the result', async () => {
    await build({ media: false, roots: [] });
    const { id } = await service.createSession();
    await service.send(id, 'hi');
    await vi.waitUntil(() => streams.length === 1, { timeout: 3000, interval: 5 });

    expect(declaredTools()).toEqual([]);
  });

  it('tells the model the output goes to the user and that it costs them', async () => {
    await build({ media: true, roots: [] });
    const { id } = await service.createSession();
    await service.send(id, 'hi');
    await vi.waitUntil(() => streams.length === 1, { timeout: 3000, interval: 5 });

    const preamble = axiosPost.mock.calls[0][1].messages[0].content;
    expect(preamble).toMatch(/SPENDS THE USER CREDITS/);
    expect(preamble).toMatch(/Never describe what a generated image depicts/);
  });

  it('folds the media a tool reported onto the settled call, and persists it', async () => {
    await build({ media: true, roots: [] });
    // A quest that has already finished, so the poll settles on its first read.
    apiGet.mockImplementation((url: string) => {
      if (url.includes('/api/quests/')) {
        return Promise.resolve({
          id: 'q1',
          status: 'done',
          sessionId: 'nb1',
          files: [{ name: 'a.png', url: '/api/app-files/serve/generated/a.png', isImage: true, isAudio: false }],
        });
      }
      if (url.includes('/api/models')) return Promise.resolve({ models: [{ id: 'gpt-image-1-mini', type: 'image' }] });
      return Promise.resolve({ cdnUrl: '/api/app-files/serve' });
    });
    apiPost.mockResolvedValue({ quest: { id: 'q1' }, session: { id: 'nb1' } });

    const { id } = await service.createSession();
    await service.send(id, 'draw me a bicycle');
    await vi.waitUntil(() => streams.length === 1, { timeout: 3000, interval: 5 });

    streams[0].write(
      frame({
        type: 'tool_use',
        tools: [{ id: 'call_1', name: 'generate_image', arguments: JSON.stringify({ prompt: 'a bicycle' }) }],
      })
    );
    streams[0].write(frame('[DONE]'));

    await vi.waitUntil(() => streams.length === 2, { timeout: 10_000, interval: 20 });
    streams[1].write(frame({ type: 'content', text: 'Here it is.' }));
    streams[1].write(frame('[DONE]'));
    await vi.waitUntil(() => events.some(event => event.type === 'done'), { timeout: 5000, interval: 5 });

    const end = events.find(event => event.type === 'tool-end');
    expect(end && 'call' in end ? end.call.error : undefined).toBeUndefined();
    expect(end).toMatchObject({ call: { status: 'done', media: [{ kind: 'image' }] } });
    expect(events.some(event => event.type === 'tool-progress')).toBe(true);

    // Reopening the conversation must still show the image, so it lives on the persisted call.
    const persisted = (await service.getSession(id))?.messages[1];
    expect(persisted?.toolCalls?.[0].media?.[0].url).toMatch(/^b4m-media:\/\//);
    expect((await service.getSession(id))?.remoteSessionId).toBe('nb1');
  }, 20_000);
});
