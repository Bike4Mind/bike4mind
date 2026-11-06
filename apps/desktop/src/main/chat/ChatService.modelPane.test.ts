import { mkdtemp, realpath, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import type { AuthenticatedApiClient } from '@bike4mind/client-auth';
import type { ChatModelOption, ChatStreamEvent } from '@shared/chat';
import { EMPTY_MODEL_STATE, type ModelViewState } from '@shared/model3d';
import { afterEach, beforeEach, describe, expect, it, type Mock, vi } from 'vitest';
import { ChatService } from './ChatService';
import { MediaStore } from './media/MediaStore';
import type { ModelCatalog } from './ModelCatalog';
import { SessionActivity } from './SessionActivity';
import { SessionStore } from './SessionStore';
import type { AccessStore } from './tools/AccessStore';
import { ApprovalGate } from './tools/ApprovalGate';
import type { ModelViewPort } from './tools/types';

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
  let forModel: Mock<(sessionId: string) => ModelViewPort>;

  beforeEach(async () => {
    root = await realpath(await mkdtemp(join(tmpdir(), 'b4m-modelpane-')));
    views = new Map();
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
      model: { for: forModel },
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
