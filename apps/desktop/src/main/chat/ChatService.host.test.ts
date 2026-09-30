import { mkdtemp, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import type { AuthenticatedApiClient } from '@bike4mind/client-auth';
import type { ChatSessionSummary, ChatStreamEvent } from '@shared/chat';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ChatService } from './ChatService';
import { SessionStore } from './SessionStore';
import type { AccessStore } from './tools/AccessStore';
import { ApprovalGate } from './tools/ApprovalGate';

function frame(payload: unknown): string {
  return `data: ${typeof payload === 'string' ? payload : JSON.stringify(payload)}\n\n`;
}

/**
 * The app-control tools: what they can reach, what they must ask for, and what a finished
 * spawned session does to the conversation that started it.
 */
describe('ChatService app-control tools', () => {
  let store: SessionStore;
  let service: ChatService;
  let approvals: ApprovalGate;
  let events: ChatStreamEvent[];
  let post: ReturnType<typeof vi.fn>;
  let streams: PassThrough[];
  let projectA: string;
  let projectB: string;
  /** Every approval the gate raised, so a test can count the asks rather than infer them. */
  let asked: { approvalId: string; toolName: string }[];

  beforeEach(async () => {
    projectA = await realpath(await mkdtemp(join(tmpdir(), 'b4m-host-a-')));
    projectB = await realpath(await mkdtemp(join(tmpdir(), 'b4m-host-b-')));
    store = new SessionStore(await mkdtemp(join(tmpdir(), 'b4m-host-sessions-')), 'test-model');
    events = [];
    streams = [];
    asked = [];
    post = vi.fn().mockImplementation(() => {
      const stream = new PassThrough();
      streams.push(stream);
      return Promise.resolve({ data: stream, status: 200 });
    });
    approvals = new ApprovalGate({ requested: vi.fn(), settled: vi.fn(), changed: vi.fn() });

    service = new ChatService({
      store,
      access: { list: async () => [] } as unknown as AccessStore,
      approvals,
      logger: { debug: vi.fn(), warn: vi.fn() },
      getApiClient: () =>
        ({
          get: vi.fn().mockResolvedValue({}),
          getAxiosInstance: () => ({ post }),
        }) as unknown as AuthenticatedApiClient,
      getEnvironmentUrl: () => 'http://localhost:3000',
      emit: event => {
        events.push(event);
        // Stand in for the user, answering every ask the moment it is raised. 'always' is
        // chosen so that anything which CAN become a standing approval does.
        if (event.type === 'tool-start' && event.call.approvalId) {
          asked.push({ approvalId: event.call.approvalId, toolName: event.call.name });
          approvals.resolve(event.call.approvalId, 'always');
        }
      },
    });
  });

  afterEach(() => {
    service.dispose();
    for (const stream of streams) stream.end();
  });

  async function codeSession(directory: string): Promise<ChatSessionSummary> {
    const created = await service.createCodeSession({ directory, branch: '', workspace: false });
    if (!created.ok) throw new Error(created.error);
    return created.session;
  }

  function callTool(stream: PassThrough, id: string, name: string, args: Record<string, unknown>): void {
    stream.write(frame({ type: 'tool_use', tools: [{ id, name, arguments: JSON.stringify(args) }] }));
    stream.write(frame('[DONE]'));
  }

  function settled(name: string) {
    return events
      .filter(event => event.type === 'tool-end')
      .map(event => (event.type === 'tool-end' ? event.call : null))
      .filter(call => call?.name === name);
  }

  function streamOf(prompt: string): PassThrough {
    for (let index = streams.length - 1; index >= 0; index--) {
      const messages = post.mock.calls[index]?.[1]?.messages as { role: string; content: unknown }[] | undefined;
      if (messages?.[1]?.content === prompt) return streams[index];
    }
    throw new Error(`no stream for ${prompt}`);
  }

  function awaitStreamOf(prompt: string): Promise<PassThrough> {
    return vi.waitUntil(
      () => {
        try {
          return streamOf(prompt);
        } catch {
          return undefined;
        }
      },
      { timeout: 5000, interval: 5 }
    );
  }

  it('offers the family to a Code session and withholds it from a Chat session', async () => {
    const chat = await service.createSession();
    await service.send(chat.id, 'hello');
    await vi.waitUntil(() => streams.length === 1, { timeout: 5000, interval: 5 });
    const chatTools = (post.mock.calls[0][1].options.tools as { toolSchema: { name: string } }[]).map(
      entry => entry.toolSchema.name
    );
    expect(chatTools.filter(name => name.startsWith('session_'))).toEqual([]);

    const code = await codeSession(projectA);
    await service.send(code.id, 'hello');
    await vi.waitUntil(() => streams.length === 2, { timeout: 5000, interval: 5 });
    const codeTools = (post.mock.calls[1][1].options.tools as { toolSchema: { name: string } }[]).map(
      entry => entry.toolSchema.name
    );
    expect(codeTools.filter(name => name.startsWith('session_'))).toEqual([
      'session_list',
      'session_read',
      'session_spawn',
      'session_send',
      'session_archive',
      'session_delete',
    ]);
  });

  it('sees only the conversations in its own project', async () => {
    const mine = await codeSession(projectA);
    const theirs = await codeSession(projectB);

    await service.send(mine.id, 'what is here?');
    const stream = await awaitStreamOf('what is here?');
    callTool(stream, 'c1', 'session_list', {});

    await vi.waitUntil(() => settled('session_list').length === 1, { timeout: 5000, interval: 5 });
    const listing = settled('session_list')[0]?.preview ?? '';
    expect(listing).toContain(mine.id);
    expect(listing).not.toContain(theirs.id);
  });

  it('refuses to delete a conversation belonging to another project', async () => {
    const mine = await codeSession(projectA);
    const theirs = await codeSession(projectB);

    await service.send(mine.id, 'clean up');
    callTool(await awaitStreamOf('clean up'), 'c1', 'session_delete', { session_id: theirs.id });

    await vi.waitUntil(() => settled('session_delete').length === 1, { timeout: 5000, interval: 5 });
    expect(settled('session_delete')[0]?.preview).toMatch(/No conversation with that id in this project/);
    // Still there: a refusal must not be a delete that merely reported badly.
    expect(await store.get(theirs.id)).not.toBeNull();
  });

  it('asks again for every delete, however the last one was answered', async () => {
    const mine = await codeSession(projectA);
    const first = await codeSession(projectA);
    const second = await codeSession(projectA);

    await service.send(mine.id, 'tidy');
    callTool(await awaitStreamOf('tidy'), 'c1', 'session_delete', { session_id: first.id });
    await vi.waitUntil(() => settled('session_delete').length === 1, { timeout: 5000, interval: 5 });

    callTool(await awaitStreamOf('tidy'), 'c2', 'session_delete', { session_id: second.id });
    await vi.waitUntil(() => settled('session_delete').length === 2, { timeout: 5000, interval: 5 });

    // Both were deleted, and - the point of this test - both were asked about. An 'always'
    // answer to the first must not have covered the second.
    expect(asked.filter(entry => entry.toolName === 'session_delete')).toHaveLength(2);
    expect(await store.get(first.id)).toBeNull();
    expect(await store.get(second.id)).toBeNull();

    const prompts = events
      .filter(event => event.type === 'tool-start')
      .map(event => (event.type === 'tool-start' ? event.call : null))
      .filter(call => call?.name === 'session_delete' && call.approvalId);
    expect(prompts.every(call => call?.approvalIrreversible === true)).toBe(true);
  });

  it('tells a parent that a spawned session finished, without its output, once the parent is idle', async () => {
    const parent = await codeSession(projectA);
    await service.send(parent.id, 'delegate it');
    callTool(await awaitStreamOf('delegate it'), 'c1', 'session_spawn', { prompt: 'go and do it' });
    await vi.waitUntil(() => settled('session_spawn').length === 1, { timeout: 5000, interval: 5 });

    // The parent finishes first, so the report has an idle conversation to land in.
    const parentFollowUp = await awaitStreamOf('delegate it');
    parentFollowUp.write(frame({ type: 'content', text: 'I have handed that off.' }));
    parentFollowUp.write(frame('[DONE]'));
    await vi.waitUntil(() => events.some(event => event.type === 'done' && event.sessionId === parent.id), {
      timeout: 5000,
      interval: 5,
    });

    const child = await awaitStreamOf('go and do it');
    child.write(frame({ type: 'content', text: 'Finished: the file is updated.' }));
    child.write(frame('[DONE]'));

    const report = await vi.waitUntil(() => events.find(event => event.type === 'message'), {
      timeout: 5000,
      interval: 5,
    });
    expect(report).toMatchObject({ sessionId: parent.id });

    const childId = (await store.list()).find(session => session.origin)?.id;
    expect(childId).toBeTruthy();

    const stored = (await store.get(parent.id))?.messages ?? [];
    const notice = stored.find(message => message.system);
    expect(notice?.content).toContain('has finished');
    // Only THAT it finished. Carrying its reply across would put text nobody read into the
    // parent request as though the user had typed it; session_read is the way to that.
    expect(notice?.content).not.toContain('Finished: the file is updated.');
    expect(notice?.content).toContain('session_read');
    expect(notice?.content).toContain(childId);
    // The user's half of the same report: same event, none of the handles the model needs.
    expect(notice?.display).toBeTruthy();
    expect(notice?.display).not.toContain(childId);
    expect(notice?.display).not.toContain('session_read');
    // It must not be mistaken for the user's own words, in the thread or on the wire.
    expect(notice?.role).toBe('user');
    expect(notice?.system).toBe(true);
  });

  it('lets a spawned session finish after its parent is deleted, dropping only the report', async () => {
    const parent = await codeSession(projectA);
    await service.send(parent.id, 'delegate it');
    callTool(await awaitStreamOf('delegate it'), 'c1', 'session_spawn', { prompt: 'go and do it' });
    await vi.waitUntil(() => settled('session_spawn').length === 1, { timeout: 5000, interval: 5 });

    const childId = (await store.list()).find(session => session.origin)?.id;
    expect(childId).toBeDefined();

    await service.deleteSession(parent.id);

    const child = await awaitStreamOf('go and do it');
    child.write(frame({ type: 'content', text: 'Finished anyway.' }));
    child.write(frame('[DONE]'));

    await vi.waitUntil(() => events.some(event => event.type === 'done' && event.sessionId === childId), {
      timeout: 5000,
      interval: 5,
    });

    // The child keeps its own row and its own transcript; it is a conversation in its own right.
    const orphan = await store.get(childId as string);
    expect(orphan?.messages.at(-1)?.content).toBe('Finished anyway.');
    expect(events.filter(event => event.type === 'message')).toHaveLength(0);
  });

  it('archives and restores a conversation without touching what is in it', async () => {
    const mine = await codeSession(projectA);
    const other = await codeSession(projectA);

    await service.send(mine.id, 'tidy up');
    callTool(await awaitStreamOf('tidy up'), 'c1', 'session_archive', { session_id: other.id });
    await vi.waitUntil(() => settled('session_archive').length === 1, { timeout: 5000, interval: 5 });
    expect((await store.get(other.id))?.archived).toBe(true);

    callTool(await awaitStreamOf('tidy up'), 'c2', 'session_archive', { session_id: other.id, archived: false });
    await vi.waitUntil(() => settled('session_archive').length === 2, { timeout: 5000, interval: 5 });
    expect((await store.get(other.id))?.archived).toBeUndefined();
  });
});
