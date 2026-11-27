import { mkdtemp, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import type { AuthenticatedApiClient } from '@bike4mind/client-auth';
import type { ChatSessionSummary, ChatStreamEvent } from '@shared/chat';
import { formatSessionMention } from '@shared/sessionMention';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ChatService } from './ChatService';
import { MessageQueue } from './MessageQueue';
import { SessionStore } from './SessionStore';
import type { AccessStore } from './tools/AccessStore';
import { ApprovalGate } from './tools/ApprovalGate';

vi.mock('../git/hostGitArgs', async importOriginal =>
  (await import('./plainFolderGit.testHelper')).skipGitOutsideRepositories(await importOriginal())
);

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
  /** Every summary the service pushed to the renderer, which is what redraws the sidebar row. */
  let pushed: ChatSessionSummary[];

  beforeEach(async () => {
    projectA = await realpath(await mkdtemp(join(tmpdir(), 'b4m-host-a-')));
    projectB = await realpath(await mkdtemp(join(tmpdir(), 'b4m-host-b-')));
    store = new SessionStore(await mkdtemp(join(tmpdir(), 'b4m-host-sessions-')), 'test-model');
    // Bound per test: a previous service replying late must not push into this test's events.
    const emitted: ChatStreamEvent[] = [];
    events = emitted;
    const opened: PassThrough[] = [];
    streams = opened;
    asked = [];
    const summaries: ChatSessionSummary[] = [];
    pushed = summaries;
    const boundPost = vi.fn().mockImplementation(() => {
      const stream = new PassThrough();
      opened.push(stream);
      return Promise.resolve({ data: stream, status: 200 });
    });
    post = boundPost;
    approvals = new ApprovalGate({ requested: vi.fn(), settled: vi.fn() });

    service = new ChatService({
      store,
      access: { list: async () => [] } as unknown as AccessStore,
      approvals,
      logger: { debug: vi.fn(), warn: vi.fn() },
      queue: new MessageQueue(() => undefined),
      getApiClient: () =>
        ({
          get: vi.fn().mockResolvedValue({}),
          getAxiosInstance: () => ({ post: boundPost }),
        }) as unknown as AuthenticatedApiClient,
      getEnvironmentUrl: () => 'http://localhost:3000',
      summaryChanged: summary => summaries.push(summary),
      emit: event => {
        emitted.push(event);
        // Stand in for the user, answering every ask the moment it is raised. 'always' is
        // chosen so that anything which CAN become a standing approval does, and a card that
        // offers a choice is answered with the option that runs where the caller already is:
        // these tests use a plain temp directory with no repository, and what they are about is
        // the app-control plumbing rather than where a child lands.
        if (event.type === 'tool-start' && event.call.approvalId) {
          asked.push({ approvalId: event.call.approvalId, toolName: event.call.name });
          approvals.resolve(event.call.approvalId, {
            decision: 'always',
            ...(event.call.approvalChoice ? { optionId: 'local' } : {}),
          });
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

  /** Start the session's one pending suggestion from its card, in this working directory. */
  async function startSuggested(sessionId: string): Promise<void> {
    const suggestion = await vi.waitUntil(
      () => {
        const latest = events.findLast(event => event.type === 'spawn-suggestions' && event.sessionId === sessionId);
        return latest?.type === 'spawn-suggestions'
          ? latest.suggestions.find(entry => entry.status === 'pending')
          : undefined;
      },
      { timeout: 5000, interval: 5 }
    );
    const result = await service.startSpawnSuggestion({
      sessionId,
      suggestionId: suggestion.id,
      placement: 'local',
      prompt: suggestion.prompt,
      title: suggestion.title,
    });
    if (!result.ok) throw new Error(result.error);
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
    // The orchestrator label needs no project: it labels the caller's own row.
    expect(chatTools).toContain('orchestrator_label');

    const code = await codeSession(projectA);
    await service.send(code.id, 'hello');
    await vi.waitUntil(() => streams.length === 2, { timeout: 5000, interval: 5 });
    const codeTools = (post.mock.calls[1][1].options.tools as { toolSchema: { name: string } }[]).map(
      entry => entry.toolSchema.name
    );
    expect(codeTools.filter(name => name.startsWith('session_'))).toEqual([
      'session_list',
      'session_read',
      'session_send',
      'session_archive',
      'session_rename',
      'session_delete',
      'session_spawn',
      'session_suggestion_update',
      'session_suggestion_dismiss',
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

  it('lists another project with no reply excerpt until the user mentions that conversation', async () => {
    const mine = await codeSession(projectA);
    const theirs = await codeSession(projectB);
    const at = new Date().toISOString();
    await store.appendMessage(theirs.id, { id: 'r1', role: 'assistant', content: 'private reply', createdAt: at });

    await service.send(mine.id, 'list everything');
    callTool(await awaitStreamOf('list everything'), 'c1', 'session_list', { scope: 'all' });
    await vi.waitUntil(() => settled('session_list').length === 1, { timeout: 5000, interval: 5 });
    expect(settled('session_list')[0]?.preview).toContain(theirs.id);
    expect(settled('session_list')[0]?.preview).not.toContain('private reply');

    const told = await codeSession(projectA);
    const prompt = `what did ${formatSessionMention(theirs.id, theirs.title)} say?`;
    await service.send(told.id, prompt);
    callTool(await awaitStreamOf(prompt), 'c2', 'session_list', { scope: 'all' });
    await vi.waitUntil(() => settled('session_list').length === 2, { timeout: 5000, interval: 5 });
    expect(settled('session_list')[1]?.preview).toContain('private reply');
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

  it('names an out-of-project session on a send card but not on an archive or delete card', async () => {
    const mine = await codeSession(projectA);
    const theirs = await codeSession(projectB);
    await store.rename(theirs.id, 'Elsewhere');
    await store.setApprovalMode(mine.id, 'ask');

    await service.send(mine.id, 'reach out');
    const stream = await awaitStreamOf('reach out');
    const tools = [
      { id: 'c1', name: 'session_archive', arguments: JSON.stringify({ session_id: theirs.id }) },
      { id: 'c2', name: 'session_send', arguments: JSON.stringify({ session_id: theirs.id, message: 'hello' }) },
      { id: 'c3', name: 'session_delete', arguments: JSON.stringify({ session_id: theirs.id }) },
    ];
    stream.write(frame({ type: 'tool_use', tools }));
    stream.write(frame('[DONE]'));
    await vi.waitUntil(
      () =>
        settled('session_archive').length === 1 &&
        settled('session_send').length === 1 &&
        settled('session_delete').length === 1,
      { timeout: 5000, interval: 5 }
    );

    const detailOf = (name: string) =>
      events.flatMap(event => (event.type === 'tool-start' && event.call.name === name ? [event.call] : []))[0]
        ?.approvalDetail;
    expect(detailOf('session_archive')).toContain(theirs.id);
    expect(detailOf('session_archive')).not.toContain('Elsewhere');
    expect(detailOf('session_delete')).toContain(theirs.id);
    expect(detailOf('session_delete')).not.toContain('Elsewhere');
    expect(detailOf('session_send')).toContain('Elsewhere');
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

  it('deletes a batch of conversations behind a single approval', async () => {
    const mine = await codeSession(projectA);
    const targets = [await codeSession(projectA), await codeSession(projectA), await codeSession(projectA)];
    const elsewhere = await codeSession(projectB);
    const ids = [...targets.map(target => target.id), elsewhere.id];

    await service.send(mine.id, 'tidy all');
    callTool(await awaitStreamOf('tidy all'), 'c1', 'session_delete', { session_ids: ids });
    await vi.waitUntil(() => settled('session_delete').length === 1, { timeout: 5000, interval: 5 });

    expect(asked.filter(entry => entry.toolName === 'session_delete')).toHaveLength(1);
    for (const target of targets) expect(await store.get(target.id)).toBeNull();
    expect(await store.get(elsewhere.id)).not.toBeNull();
    const preview = settled('session_delete')[0]?.preview ?? '';
    expect(preview).toContain('Deleted 3 of 4 conversations');
    expect(preview).toContain(elsewhere.id);

    const prompt = events.flatMap(event =>
      event.type === 'tool-start' && event.call.name === 'session_delete' && event.call.approvalId ? [event.call] : []
    )[0];
    expect(prompt?.approvalIrreversible).toBe(true);
    expect(prompt?.approvalDetail).toContain('these 4 conversations');
  });

  it('refuses a batch over the cap, or one naming the caller, without deleting anything', async () => {
    const mine = await codeSession(projectA);
    const other = await codeSession(projectA);

    await service.send(mine.id, 'too many');
    const tooMany = Array.from({ length: 26 }, (_, index) => `missing-${index}`);
    callTool(await awaitStreamOf('too many'), 'c1', 'session_delete', { session_ids: [other.id, ...tooMany] });
    await vi.waitUntil(() => settled('session_delete').length === 1, { timeout: 5000, interval: 5 });
    expect(JSON.stringify(settled('session_delete')[0])).toMatch(/at most 25/);

    callTool(await awaitStreamOf('too many'), 'c2', 'session_delete', { session_ids: [other.id, mine.id] });
    await vi.waitUntil(() => settled('session_delete').length === 2, { timeout: 5000, interval: 5 });
    expect(JSON.stringify(settled('session_delete')[1])).toMatch(/cannot delete itself/);
    expect(asked.filter(entry => entry.toolName === 'session_delete')).toHaveLength(0);
    expect(await store.get(other.id)).not.toBeNull();
  });

  it('tells a parent that a spawned session finished, with its reply quoted as data, once the parent is idle', async () => {
    const parent = await codeSession(projectA);
    await service.send(parent.id, 'delegate it');
    callTool(await awaitStreamOf('delegate it'), 'c1', 'session_spawn', { prompt: 'go and do it' });
    await vi.waitUntil(() => settled('session_spawn').length === 1, { timeout: 5000, interval: 5 });
    await startSuggested(parent.id);

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
    // The reply rides along fenced as the session's own words, never as the user's.
    expect(notice?.content).toContain('<child-reply>\nFinished: the file is updated.\n</child-reply>');
    expect(notice?.content).toContain("not the user's");
    expect(notice?.display).not.toContain('Finished: the file is updated.');
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
    await startSuggested(parent.id);

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

  describe('orchestrator_label', () => {
    const outcomeOf = (index: number): string => JSON.stringify(settled('orchestrator_label')[index] ?? null);
    const labelCall = async (prompt: string, id: string, args: Record<string, unknown>, count: number) => {
      callTool(await awaitStreamOf(prompt), id, 'orchestrator_label', args);
      await vi.waitUntil(() => settled('orchestrator_label').length === count, { timeout: 5000, interval: 5 });
    };

    it('sets and clears the label on the calling conversation, with no card, and pushes it to the sidebar', async () => {
      const mine = await codeSession(projectA);

      await service.send(mine.id, 'mark yourself');
      await labelCall('mark yourself', 'c1', { label: 'on' }, 1);
      expect(await store.get(mine.id)).toMatchObject({ orchestratorLabel: 'on' });
      expect(pushed.findLast(summary => summary.id === mine.id)).toMatchObject({ orchestratorLabel: 'on' });

      await labelCall('mark yourself', 'c2', { label: 'auto' }, 2);
      expect(await store.get(mine.id)).not.toHaveProperty('orchestratorLabel');
      expect(pushed.findLast(summary => summary.id === mine.id)).not.toHaveProperty('orchestratorLabel');
      expect(asked.filter(entry => entry.toolName === 'orchestrator_label')).toEqual([]);
    });

    it('stores a label that matches the automatic rule as auto, and pins one that differs', async () => {
      const mine = await codeSession(projectA);
      await store.setOrchestrate(mine.id, true);

      await service.send(mine.id, 'mark yourself');
      await labelCall('mark yourself', 'c1', { label: 'on' }, 1);
      expect(await store.get(mine.id)).not.toHaveProperty('orchestratorLabel');

      await labelCall('mark yourself', 'c2', { label: 'off' }, 2);
      expect(await store.get(mine.id)).toMatchObject({ orchestratorLabel: 'off' });
    });

    it("refuses 'off' while the conversation has running agents", async () => {
      const mine = await codeSession(projectA);
      await store.setOrchestratorLabel(mine.id, 'on');
      await store.create(undefined, {
        mode: 'code',
        origin: { parentSessionId: mine.id, depth: 1, seedPrompt: 'child task' },
      });

      await service.send(mine.id, 'hide yourself');
      await labelCall('hide yourself', 'c1', { label: 'off' }, 1);
      expect(outcomeOf(0)).toMatch(/has running agents/);
      expect(await store.get(mine.id)).toMatchObject({ orchestratorLabel: 'on' });
    });

    it('pushes a row-menu change to the sidebar too', async () => {
      const mine = await codeSession(projectA);
      await service.setSessionOrchestratorLabel(mine.id, 'on');
      expect(pushed.findLast(summary => summary.id === mine.id)).toMatchObject({ orchestratorLabel: 'on' });
    });

    it('works in a Chat session with no project', async () => {
      const chat = await service.createSession();
      await service.send(chat.id, 'mark the chat');
      await labelCall('mark the chat', 'c1', { label: 'on' }, 1);
      expect(await store.get(chat.id)).toMatchObject({ orchestratorLabel: 'on' });
    });

    it('never touches another conversation, even when one is named', async () => {
      const mine = await codeSession(projectA);
      const sibling = await codeSession(projectA);

      await service.send(mine.id, 'mark the sibling');
      await labelCall('mark the sibling', 'c1', { label: 'on', session_id: sibling.id }, 1);
      expect(await store.get(sibling.id)).not.toHaveProperty('orchestratorLabel');
      expect(await store.get(mine.id)).toMatchObject({ orchestratorLabel: 'on' });
    });

    it('leaves Orchestrate and the spawn gate alone', async () => {
      const mine = await codeSession(projectA);
      const approvalMode = (await store.get(mine.id))?.approvalMode;

      await service.send(mine.id, 'mark only');
      await labelCall('mark only', 'c1', { label: 'on' }, 1);
      const stored = await store.get(mine.id);
      expect(stored).not.toHaveProperty('orchestrate');
      expect(stored).not.toHaveProperty('orchestrator');
      expect(stored?.approvalMode).toBe(approvalMode);
      expect(outcomeOf(0)).toMatch(/Orchestrate mode and spawn approvals are unchanged/);
    });

    it('refuses in a turn the user did not type and leaves the label alone', async () => {
      const mine = await codeSession(projectA);
      await store.setOrchestratorLabel(mine.id, 'on');
      const setLabel = vi.spyOn(store, 'setOrchestratorLabel');

      const started = await service.startAutomaticTurn(mine.id, 'the build finished', {
        kind: 'background-exit',
        processIds: ['aaaa1111'],
        summary: 'build exited 0',
      });
      expect(started).toEqual({ ok: true });
      await vi.waitUntil(() => streams.length === 1, { timeout: 5000, interval: 5 });
      callTool(streams[0], 'c1', 'orchestrator_label', { label: 'off' });
      await vi.waitUntil(() => settled('orchestrator_label').length === 1, { timeout: 5000, interval: 5 });

      expect(outcomeOf(0)).toMatch(/only be changed in a turn the user typed/);
      expect(setLabel).not.toHaveBeenCalled();
      expect(await store.get(mine.id)).toMatchObject({ orchestratorLabel: 'on' });
    });

    it('refuses an unknown label', async () => {
      const mine = await codeSession(projectA);
      await service.send(mine.id, 'bad label');
      await labelCall('bad label', 'c1', { label: 'maybe' }, 1);
      expect(outcomeOf(0)).toMatch(/argument must be .*on.*off.*auto/);
      expect(await store.get(mine.id)).not.toHaveProperty('orchestratorLabel');
    });
  });

  describe('session_rename', () => {
    /** A session the caller started, in the caller's own project. */
    async function childOf(parent: ChatSessionSummary): Promise<ChatSessionSummary> {
      const stored = await store.get(parent.id);
      return store.create(undefined, {
        mode: 'code',
        ...(stored?.project ? { project: stored.project } : {}),
        origin: { parentSessionId: parent.id, depth: 1, seedPrompt: 'child task' },
      });
    }

    const outcomeOf = (index: number): string => JSON.stringify(settled('session_rename')[index] ?? null);

    it('renames the calling conversation when session_id is omitted or "self"', async () => {
      const mine = await codeSession(projectA);

      await service.send(mine.id, 'name yourself');
      callTool(await awaitStreamOf('name yourself'), 'c1', 'session_rename', {
        title: '  #12 | PR#34 | rename tool  ',
      });
      await vi.waitUntil(() => settled('session_rename').length === 1, { timeout: 5000, interval: 5 });
      expect(await store.get(mine.id)).toMatchObject({
        title: '#12 | PR#34 | rename tool',
        titleLocked: true,
        titleSource: 'agent',
      });

      callTool(await awaitStreamOf('name yourself'), 'c2', 'session_rename', { session_id: 'self', title: 'Second' });
      await vi.waitUntil(() => settled('session_rename').length === 2, { timeout: 5000, interval: 5 });
      expect((await store.get(mine.id))?.title).toBe('Second');
    });

    it('renames a conversation it started', async () => {
      const mine = await codeSession(projectA);
      const child = await childOf(mine);

      await service.send(mine.id, 'name the child');
      callTool(await awaitStreamOf('name the child'), 'c1', 'session_rename', {
        session_id: child.id,
        title: 'Child work',
      });
      await vi.waitUntil(() => settled('session_rename').length === 1, { timeout: 5000, interval: 5 });
      expect(await store.get(child.id)).toMatchObject({ title: 'Child work', titleSource: 'agent' });
    });

    it('refuses a conversation it did not start, in this project or another', async () => {
      const mine = await codeSession(projectA);
      const sibling = await codeSession(projectA);
      const theirs = await codeSession(projectB);
      const before = { sibling: (await store.get(sibling.id))?.title, theirs: (await store.get(theirs.id))?.title };

      await service.send(mine.id, 'rename others');
      callTool(await awaitStreamOf('rename others'), 'c1', 'session_rename', { session_id: sibling.id, title: 'Nope' });
      await vi.waitUntil(() => settled('session_rename').length === 1, { timeout: 5000, interval: 5 });
      callTool(await awaitStreamOf('rename others'), 'c2', 'session_rename', { session_id: theirs.id, title: 'Nope' });
      await vi.waitUntil(() => settled('session_rename').length === 2, { timeout: 5000, interval: 5 });

      expect(outcomeOf(0)).toMatch(/Only this conversation and the ones it started can be renamed/);
      expect(outcomeOf(1)).toMatch(/Only this conversation and the ones it started can be renamed/);
      expect((await store.get(sibling.id))?.title).toBe(before.sibling);
      expect((await store.get(theirs.id))?.title).toBe(before.theirs);
    });

    it('never overwrites a title the user chose by hand', async () => {
      const mine = await codeSession(projectA);
      const child = await childOf(mine);
      await service.renameSession(child.id, 'Picked by the user');

      await service.send(mine.id, 'rename child');
      callTool(await awaitStreamOf('rename child'), 'c1', 'session_rename', { session_id: child.id, title: 'Agent' });
      await vi.waitUntil(() => settled('session_rename').length === 1, { timeout: 5000, interval: 5 });

      expect(outcomeOf(0)).toMatch(/named that conversation themselves/);
      expect((await store.get(child.id))?.title).toBe('Picked by the user');
    });

    it('stops renaming its own conversation once the user renames it after the agent did', async () => {
      const mine = await codeSession(projectA);

      await service.send(mine.id, 'self rename');
      callTool(await awaitStreamOf('self rename'), 'c1', 'session_rename', { title: 'Agent first' });
      await vi.waitUntil(() => settled('session_rename').length === 1, { timeout: 5000, interval: 5 });
      await service.renameSession(mine.id, 'User later');

      callTool(await awaitStreamOf('self rename'), 'c2', 'session_rename', { title: 'Agent again' });
      await vi.waitUntil(() => settled('session_rename').length === 2, { timeout: 5000, interval: 5 });
      expect(outcomeOf(1)).toMatch(/named that conversation themselves/);
      expect((await store.get(mine.id))?.title).toBe('User later');
    });

    it.each(['ask', 'auto', 'full'] as const)('asks for no approval in %s mode', async mode => {
      const mine = await codeSession(projectA);
      await store.setApprovalMode(mine.id, mode);

      await service.send(mine.id, `rename in ${mode}`);
      callTool(await awaitStreamOf(`rename in ${mode}`), 'c1', 'session_rename', { title: `Named in ${mode}` });
      await vi.waitUntil(() => settled('session_rename').length === 1, { timeout: 5000, interval: 5 });

      expect(asked.filter(entry => entry.toolName === 'session_rename')).toEqual([]);
      expect(settled('session_rename')[0]?.approvalId).toBeUndefined();
      expect((await store.get(mine.id))?.title).toBe(`Named in ${mode}`);
    });
  });
});
