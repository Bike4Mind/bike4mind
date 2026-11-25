import { mkdtemp, realpath, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import type { AuthenticatedApiClient } from '@bike4mind/client-auth';
import type { ChatModelOption, ChatStreamEvent } from '@shared/chat';
import { afterEach, beforeEach, describe, expect, it, type Mock, vi } from 'vitest';
import { ChatService } from './ChatService';
import { MediaStore } from './media/MediaStore';
import { publicVideoModel } from './media/__fixtures__/videoModels';
import { ModelCatalog } from './ModelCatalog';
import type { OllamaLocal } from './OllamaLocal';
import { SessionStore } from './SessionStore';
import type { AccessStore } from './tools/AccessStore';
import { ApprovalGate } from './tools/ApprovalGate';
import { EMPTY_MODEL_STATE, type ModelViewState } from '@shared/model3d';
import { SessionActivity } from './SessionActivity';
import type { ModelViewPort } from './tools/types';

vi.mock('../git/hostGitArgs', async importOriginal =>
  (await import('./plainFolderGit.testHelper')).skipGitOutsideRepositories(await importOriginal())
);

function frame(payload: unknown): string {
  return `data: ${typeof payload === 'string' ? payload : JSON.stringify(payload)}\n\n`;
}

const IMAGE_JOB = {
  id: 'job1',
  object: 'image_generation',
  state: 'succeeded',
  model: 'gpt-image-1-mini',
  mode: 'generate',
  prompt: 'a bicycle',
  group_id: 'grp1',
  source: 'agent',
  error: null,
  output: {
    availability: 'ready',
    url: '/api/app-files/serve/generated/a.png',
    expires_at: null,
    content_type: 'image/png',
    file_id: null,
  },
  credits: { reserved: null, settled: null },
  created_at: 'x',
  updated_at: 'x',
};

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

  async function build(options: {
    media: boolean;
    roots: string[];
    approvals?: ApprovalGate;
    local?: OllamaLocal['stream'];
    signedOut?: boolean;
    supportsTools?: boolean;
  }): Promise<void> {
    const model = options.local ? 'local:ollama:qwen3:8b' : 'test-model';
    const store = new SessionStore(await mkdtemp(join(tmpdir(), 'b4m-media-sessions-')), model);
    // Bound per test: a previous service replying late must not push into this test's events.
    const emitted: ChatStreamEvent[] = [];
    events = emitted;
    const opened: PassThrough[] = [];
    streams = opened;
    const boundPost = vi.fn().mockImplementation(() => {
      const stream = new PassThrough();
      opened.push(stream);
      return Promise.resolve({ data: stream, status: 200 });
    });
    axiosPost = boundPost;
    axiosGet = vi.fn().mockResolvedValue({ data: Buffer.from('png'), headers: { 'content-type': 'image/png' } });
    // The self-host shape: a relative file-proxy base, so a download goes back through the
    // authenticated client rather than out to a CDN.
    apiGet = vi.fn().mockResolvedValue({});
    apiPost = vi.fn();

    const logger = { debug: vi.fn(), warn: vi.fn() };
    const getApiClient = () =>
      options.signedOut
        ? null
        : ({
            get: apiGet,
            post: apiPost,
            getAxiosInstance: () => ({ post: boundPost, get: axiosGet }),
          } as unknown as AuthenticatedApiClient);

    service = new ChatService({
      store,
      access: { list: async () => options.roots } as unknown as AccessStore,
      ...(options.approvals ? { approvals: options.approvals } : {}),
      ...(options.local ? { local: { stream: options.local } as OllamaLocal } : {}),
      logger,
      // The image tool resolves its model through this, so it has to be real here.
      models: new ModelCatalog({ logger, getApiClient, getEnvironmentUrl: () => 'http://localhost:3000' }, {
        models: async () =>
          options.local
            ? [{ id: model, name: 'Local', backend: 'local-ollama', supportsTools: options.supportsTools ?? true }]
            : [],
      } as never),
      ...(options.media ? { media: new MediaStore(await mkdtemp(join(tmpdir(), 'b4m-media-files-'))) } : {}),
      getApiClient,
      getEnvironmentUrl: () => 'http://localhost:3000',
      emit: event => emitted.push(event),
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

  /**
   * Lets the image tool run to its result with the gap before its first poll skipped rather than
   * waited out. Only timers set from here on are fake, so the turn's own I/O still runs for real.
   */
  async function skipPollWaits(until: () => boolean): Promise<void> {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    try {
      const deadline = Date.now() + 5000;
      while (!until()) {
        if (Date.now() > deadline) throw new Error('The image tool never settled.');
        if (vi.getTimerCount() > 0) await vi.advanceTimersToNextTimerAsync();
        else await new Promise(resolve => setImmediate(resolve));
      }
    } finally {
      vi.useRealTimers();
    }
  }

  // The generation tools touch no file the user owns, so a folder grant is the wrong gate for
  // them; a signed-in session is the only thing they need.
  it('offers the generation tools with no folder granted, and no others', async () => {
    await build({ media: true, roots: [] });
    const { id } = await service.createSession();
    await service.send(id, 'draw me a bicycle');
    await vi.waitUntil(() => streams.length === 1, { timeout: 3000, interval: 5 });

    expect(declaredTools()).toEqual([
      'todo_write',
      'generate_image',
      'generate_speech',
      'generate_sound_effect',
      'generate_music',
      'web_search',
      'web_fetch',
      'ask_user',
      'request_directory',
      'loop',
    ]);
  });

  it('declares generate_video only when the server lists a video model this caller can use', async () => {
    await build({ media: true, roots: [] });
    apiGet.mockImplementation(async (path: string) =>
      path === '/api/v1/video-models' ? { models: [publicVideoModel('gemini-omni-1.1-flash')] } : {}
    );
    const { id } = await service.createSession();
    await service.send(id, 'make me a clip');
    await vi.waitUntil(() => streams.length === 1, { timeout: 3000, interval: 5 });

    expect(declaredTools()).toContain('generate_video');
  });

  it('declares no generation tools when the app has nowhere to put the result', async () => {
    await build({ media: false, roots: [] });
    const { id } = await service.createSession();
    await service.send(id, 'hi');
    await vi.waitUntil(() => streams.length === 1, { timeout: 3000, interval: 5 });

    expect(declaredTools()).toEqual(['todo_write', 'web_search', 'web_fetch', 'ask_user', 'request_directory', 'loop']);
  });

  it('tells the model the output goes to the user and that it costs them', async () => {
    await build({ media: true, roots: [] });
    const { id } = await service.createSession();
    await service.send(id, 'hi');
    await vi.waitUntil(() => streams.length === 1, { timeout: 3000, interval: 5 });

    const preamble = axiosPost.mock.calls[0][1].messages[0].content;
    expect(preamble).toMatch(/SPENDS THE USER CREDITS/);
    expect(preamble).toMatch(/attached for you to see\s+when your model reads images/);
    expect(preamble).toMatch(/Never describe\s+an image you were not shown/);
  });

  it.each([false, true])(
    'folds and persists generated media (local: %s)',
    async useLocal => {
      const local = vi.fn<OllamaLocal['stream']>(async (_request, emit) => {
        if (local.mock.calls.length === 1)
          emit({
            type: 'tool_use',
            tools: [{ id: 'call_1', name: 'generate_image', arguments: JSON.stringify({ prompt: 'a bicycle' }) }],
          });
        else emit({ type: 'content', text: 'Here it is.', stopReason: 'end_turn' });
      });
      await build({ media: true, roots: [], ...(useLocal ? { local } : {}) });
      // A job that has already finished, so the poll settles on its first read.
      apiGet.mockImplementation((url: string) => {
        if (url.includes('/api/v1/image-jobs/')) return Promise.resolve(IMAGE_JOB);
        if (url.includes('/api/models'))
          return Promise.resolve({ models: [{ id: 'gpt-image-1-mini', type: 'image' }] });
        return Promise.resolve({});
      });
      apiPost.mockResolvedValue({ group_id: 'grp1', data: [IMAGE_JOB] });

      const { id } = await service.createSession();
      await service.renameSession(id, 'User chosen title');
      const toolEnded = () => events.some(event => event.type === 'tool-end');
      if (useLocal) {
        const sent = service.send(id, 'draw me a bicycle');
        await skipPollWaits(toolEnded);
        await sent;
      } else {
        await service.send(id, 'draw me a bicycle');
        await vi.waitUntil(() => streams.length === 1, { timeout: 3000, interval: 5 });

        streams[0].write(
          frame({
            type: 'tool_use',
            tools: [{ id: 'call_1', name: 'generate_image', arguments: JSON.stringify({ prompt: 'a bicycle' }) }],
          })
        );
        streams[0].write(frame('[DONE]'));
        await skipPollWaits(toolEnded);

        await vi.waitUntil(() => streams.length === 2, { timeout: 10_000, interval: 20 });
        streams[1].write(frame({ type: 'content', text: 'Here it is.' }));
        streams[1].write(frame('[DONE]'));
      }
      await vi.waitUntil(() => events.some(event => event.type === 'done'), { timeout: 5000, interval: 5 });

      const end = events.find(event => event.type === 'tool-end');
      expect(end && 'call' in end ? end.call.error : undefined).toBeUndefined();
      expect(end).toMatchObject({ call: { status: 'done', media: [{ kind: 'image' }] } });
      expect(events.some(event => event.type === 'tool-progress')).toBe(true);

      // Reopening the conversation must still show the image, so it lives on the persisted call.
      const persisted = (await service.getSession(id))?.messages[1];
      expect(persisted?.toolCalls?.[0].media?.[0].url).toMatch(/^b4m-media:\/\//);
      if (useLocal) {
        expect(axiosPost).not.toHaveBeenCalled();
        expect(local).toHaveBeenCalledTimes(2);
      }
    },
    20_000
  );

  it('asks about an image in ask mode like any other tool, answerable away from the app', async () => {
    const approvals = new ApprovalGate();
    await build({ media: true, roots: [], approvals });
    apiGet.mockImplementation((url: string) =>
      Promise.resolve(url.includes('/api/models') ? { models: [{ id: 'gpt-image-1-mini', type: 'image' }] } : {})
    );
    const { id } = await service.createSession();
    await service.setApprovalMode(id, 'ask');
    await service.send(id, 'draw me a bicycle');
    await vi.waitUntil(() => streams.length === 1, { timeout: 3000, interval: 5 });
    streams[0].write(
      frame({
        type: 'tool_use',
        tools: [{ id: 'call_1', name: 'generate_image', arguments: JSON.stringify({ prompt: 'a bicycle' }) }],
      })
    );
    streams[0].write(frame('[DONE]'));

    const card = await vi.waitUntil(
      () => events.find(event => event.type === 'tool-start' && event.call.status === 'awaiting-approval'),
      { timeout: 3000, interval: 5 }
    );
    const call = card.type === 'tool-start' ? card.call : undefined;
    expect(call?.name).toBe('generate_image');
    expect(call?.approvalInAppOnly).toBeUndefined();
    if (call?.approvalId) approvals.resolve(call.approvalId, { decision: 'deny' });
  });

  it('looks up the server config without options on a hosted turn', async () => {
    await build({ media: true, roots: [] });
    const { id } = await service.createSession();
    apiGet.mockClear();
    await service.send(id, 'hi');
    await vi.waitUntil(() => streams.length === 1, { timeout: 3000, interval: 5 });
    expect(apiGet.mock.calls.filter(([path]) => path === '/api/settings/serverConfig')).toEqual([
      ['/api/settings/serverConfig'],
    ]);
  });

  it('offers hosted media and web tools to local inference without a folder grant', async () => {
    const local = vi.fn<OllamaLocal['stream']>(async (_request, emit) => {
      emit({ type: 'content', text: 'Ready', stopReason: 'end_turn' });
    });
    await build({ media: true, roots: [], local });
    apiGet.mockImplementation(async (path: string) =>
      path === '/api/v1/video-models' ? { models: [publicVideoModel('gemini-omni-1.1-flash')] } : {}
    );
    const { id } = await service.createSession();
    apiGet.mockClear();
    await service.send(id, 'hi');
    await vi.waitUntil(() => events.some(event => event.type === 'done'), { interval: 5 });
    const request = local.mock.calls.find(([request]) => request.tools?.length)?.[0];
    expect(request?.tools?.map(entry => (entry.toolSchema as { name: string }).name)).toEqual([
      'todo_write',
      'generate_image',
      'generate_speech',
      'generate_sound_effect',
      'generate_music',
      'web_search',
      'web_fetch',
      'generate_video',
      'ask_user',
      'request_directory',
      'loop',
    ]);
    expect(apiGet.mock.calls).toEqual([['/api/v1/video-models', { timeout: 5_000 }]]);
    expect(apiPost).not.toHaveBeenCalled();
    expect(axiosPost).not.toHaveBeenCalled();
  });

  it.each([
    { signedOut: true, supportsTools: true },
    { signedOut: false, supportsTools: false },
  ])('withholds hosted tools for local turns with %j', async options => {
    const local = vi.fn<OllamaLocal['stream']>(async (_request, emit) => {
      emit({ type: 'content', text: 'Ready', stopReason: 'end_turn' });
    });
    await build({ media: true, roots: [], local, ...options });
    const { id } = await service.createSession();
    await service.send(id, 'hi');
    await vi.waitUntil(() => events.some(event => event.type === 'done'), { interval: 5 });
    expect(local).toHaveBeenCalled();
    const names = local.mock.calls.flatMap(
      ([request]) => request.tools?.map(entry => (entry.toolSchema as { name: string }).name) ?? []
    );
    for (const name of ['generate_image', 'web_search', 'web_fetch']) expect(names).not.toContain(name);
    expect(axiosPost).not.toHaveBeenCalled();
    expect(apiPost).not.toHaveBeenCalled();
  });

  it.each([
    { name: 'web_search', input: { query: 'bicycle' }, path: '/api/tools/web-search' },
    { name: 'web_fetch', input: { url: 'https://example.com/' }, path: '/api/tools/web-fetch' },
  ])('returns hosted $name results to the selected local model', async ({ name, input, path }) => {
    const local = vi.fn<OllamaLocal['stream']>(async (_request, emit) => {
      if (local.mock.calls.length === 1)
        emit({
          type: 'tool_use',
          tools: [{ id: 'call-local', name, arguments: JSON.stringify(input) }],
        });
      else emit({ type: 'content', text: 'Read locally', stopReason: 'end_turn' });
    });
    await build({ media: false, roots: [], local });
    apiPost.mockResolvedValue({ result: 'Public bicycle information' });
    const { id } = await service.createSession();
    await service.renameSession(id, 'User chosen title');
    apiGet.mockClear();
    await service.send(id, 'private conversation text');
    await vi.waitUntil(() => events.some(event => event.type === 'done'), { interval: 5 });
    expect(apiPost).toHaveBeenCalledWith(path, input, expect.objectContaining({ signal: expect.any(AbortSignal) }));
    expect(JSON.stringify(apiPost.mock.calls)).not.toContain('private conversation text');
    expect(local).toHaveBeenCalledTimes(2);
    expect(JSON.stringify(local.mock.calls[1][0].messages)).toContain('Public bicycle information');
    expect(local.mock.calls.every(([request]) => request.model === 'local:ollama:qwen3:8b')).toBe(true);
    expect(apiGet).not.toHaveBeenCalled();
    expect(axiosPost).not.toHaveBeenCalled();
  });

  it.each([
    'generate_image',
    'generate_speech',
    'generate_sound_effect',
    'generate_music',
    'generate_video',
    'web_fetch',
  ])('keeps local %s behind the existing approval gate', async name => {
    const approvals = new ApprovalGate();
    const local = vi.fn<OllamaLocal['stream']>(async (_request, emit) => {
      if (local.mock.calls.length === 1)
        emit({
          type: 'tool_use',
          tools: [
            {
              id: 'call-local',
              name,
              arguments: JSON.stringify({
                prompt: 'bicycle',
                text: 'bicycle',
                url: 'https://example.com/',
              }),
            },
          ],
        });
      else emit({ type: 'content', text: 'Declined', stopReason: 'end_turn' });
    });
    await build({ media: true, roots: [], local, approvals });
    apiGet.mockImplementation(async (path: string) =>
      path === '/api/v1/video-models'
        ? { models: [publicVideoModel('gemini-omni-1.1-flash')] }
        : path === '/api/models'
          ? { models: [{ id: 'gpt-image-1-mini', type: 'image' }] }
          : path === '/api/v1/music-models'
            ? {
                models: [
                  {
                    id: 'music',
                    object: 'music_model',
                    provider: 'test',
                    display_name: 'Music',
                    preview: false,
                    vocals: 'optional',
                    lyrics: null,
                    output_formats: ['mp3'],
                    typical_render_seconds: 30,
                    deprecation_date: null,
                    duration: { control: 'approximate', min: 10, max: 180, default: 60 },
                    pricing: { unit: 'per_song', credits: 1200 },
                  },
                ],
              }
            : {}
    );
    const { id } = await service.createSession();
    await service.renameSession(id, 'User chosen title');
    await service.setApprovalMode(id, 'ask');
    await service.send(id, 'use the hosted tool');
    const card = await vi.waitUntil(
      () => events.find(event => event.type === 'tool-start' && event.call.status === 'awaiting-approval'),
      { interval: 5 }
    );
    expect(apiPost).not.toHaveBeenCalled();
    if (card.type !== 'tool-start' || !card.call.approvalId) throw new Error('Missing approval');
    approvals.resolve(card.call.approvalId, { decision: 'deny' });
    await vi.waitUntil(() => events.some(event => event.type === 'done'), { interval: 5 });
    expect(apiPost).not.toHaveBeenCalled();
    expect(axiosPost).not.toHaveBeenCalled();
  });
});

describe('modelPane', () => {
  function frame(payload: unknown): string {
    return `data: ${typeof payload === 'string' ? payload : JSON.stringify(payload)}\n\n`;
  }

  type FakeView = ModelViewPort & { opened: string[] };

  function fakeView(): FakeView {
    let state: ModelViewState = EMPTY_MODEL_STATE;
    const opened: string[] = [];
    return {
      opened,
      current: () => state,
      open: async path => {
        opened.push(path);
        state = { path, kind: 'model', generation: 1, source: '', missing: false };
        return state;
      },
      waitForBuild: async () => ({
        generation: 1,
        ok: true,
        summary: { parts: ['body'], size: [10, 10, 10], units: 'mm', triangles: 12, params: {} },
      }),
      capture: async () => new Uint8Array([137, 80, 78, 71]),
      versions: async () => [],
      recordTurntable: async () => new Uint8Array([26, 69, 223, 163]),
      glbPath: () => null,
    };
  }

  describe('ChatService model pane', () => {
    let service: ChatService;
    let events: ChatStreamEvent[];
    let post: ReturnType<typeof vi.fn>;
    let streams: PassThrough[];
    let root: string;
    let views: Map<string, FakeView>;
    let forgetModel: Mock<(sessionId: string) => void>;
    let forModel: Mock<(sessionId: string) => ModelViewPort>;

    beforeEach(async () => {
      root = await realpath(await mkdtemp(join(tmpdir(), 'b4m-modelpane-')));
      views = new Map();
      forgetModel = vi.fn();
      forModel = vi.fn((sessionId: string) => {
        const existing = views.get(sessionId);
        if (existing) return existing;
        const created = fakeView();
        views.set(sessionId, created);
        return created;
      });
      const emitted: ChatStreamEvent[] = [];
      events = emitted;
      const opened: PassThrough[] = [];
      streams = opened;
      const boundPost = vi.fn().mockImplementation(() => {
        const stream = new PassThrough();
        opened.push(stream);
        return Promise.resolve({ data: stream, status: 200 });
      });
      post = boundPost;
      const models: ChatModelOption[] = [{ id: 'test-model', name: 'Test', backend: 'openai' }];
      service = new ChatService({
        store: new SessionStore(await mkdtemp(join(tmpdir(), 'b4m-modelpane-sessions-')), 'test-model'),
        approvals: new ApprovalGate(),
        activity: new SessionActivity(() => undefined),
        access: { list: async () => [root] } as unknown as AccessStore,
        media: new MediaStore(await mkdtemp(join(tmpdir(), 'b4m-modelpane-media-'))),
        models: { list: async () => ({ models }), cached: () => [] } as unknown as ModelCatalog,
        model: { for: forModel, forget: forgetModel },
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

    async function codeSession(): Promise<string> {
      const created = await service.createCodeSession({ directory: root, branch: '', workspace: false });
      if (!created.ok) throw new Error(created.error);
      return created.session.id;
    }

    it('forgets the model view when deleting a session', async () => {
      const sessionId = await codeSession();
      await service.deleteSession(sessionId);
      expect(forgetModel).toHaveBeenCalledExactlyOnceWith(sessionId);
    });

    it('runs a turn model tools against the calling conversation view only', async () => {
      const sessionA = await codeSession();
      const sessionB = await codeSession();
      const modelPath = join(root, 'chest.model.js');
      await writeFile(modelPath, 'export default {};\n');

      await service.send(sessionA, 'show the chest');
      await vi.waitUntil(() => streams.length === 1, { timeout: 3000, interval: 5 });
      streams[0].write(
        frame({
          type: 'tool_use',
          tools: [{ id: 'view_1', name: 'model_view', arguments: JSON.stringify({ path: modelPath }) }],
        })
      );
      streams[0].write(frame('[DONE]'));
      await vi.waitUntil(() => post.mock.calls.length === 2, { timeout: 3000, interval: 5 });
      streams[1].write(frame({ type: 'content', text: 'Done.' }));
      streams[1].write(frame('[DONE]'));
      await vi.waitUntil(() => events.find(event => event.type === 'done'), { timeout: 3000, interval: 5 });

      const forCalls = forModel.mock.calls.map(call => call[0]);
      expect(forCalls.length).toBeGreaterThan(0);
      expect(forCalls).toContain(sessionA);
      expect(forCalls).not.toContain(sessionB);
      expect(views.get(sessionA)?.opened).toEqual([modelPath]);
      expect(views.get(sessionB)?.opened ?? []).toEqual([]);

      const end = events.find(event => event.type === 'tool-end');
      expect(end && 'call' in end ? end.call.status : undefined).toBe('done');
    });
  });
});

describe('generatedImageReplay', () => {
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
});
