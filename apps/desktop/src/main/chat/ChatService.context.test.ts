import { mkdtemp, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import type { AuthenticatedApiClient } from '@bike4mind/client-auth';
import type { ChatStreamEvent } from '@shared/chat';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ChatService } from './ChatService';
import { SessionStore } from './SessionStore';
import type { AccessStore } from './tools/AccessStore';

/**
 * What `/clear` and `/compact` do to a conversation, end to end through the service.
 *
 * The round trip is stubbed at the axios instance, the same way the pruning tests stub it: these
 * assertions are about which messages reach the wire and what survives a failure, and a real
 * completion would answer neither question.
 */

function frame(payload: unknown): string {
  return `data: ${typeof payload === 'string' ? payload : JSON.stringify(payload)}\n\n`;
}

interface WireMessage {
  role: string;
  content: string | unknown[];
}

describe('ChatService context boundaries', () => {
  let service: ChatService;
  let events: ChatStreamEvent[];
  let streams: PassThrough[];
  let sent: string[];
  let store: SessionStore;
  let failNextRequest: boolean;

  beforeEach(async () => {
    const root = await realpath(await mkdtemp(join(tmpdir(), 'b4m-boundary-')));
    store = new SessionStore(await mkdtemp(join(tmpdir(), 'b4m-boundary-sessions-')), 'test-model');
    events = [];
    streams = [];
    sent = [];
    failNextRequest = false;

    const post = vi.fn().mockImplementation((_url: string, body: { messages: unknown[] }) => {
      if (failNextRequest) {
        failNextRequest = false;
        return Promise.reject(new Error('the network went away'));
      }
      sent.push(JSON.stringify(body.messages));
      const stream = new PassThrough();
      streams.push(stream);
      return Promise.resolve({ data: stream, status: 200 });
    });

    service = new ChatService({
      store,
      access: { list: async () => [root] } as unknown as AccessStore,
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

  /** Answer the request at `index` with one text event, then end the stream. */
  async function answer(index: number, text: string): Promise<void> {
    await vi.waitUntil(() => streams.length === index + 1, { timeout: 3000, interval: 5 });
    streams[index].write(frame({ type: 'content', text }));
    streams[index].write(frame('[DONE]'));
  }

  async function settled(count: number): Promise<void> {
    await vi.waitUntil(() => events.filter(event => event.type === 'done').length === count, {
      timeout: 3000,
      interval: 5,
    });
  }

  function wire(index: number): WireMessage[] {
    return JSON.parse(sent[index]) as WireMessage[];
  }

  /** A conversation with one finished exchange in it. */
  async function started(): Promise<string> {
    const { id } = await service.createSession();
    await service.send(id, 'tell me about widgets');
    await answer(0, 'Widgets are small.');
    await settled(1);
    return id;
  }

  it('stops sending what came before a clear, and keeps sending what comes after', async () => {
    const id = await started();
    expect(await service.clearContext(id)).toMatchObject({ ok: true });

    await service.send(id, 'and now something else');
    await answer(1, 'Of course.');
    await settled(2);

    const text = JSON.stringify(wire(1));
    expect(text).not.toContain('widgets');
    expect(text).not.toContain('Widgets are small.');
    expect(text).toContain('and now something else');
  });

  it('keeps the conversation itself: its project, branch, approval mode and notebook binding', async () => {
    const id = await started();
    await store.setProject(id, {
      directory: '/tmp/project',
      name: 'project',
      branch: 'feat/x',
      workspace: false,
      workingDirectory: '/tmp/project',
      contextDirectories: [],
    });
    await store.setApprovalMode(id, 'auto');
    await store.setRemoteSessionId(id, 'notebook-42');

    const before = await store.get(id);
    const result = await service.clearContext(id);
    expect(result.ok).toBe(true);
    const after = await store.get(id);

    expect(after?.id).toBe(before?.id);
    expect(after?.project).toEqual(before?.project);
    expect(after?.approvalMode).toBe('auto');
    // The notebook binding most of all: dropping it would strand every image this conversation
    // has generated. See ChatSession.remoteSessionId.
    expect(after?.remoteSessionId).toBe('notebook-42');
  });

  it('deletes nothing - the cleared messages are still in the session file', async () => {
    const id = await started();
    const before = await store.get(id);
    await service.clearContext(id);
    const after = await store.get(id);

    expect(after?.messages.slice(0, before?.messages.length)).toEqual(before?.messages);
    expect(after?.messages.at(-1)?.boundary).toEqual({ kind: 'clear' });
  });

  it('refuses a clear that would separate nothing', async () => {
    const id = await started();
    await service.clearContext(id);
    expect(await service.clearContext(id)).toEqual({ ok: false, error: expect.stringContaining('nothing') });
  });

  it('carries a compaction summary across the boundary and sends it as the lead message', async () => {
    const id = await started();

    const compacting = service.compactContext(id, 'focus on the widget work');
    await answer(1, 'The user asked about widgets. Nothing is open.');
    expect(await compacting).toMatchObject({ ok: true });

    // The focus rode along with the transcript, on the summary request.
    expect(wire(1).at(-1)?.content).toContain('focus on the widget work');

    await service.send(id, 'carry on');
    await answer(2, 'Right.');
    await settled(2);

    const next = wire(2);
    expect(JSON.stringify(next)).not.toContain('Widgets are small.');
    const summary = next.find(message => String(message.content).includes('The user asked about widgets'));
    expect(summary).toBeDefined();
    // Framed, so the model reads it as its own record rather than as the user typing notes.
    expect(String(summary?.content)).toContain('compacted');
  });

  it('refuses to compact while a turn is streaming, and changes nothing', async () => {
    const id = await started();
    void service.send(id, 'a long one');
    await vi.waitUntil(() => streams.length === 2, { timeout: 3000, interval: 5 });

    const before = await store.get(id);
    const result = await service.compactContext(id, '');
    expect(result).toEqual({ ok: false, error: expect.stringContaining('still replying') });
    expect((await store.get(id))?.messages).toEqual(before?.messages);

    await answer(1, 'Done.');
    await settled(2);
  });

  /**
   * The one outcome this feature must never have. A boundary applied around a summary that never
   * arrived drops the history and puts nothing in its place, and nothing in the app or in the
   * file on disk can get it back.
   */
  it('leaves the message list byte-identical when the summary fails', async () => {
    const id = await started();
    const before = JSON.stringify((await store.get(id))?.messages);

    failNextRequest = true;
    const result = await service.compactContext(id, '');
    expect(result.ok).toBe(false);
    expect(JSON.stringify((await store.get(id))?.messages)).toBe(before);
  });

  it('leaves the message list byte-identical when the summary comes back empty', async () => {
    const id = await started();
    const before = JSON.stringify((await store.get(id))?.messages);

    const compacting = service.compactContext(id, '');
    await answer(1, '   ');
    expect(await compacting).toEqual({ ok: false, error: expect.stringContaining('empty') });
    expect(JSON.stringify((await store.get(id))?.messages)).toBe(before);
  });
});
