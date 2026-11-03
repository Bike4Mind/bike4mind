import { mkdtemp, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import type { AuthenticatedApiClient } from '@bike4mind/client-auth';
import type { ChatMessage, ChatSessionSummary, ChatToolCall } from '@shared/chat';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ChatService } from './ChatService';
import { MessageQueue } from './MessageQueue';
import { SessionStore } from './SessionStore';
import type { AccessStore } from './tools/AccessStore';
import { BackgroundProcessRegistry } from './tools/BackgroundProcessRegistry';

// The user's login-shell PATH is slow to resolve and irrelevant to what is under test.
vi.mock('./tools/userPath', async importOriginal => ({
  ...(await importOriginal<typeof import('./tools/userPath')>()),
  resolveUserPath: vi.fn(async () => process.env.PATH ?? ''),
}));

function frame(payload: unknown): string {
  return `data: ${typeof payload === 'string' ? payload : JSON.stringify(payload)}\n\n`;
}

const WAIT = { timeout: 5000, interval: 5 };

/**
 * quest_complete is the parent's explicit "this is the final summary": the finale reads the mark it
 * leaves on the reply, so it must only land when nothing the job started is still going.
 */
describe('ChatService quest_complete', () => {
  let store: SessionStore;
  let service: ChatService;
  let background: BackgroundProcessRegistry;
  let post: ReturnType<typeof vi.fn>;
  let streams: PassThrough[];
  let project: string;
  let storeDirectory: string;

  beforeEach(async () => {
    project = await realpath(await mkdtemp(join(tmpdir(), 'b4m-quest-')));
    storeDirectory = await mkdtemp(join(tmpdir(), 'b4m-quest-sessions-'));
    store = new SessionStore(storeDirectory, 'test-model');
    background = new BackgroundProcessRegistry({ output: () => {}, status: () => {} });
    const opened: PassThrough[] = [];
    streams = opened;
    const boundPost = vi.fn().mockImplementation(() => {
      const stream = new PassThrough();
      opened.push(stream);
      return Promise.resolve({ data: stream, status: 200 });
    });
    post = boundPost;
    service = new ChatService({
      store,
      background,
      queue: new MessageQueue(() => {}),
      access: { list: async () => [] } as unknown as AccessStore,
      logger: { debug: vi.fn(), warn: vi.fn() },
      getApiClient: () =>
        ({
          get: vi.fn().mockResolvedValue({}),
          getAxiosInstance: () => ({ post: boundPost }),
        }) as unknown as AuthenticatedApiClient,
      getEnvironmentUrl: () => 'http://localhost:3000',
      emit: () => {},
    });
  });

  afterEach(async () => {
    service.dispose();
    for (const stream of streams) stream.end();
    for (const session of await store.list()) await background.killSession(session.id);
  });

  async function orchestrator(): Promise<ChatSessionSummary> {
    const created = await service.createCodeSession({ directory: project, branch: '', workspace: false });
    if (!created.ok) throw new Error(created.error);
    await service.setSessionOrchestrate(created.session.id, true);
    await store.setApprovalMode(created.session.id, 'auto');
    return created.session;
  }

  function nthStreamOf(prompt: string, count: number): Promise<PassThrough> {
    return vi.waitUntil(() => {
      const found: number[] = [];
      for (let index = 0; index < streams.length; index++) {
        const messages = post.mock.calls[index]?.[1]?.messages as { content: unknown }[] | undefined;
        if (messages?.[1]?.content === prompt) found.push(index);
      }
      const index = found[count - 1];
      return index === undefined ? undefined : streams[index];
    }, WAIT);
  }

  function reply(stream: PassThrough, text: string): void {
    stream.write(frame({ type: 'content', text }));
    stream.write(frame('[DONE]'));
  }

  function callQuestComplete(stream: PassThrough, id: string, text = ''): void {
    if (text) stream.write(frame({ type: 'content', text }));
    stream.write(
      frame({
        type: 'tool_use',
        tools: [{ id, name: 'quest_complete', arguments: JSON.stringify({ summary: 'All pieces landed.' }) }],
      })
    );
    stream.write(frame('[DONE]'));
  }

  async function lastReply(sessionId: string): Promise<ChatMessage> {
    const messages = (await store.get(sessionId))?.messages ?? [];
    const found = messages.findLast(message => message.role === 'assistant');
    if (!found) throw new Error('No reply');
    return found;
  }

  function call(message: ChatMessage, id: string): ChatToolCall | undefined {
    return message.toolCalls?.find(entry => entry.id === id);
  }

  function idle(sessionId: string): Promise<boolean> {
    return vi.waitUntil(() => !service.isSessionBusy(sessionId), WAIT);
  }

  /** A parent that started one agent, `task a`, and ended its own turn. */
  async function parentWithAgent(): Promise<ChatSessionSummary> {
    const parent = await orchestrator();
    await service.send(parent.id, 'go');
    const first = await nthStreamOf('go', 1);
    first.write(
      frame({
        type: 'tool_use',
        tools: [{ id: 'spawn-a', name: 'session_spawn', arguments: JSON.stringify({ prompt: 'task a', title: 'a' }) }],
      })
    );
    first.write(frame('[DONE]'));
    reply(await nthStreamOf('go', 2), 'Started it; waiting for the install.');
    await idle(parent.id);
    return parent;
  }

  it('marks the reply that calls it once every agent has settled', async () => {
    const parent = await parentWithAgent();
    expect((await lastReply(parent.id)).questComplete).toBeUndefined();

    reply(await nthStreamOf('task a', 1), 'did a');
    callQuestComplete(await nthStreamOf('go', 3), 'quest-1', 'Here is the final summary.');
    reply(await nthStreamOf('go', 4), 'Done.');
    await idle(parent.id);

    const final = await lastReply(parent.id);
    expect(call(final, 'quest-1')).toMatchObject({ status: 'done' });
    expect(final.questComplete).toBe(true);
    expect(final.content).toContain('Here is the final summary.');
  });

  it('keeps the mark on disk when a budget-stopped reply is continued into quest_complete', async () => {
    const parent = await parentWithAgent();
    reply(await nthStreamOf('task a', 1), 'did a');
    reply(await nthStreamOf('go', 3), 'Combining the work.');
    await idle(parent.id);
    const interrupted = await lastReply(parent.id);
    await store.updateMessage(parent.id, interrupted.id, { stopReason: 'tool_turn_limit' });

    expect(await service.continueReply(parent.id)).toMatchObject({ ok: true });
    callQuestComplete(await nthStreamOf('go', 4), 'quest-resumed', 'Here is the final summary.');
    reply(await nthStreamOf('go', 5), 'Done.');
    await idle(parent.id);

    const reread = await new SessionStore(storeDirectory, 'test-model').get(parent.id);
    const final = reread?.messages.find(message => message.id === interrupted.id);
    expect(final && call(final, 'quest-resumed')).toMatchObject({ status: 'done' });
    expect(final?.questComplete).toBe(true);
  });

  it('leaves the reply unmarked when it starts another agent after quest_complete', async () => {
    const parent = await parentWithAgent();
    reply(await nthStreamOf('task a', 1), 'did a');
    callQuestComplete(await nthStreamOf('go', 3), 'quest-1');
    const spawning = await nthStreamOf('go', 4);
    spawning.write(
      frame({
        type: 'tool_use',
        tools: [{ id: 'spawn-b', name: 'session_spawn', arguments: JSON.stringify({ prompt: 'task b', title: 'b' }) }],
      })
    );
    spawning.write(frame('[DONE]'));
    reply(await nthStreamOf('go', 5), 'One more piece first.');
    await idle(parent.id);

    const interim = await lastReply(parent.id);
    expect(call(interim, 'quest-1')).toMatchObject({ status: 'done' });
    expect(call(interim, 'spawn-b')).toMatchObject({ status: 'done' });
    expect(interim.questComplete).toBeUndefined();
  });

  it('leaves the reply unmarked when the user stops it after quest_complete', async () => {
    const parent = await parentWithAgent();
    reply(await nthStreamOf('task a', 1), 'did a');
    callQuestComplete(await nthStreamOf('go', 3), 'quest-1', 'Here is the final');
    await nthStreamOf('go', 4);
    service.stop(parent.id);
    await idle(parent.id);

    const stopped = await lastReply(parent.id);
    expect(stopped.stopReason).toBe('aborted');
    expect(call(stopped, 'quest-1')).toMatchObject({ status: 'done' });
    expect(stopped.questComplete).toBeUndefined();
  });

  it('is refused while an agent is still working, and leaves the reply unmarked', async () => {
    const parent = await parentWithAgent();
    await nthStreamOf('task a', 1);

    await service.send(parent.id, 'are we done?');
    callQuestComplete(await nthStreamOf('go', 3), 'quest-early');
    reply(await nthStreamOf('go', 4), 'Not yet.');
    await idle(parent.id);

    const interim = await lastReply(parent.id);
    expect(call(interim, 'quest-early')).toMatchObject({ status: 'error' });
    expect(call(interim, 'quest-early')?.error).toContain('Still working or waiting on approval: "a"');
    expect(interim.questComplete).toBeUndefined();
  });

  it('is refused while a background process the parent started is still running', async () => {
    const parent = await parentWithAgent();
    reply(await nthStreamOf('task a', 1), 'did a');
    await background.start({
      sessionId: parent.id,
      command: 'sleep 30',
      cwd: project,
      roots: [project],
      protectedPaths: [],
    });

    callQuestComplete(await nthStreamOf('go', 3), 'quest-bg');
    reply(await nthStreamOf('go', 4), 'Waiting on the build.');
    await idle(parent.id);

    const interim = await lastReply(parent.id);
    expect(call(interim, 'quest-bg')?.error).toContain('Background processes still running: sleep 30');
    expect(interim.questComplete).toBeUndefined();
  });

  it('is not offered to a session that does not orchestrate', async () => {
    const created = await service.createCodeSession({ directory: project, branch: '', workspace: false });
    if (!created.ok) throw new Error(created.error);
    await service.send(created.session.id, 'hello');
    await nthStreamOf('hello', 1);
    const names = (post.mock.calls[0][1].options.tools as { toolSchema: { name: string } }[]).map(
      tool => tool.toolSchema.name
    );
    expect(names).not.toContain('quest_complete');
  });
});
