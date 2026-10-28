import { mkdtemp, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import type { AuthenticatedApiClient } from '@bike4mind/client-auth';
import type { ChatStreamEvent } from '@shared/chat';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ChatService } from './ChatService';
import { SessionStore } from './SessionStore';
import type { AccessStore } from './tools/AccessStore';

function frame(payload: unknown): string {
  return `data: ${typeof payload === 'string' ? payload : JSON.stringify(payload)}\n\n`;
}

describe('ChatService set_session_pull_request', () => {
  let service: ChatService;
  let events: ChatStreamEvent[];
  let streams: PassThrough[];
  let post: ReturnType<typeof vi.fn>;
  let project: string;
  const bindForAgent = vi.fn();
  const dismiss = vi.fn();

  beforeEach(async () => {
    project = await realpath(await mkdtemp(join(tmpdir(), 'b4m-pr-tool-')));
    const store = new SessionStore(await mkdtemp(join(tmpdir(), 'b4m-pr-tool-sessions-')), 'test-model');
    const emitted: ChatStreamEvent[] = [];
    events = emitted;
    const opened: PassThrough[] = [];
    streams = opened;
    bindForAgent.mockReset().mockImplementation(async () => ({
      ok: true,
      pr: {
        owner: 'example-org',
        repo: 'widgets',
        number: 700,
        url: 'https://github.com/example-org/widgets/pull/700',
      },
    }));
    dismiss.mockReset().mockResolvedValue({ ok: true });
    const boundPost = vi.fn().mockImplementation(() => {
      const stream = new PassThrough();
      opened.push(stream);
      return Promise.resolve({ data: stream, status: 200 });
    });
    post = boundPost;
    service = new ChatService({
      store,
      access: { list: async () => [] } as unknown as AccessStore,
      logger: { debug: vi.fn(), warn: vi.fn() },
      pullRequests: { bindForAgent, dismiss },
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

  const declared = (request: number): string[] =>
    (post.mock.calls[request][1].options.tools as { toolSchema: { name: string } }[]).map(
      entry => entry.toolSchema.name
    );

  it('is declared to a Code session and not to a Chat session', async () => {
    const chat = await service.createSession();
    await service.send(chat.id, 'hello');
    await vi.waitUntil(() => streams.length === 1, { timeout: 5000, interval: 5 });
    expect(declared(0)).not.toContain('set_session_pull_request');

    const created = await service.createCodeSession({ directory: project, branch: '', workspace: false });
    if (!created.ok) throw new Error(created.error);
    await service.send(created.session.id, 'hello');
    await vi.waitUntil(() => streams.length === 2, { timeout: 5000, interval: 5 });
    expect(declared(1)).toContain('set_session_pull_request');
  });

  it('binds for the calling session only, without asking', async () => {
    const created = await service.createCodeSession({ directory: project, branch: '', workspace: false });
    if (!created.ok) throw new Error(created.error);
    const { id } = created.session;
    await service.send(id, 'the PR for this session is #700');
    await vi.waitUntil(() => streams.length === 1, { timeout: 5000, interval: 5 });
    streams[0].write(
      frame({
        type: 'tool_use',
        tools: [{ id: 't1', name: 'set_session_pull_request', arguments: JSON.stringify({ pull_request: '#700' }) }],
      })
    );
    streams[0].write(frame('[DONE]'));

    const end = await vi.waitUntil(
      () => events.find(event => event.type === 'tool-end' && event.call.name === 'set_session_pull_request'),
      { timeout: 5000, interval: 5 }
    );
    expect(bindForAgent).toHaveBeenCalledWith(id, '#700');
    expect(end).toMatchObject({
      call: { status: 'done', label: "Set the session's PR to example-org/widgets#700" },
    });
    expect(events.some(event => event.type === 'tool-start' && event.call.approvalId)).toBe(false);
  });
});
