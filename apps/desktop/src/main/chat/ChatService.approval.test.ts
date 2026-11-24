import { mkdtemp, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import type { AuthenticatedApiClient } from '@bike4mind/client-auth';
import type { ChatApprovalMode, ChatStreamEvent, ChatToolCall } from '@shared/chat';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ChatService } from './ChatService';
import { SessionStore } from './SessionStore';
import type { AccessStore } from './tools/AccessStore';
import { ApprovalGate } from './tools/ApprovalGate';
import { MessageQueue } from './MessageQueue';

vi.mock('../git/hostGitArgs', async importOriginal =>
  (await import('./plainFolderGit.testHelper')).skipGitOutsideRepositories(await importOriginal())
);

function frame(payload: unknown): string {
  return `data: ${typeof payload === 'string' ? payload : JSON.stringify(payload)}\n\n`;
}

function bashTurn(id: string, command: string, description?: string): string {
  return frame({
    type: 'tool_use',
    tools: [
      { id, name: 'bash_execute', arguments: JSON.stringify({ command, ...(description ? { description } : {}) }) },
    ],
  });
}

describe('ChatService approval gate', () => {
  let service: ChatService;
  let approvals: ApprovalGate;
  let events: ChatStreamEvent[];
  let post: ReturnType<typeof vi.fn>;
  let streams: PassThrough[];
  let root: string;
  let deps: ConstructorParameters<typeof ChatService>[0];

  const toolEvents = (status: ChatToolCall['status']) =>
    events.filter(event => (event.type === 'tool-start' || event.type === 'tool-end') && event.call.status === status);

  /**
   * A conversation on 'ask', which is the mode this file is about.
   *
   * Named rather than left to the default, because the default is 'auto' and under it half the
   * commands below never reach the gate at all. What is tested here is the gate, not the mode.
   */
  async function askingSession(): Promise<string> {
    const session = await service.createSession();
    await service.setApprovalMode(session.id, 'ask');
    return session.id;
  }

  /** The id announced with the 'awaiting-approval' event, which is the only place it appears. */
  async function pendingApprovalId(): Promise<string> {
    const event = await vi.waitUntil(() => toolEvents('awaiting-approval')[0], { timeout: 3000, interval: 5 });
    if (event.type !== 'tool-start' || !event.call.approvalId) throw new Error('no approval announced');
    return event.call.approvalId;
  }

  beforeEach(async () => {
    root = await realpath(await mkdtemp(join(tmpdir(), 'b4m-approve-')));
    approvals = new ApprovalGate();
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
    post = boundPost;

    deps = {
      store: new SessionStore(await mkdtemp(join(tmpdir(), 'b4m-approve-sessions-')), 'test-model'),
      access: { list: async () => [root] } as unknown as AccessStore,
      approvals,
      logger: { debug: vi.fn(), warn: vi.fn() },
      getApiClient: () =>
        ({
          get: vi.fn().mockResolvedValue({}),
          getAxiosInstance: () => ({ post: boundPost }),
        }) as unknown as AuthenticatedApiClient,
      getEnvironmentUrl: () => 'http://localhost:3000',
      emit: event => emitted.push(event),
    };
    service = new ChatService(deps);
  });

  it('declares bash_execute alongside the file tools', async () => {
    const id = await askingSession();
    await service.send(id, 'hi');
    await vi.waitUntil(() => streams.length === 1, { timeout: 3000, interval: 5 });

    const declared = post.mock.calls[0][1].options.tools.map(
      (entry: { toolSchema: { name: string } }) => entry.toolSchema.name
    );
    expect(declared).toContain('bash_execute');
  });

  /** The point of the gate: nothing has run, and the turn has not advanced, until the user answers. */
  it('holds the command at the gate and runs nothing until the user answers', async () => {
    const id = await askingSession();
    await service.send(id, 'what is on port 3000?');
    await vi.waitUntil(() => streams.length === 1, { timeout: 3000, interval: 5 });

    streams[0].write(bashTurn('call_1', 'echo ran-without-asking'));
    streams[0].write(frame('[DONE]'));

    const announced = await pendingApprovalId();
    expect(announced).toBeTruthy();

    // No second request, so no tool_result: the tool has not been run.
    await new Promise(resolve => setTimeout(resolve, 150));
    expect(post).toHaveBeenCalledTimes(1);
    expect(toolEvents('running')).toHaveLength(0);
  });

  it('runs the command once allowed, and feeds its output back to the model', async () => {
    const id = await askingSession();
    await service.send(id, 'run it');
    await vi.waitUntil(() => streams.length === 1, { timeout: 3000, interval: 5 });

    streams[0].write(bashTurn('call_1', 'echo approved-and-ran'));
    streams[0].write(frame('[DONE]'));
    approvals.resolve(await pendingApprovalId(), { decision: 'once' });

    await vi.waitUntil(() => post.mock.calls.length === 2, { timeout: 5000, interval: 10 });
    const result = post.mock.calls[1][1].messages[3].content[0];
    expect(result.content).toContain('approved-and-ran');
    expect(result.is_error).toBeUndefined();
  });

  it('tells the model it was declined, without ending the turn', async () => {
    const id = await askingSession();
    await service.send(id, 'run it');
    await vi.waitUntil(() => streams.length === 1, { timeout: 3000, interval: 5 });

    streams[0].write(bashTurn('call_1', 'echo should-never-run'));
    streams[0].write(frame('[DONE]'));
    approvals.resolve(await pendingApprovalId(), { decision: 'deny' });

    await vi.waitUntil(() => post.mock.calls.length === 2, { timeout: 3000, interval: 5 });
    const result = post.mock.calls[1][1].messages[3].content[0];
    expect(result).toMatchObject({ type: 'tool_result', is_error: true });
    expect(result.content).toMatch(/declined/);

    // The conversation carries on: the model gets to say something about the refusal.
    streams[1].write(frame({ type: 'content', text: 'Understood, I will not run that.' }));
    streams[1].write(frame('[DONE]'));
    await expect(
      vi.waitUntil(() => events.find(event => event.type === 'done'), { timeout: 3000, interval: 5 })
    ).resolves.toMatchObject({ content: 'Understood, I will not run that.' });
  });

  it('stops asking for a command the user allowed always, and still asks for a different program', async () => {
    const id = await askingSession();
    await service.send(id, 'run it twice');
    await vi.waitUntil(() => streams.length === 1, { timeout: 3000, interval: 5 });

    streams[0].write(bashTurn('call_1', 'echo repeated'));
    streams[0].write(frame('[DONE]'));
    approvals.resolve(await pendingApprovalId(), { decision: 'always' });

    await vi.waitUntil(() => streams.length === 2, { timeout: 5000, interval: 10 });
    streams[1].write(bashTurn('call_2', 'echo repeated'));
    streams[1].write(frame('[DONE]'));

    // Straight through the gate: a third request means it ran without asking again.
    await vi.waitUntil(() => streams.length === 3, { timeout: 5000, interval: 10 });
    expect(toolEvents('awaiting-approval')).toHaveLength(1);

    streams[2].write(bashTurn('call_3', 'ls -la'));
    streams[2].write(frame('[DONE]'));
    await vi.waitUntil(() => toolEvents('awaiting-approval').length === 2, { timeout: 3000, interval: 5 });
  });

  it("puts the model's description on the card beside the command, and lets an allowance ignore it", async () => {
    const id = await askingSession();
    await service.send(id, 'run it twice');
    await vi.waitUntil(() => streams.length === 1, { timeout: 3000, interval: 5 });

    streams[0].write(bashTurn('call_1', 'echo described', 'Prints a word'));
    streams[0].write(frame('[DONE]'));
    const approvalId = await pendingApprovalId();
    const asked = toolEvents('awaiting-approval')[0];
    if (asked.type !== 'tool-start') throw new Error('no approval announced');
    expect(asked.call.approvalDescription).toBe('Prints a word');
    expect(asked.call.approvalDetail).toContain('$ echo described');
    expect(asked.call.approvalDetail).not.toContain('Prints a word');
    approvals.resolve(approvalId, { decision: 'always' });

    await vi.waitUntil(() => streams.length === 2, { timeout: 5000, interval: 10 });
    streams[1].write(bashTurn('call_2', 'echo described', 'Says something else entirely'));
    streams[1].write(frame('[DONE]'));

    await vi.waitUntil(() => streams.length === 3, { timeout: 5000, interval: 10 });
    expect(toolEvents('awaiting-approval')).toHaveLength(1);
  });

  it('sends no description for a call that gave none', async () => {
    const id = await askingSession();
    await service.send(id, 'run it');
    await vi.waitUntil(() => streams.length === 1, { timeout: 3000, interval: 5 });

    streams[0].write(bashTurn('call_1', 'echo plain'));
    streams[0].write(frame('[DONE]'));
    await pendingApprovalId();
    const asked = toolEvents('awaiting-approval')[0];
    if (asked.type !== 'tool-start') throw new Error('no approval announced');
    expect(asked.call).not.toHaveProperty('approvalDescription');
  });

  it('does not gate the read-only file tools', async () => {
    const id = await askingSession();
    await service.send(id, 'list files');
    await vi.waitUntil(() => streams.length === 1, { timeout: 3000, interval: 5 });

    streams[0].write(
      frame({
        type: 'tool_use',
        tools: [{ id: 'c1', name: 'glob_files', arguments: JSON.stringify({ pattern: '*' }) }],
      })
    );
    streams[0].write(frame('[DONE]'));

    await vi.waitUntil(() => post.mock.calls.length === 2, { timeout: 3000, interval: 5 });
    expect(toolEvents('awaiting-approval')).toHaveLength(0);
  });

  it('denies a pending approval when the reply is stopped, rather than leaving it hanging', async () => {
    const id = await askingSession();
    await service.send(id, 'run it');
    await vi.waitUntil(() => streams.length === 1, { timeout: 3000, interval: 5 });

    streams[0].write(bashTurn('call_1', 'echo should-never-run'));
    streams[0].write(frame('[DONE]'));
    await pendingApprovalId();

    service.stop(id);

    const done = await vi.waitUntil(() => events.find(event => event.type === 'done'), { timeout: 3000, interval: 5 });
    expect(done).toMatchObject({ stopReason: 'aborted' });
    expect(toolEvents('running')).toHaveLength(0);
  });

  /** A slow reviewer is not the agent working: the card's wait must not spend the turn's time budget. */
  it('does not count time spent waiting on an approval card toward the time budget', async () => {
    // Long enough for a round's own work, shorter than the card wait below.
    service = new ChatService({ ...deps, turnLimits: { wallClockMs: 1_500 } });
    const id = await askingSession();
    await service.send(id, 'run it');
    await vi.waitUntil(() => streams.length === 1, { timeout: 3000, interval: 5 });

    streams[0].write(bashTurn('call_1', 'echo after-a-slow-answer'));
    streams[0].write(frame('[DONE]'));
    const approvalId = await pendingApprovalId();
    // Past the whole 1.5s budget, all of it on the card.
    await new Promise(resolve => setTimeout(resolve, 2_000));
    approvals.resolve(approvalId, { decision: 'once' });

    // A second request means the turn carried on rather than stopping at turn_time_limit.
    await vi.waitUntil(() => streams.length === 2, { timeout: 5000, interval: 10 });
    streams[1].write(frame({ type: 'content', text: 'Done.' }));
    streams[1].write(frame('[DONE]'));
    const done = await vi.waitUntil(() => events.find(event => event.type === 'done'), { timeout: 3000, interval: 5 });
    expect(done).toMatchObject({ content: 'Done.' });
    expect(done).not.toMatchObject({ stopReason: 'turn_time_limit' });
  }, 15_000);
});

describe('askUser', () => {
  function frame(payload: unknown): string {
    return `data: ${typeof payload === 'string' ? payload : JSON.stringify(payload)}\n\n`;
  }

  function toolTurn(id: string, name: string, input: Record<string, unknown>): string {
    return frame({ type: 'tool_use', tools: [{ id, name, arguments: JSON.stringify(input) }] });
  }

  const QUESTIONS = [
    {
      question: 'Which auth method?',
      header: 'Auth',
      options: [
        { label: 'OAuth (Recommended)', description: 'Delegated sign-in.' },
        { label: 'API keys', description: 'Static secrets.' },
      ],
    },
  ];

  /** Asking is harmless, so no approval mode may put a card in front of it other than its own. */
  describe('ChatService ask_user', () => {
    let store: SessionStore;
    let service: ChatService;
    let approvals: ApprovalGate;
    let events: ChatStreamEvent[];
    let streams: PassThrough[];
    let post: ReturnType<typeof vi.fn>;
    let root: string;

    const calls = (status: ChatToolCall['status']): ChatToolCall[] =>
      events
        .map(event => (event.type === 'tool-start' || event.type === 'tool-end' ? event.call : null))
        .filter((call): call is ChatToolCall => call !== null && call.status === status);

    const awaitStatus = (status: ChatToolCall['status']) =>
      vi.waitUntil(() => calls(status)[0], { timeout: 5000, interval: 10 });

    /** Start the session's one pending spawn suggestion from its card, in this working directory. */
    async function startSuggested(sessionId: string): Promise<void> {
      const suggestion = await vi.waitUntil(
        () => {
          const latest = events.findLast(event => event.type === 'spawn-suggestions' && event.sessionId === sessionId);
          return latest?.type === 'spawn-suggestions'
            ? latest.suggestions.find(entry => entry.status === 'pending')
            : undefined;
        },
        { timeout: 5000, interval: 10 }
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

    const toolNames = (callIndex: number): string[] =>
      (post.mock.calls[callIndex][1].options.tools as { toolSchema: { name: string } }[]).map(
        tool => tool.toolSchema.name
      );

    beforeEach(async () => {
      root = await realpath(await mkdtemp(join(tmpdir(), 'b4m-ask-')));
      store = new SessionStore(await mkdtemp(join(tmpdir(), 'b4m-ask-sessions-')), 'test-model');
      approvals = new ApprovalGate();
      const testEvents: ChatStreamEvent[] = [];
      const testStreams: PassThrough[] = [];
      const testPost = vi.fn().mockImplementation(() => {
        const stream = new PassThrough();
        testStreams.push(stream);
        return Promise.resolve({ data: stream, status: 200 });
      });
      events = testEvents;
      streams = testStreams;
      post = testPost;

      service = new ChatService({
        store,
        access: { list: async () => [root] } as unknown as AccessStore,
        approvals,
        queue: new MessageQueue(() => {}),
        logger: { debug: vi.fn(), warn: vi.fn() },
        getApiClient: () =>
          ({
            get: vi.fn().mockResolvedValue({}),
            getAxiosInstance: () => ({ post: testPost }),
          }) as unknown as AuthenticatedApiClient,
        getEnvironmentUrl: () => 'http://localhost:3000',
        emit: event => testEvents.push(event),
      });
    });

    afterEach(() => {
      service.dispose();
      for (const stream of streams) stream.end();
    });

    async function startTurn(mode: ChatApprovalMode = 'auto') {
      const session = await service.createSession();
      await service.setApprovalMode(session.id, mode);
      await service.send(session.id, 'go');
      await vi.waitUntil(() => streams.length === 1, { timeout: 5000, interval: 5 });
      return session;
    }

    async function ask(input: Record<string, unknown> = { questions: QUESTIONS }): Promise<ToolCard> {
      streams[0].write(toolTurn('q1', 'ask_user', input));
      streams[0].write(frame('[DONE]'));
      return awaitStatus('awaiting-approval');
    }

    type ToolCard = ChatToolCall;

    for (const mode of ['ask', 'auto', 'full'] as const) {
      it(`shows only its own question card in "${mode}" mode`, async () => {
        await startTurn(mode);
        const card = await ask();
        expect(card.name).toBe('ask_user');
        expect(card.approvalDetail).toBeUndefined();
        expect(card.approvalId).toBeTruthy();
        expect((card.input.questions as unknown[]).length).toBe(1);
      });
    }

    it('hands the model the chosen labels and records them on the call', async () => {
      await startTurn();
      const card = await ask();
      approvals.resolve(card.approvalId as string, {
        decision: 'once',
        answers: [{ selected: ['OAuth (Recommended)'] }],
      });

      const done = await awaitStatus('done');
      expect(done.preview).toContain('"Which auth method?" -> "OAuth (Recommended)"');
      expect(done.input.outcome).toEqual({ status: 'answered', answers: [{ selected: ['OAuth (Recommended)'] }] });
    });

    it('reports typed Other text, and ignores a label the card never offered', async () => {
      await startTurn();
      const card = await ask();
      approvals.resolve(card.approvalId as string, {
        decision: 'once',
        answers: [{ selected: ['Made up'], other: '  mTLS  ' }],
      });

      const done = await awaitStatus('done');
      expect(done.preview).toContain('"Which auth method?" -> Other: "mTLS"');
    });

    it('tells the model the user skipped', async () => {
      await startTurn();
      const card = await ask();
      approvals.resolve(card.approvalId as string, { decision: 'deny' });

      const done = await awaitStatus('done');
      expect(done.preview).toMatch(/skipped/);
      expect(done.input.outcome).toEqual({ status: 'skipped' });
    });

    it('does not answer for the user when the model sends its own outcome', async () => {
      await startTurn();
      const card = await ask({ questions: QUESTIONS, outcome: { status: 'answered', answers: [{ selected: ['x'] }] } });
      expect(card.approvalId).toBeTruthy();
      expect(calls('done')).toHaveLength(0);
    });

    it('cancels the card when the user sends a new message instead', async () => {
      const session = await startTurn();
      await ask();
      const queued = await service.send(session.id, 'actually, never mind');
      expect(queued.ok && queued.queued).toBe(true);

      const done = await awaitStatus('done');
      expect(done.input.outcome).toEqual({ status: 'cancelled' });
    });

    it('cancels the card when the reply is stopped', async () => {
      const session = await startTurn();
      await ask();
      service.stop(session.id);

      const done = await awaitStatus('done');
      expect(done.input.outcome).toEqual({ status: 'cancelled' });
    });

    it('asks a call whose header is too long, with the card and the record agreeing on it', async () => {
      await startTurn();
      const card = await ask({ questions: [{ ...QUESTIONS[0], header: 'board-watchers' }] });
      const headerOf = (call: ChatToolCall) => (call.input.questions as { header: string }[])[0].header;
      expect(headerOf(card)).toBe('board-watch\u2026');

      approvals.resolve(card.approvalId as string, { decision: 'once', answers: [{ selected: ['API keys'] }] });
      const done = await awaitStatus('done');
      expect(headerOf(done)).toBe('board-watch\u2026');
      expect(done.preview).toContain('"Which auth method?" -> "API keys"');
      expect(calls('error')).toHaveLength(0);
    });

    it('refuses a malformed call with the reason, without raising a card', async () => {
      await startTurn();
      streams[0].write(
        toolTurn('q1', 'ask_user', { questions: [{ ...QUESTIONS[0], options: [QUESTIONS[0].options[0]] }] })
      );
      streams[0].write(frame('[DONE]'));

      const failed = await awaitStatus('error');
      expect(failed.error).toMatch(/2 to 4 options/);
      expect(calls('awaiting-approval')).toHaveLength(0);
    });

    it('is not counted by the doom-loop guard when asked three times running', async () => {
      await startTurn('auto');
      streams[0].write(toolTurn('q1', 'ask_user', { questions: QUESTIONS }));
      streams[0].write(toolTurn('q2', 'ask_user', { questions: QUESTIONS }));
      streams[0].write(toolTurn('q3', 'ask_user', { questions: QUESTIONS }));
      streams[0].write(frame('[DONE]'));

      await vi.waitUntil(() => calls('awaiting-approval').length === 3, { timeout: 5000, interval: 10 });
      expect(calls('awaiting-approval').every(call => call.name === 'ask_user')).toBe(true);
    });

    describe('where it is offered', () => {
      it('is in the tool list of a Chat conversation with no folder', async () => {
        const session = await service.createSession();
        await service.send(session.id, 'hi');
        await vi.waitUntil(() => post.mock.calls.length === 1, { timeout: 5000, interval: 5 });
        expect(toolNames(0)).toContain('ask_user');
      });

      it('is in the tool list of a main Code conversation', async () => {
        await startTurn();
        expect(toolNames(0)).toContain('ask_user');
      });

      it('is not offered to a spawned session', async () => {
        const created = await service.createCodeSession({ directory: root, branch: '', workspace: false });
        if (!created.ok) throw new Error(created.error);
        await service.send(created.session.id, 'go');
        await vi.waitUntil(() => streams.length === 1, { timeout: 5000, interval: 5 });
        streams[0].write(toolTurn('s1', 'session_spawn', { prompt: 'do the thing', title: 'child' }));
        streams[0].write(frame('[DONE]'));

        await startSuggested(created.session.id);
        const childCall = () =>
          post.mock.calls.findIndex(([, body]) => {
            const last = body.messages[body.messages.length - 1];
            return last.role === 'user' && typeof last.content === 'string' && last.content.includes('do the thing');
          });
        await vi.waitUntil(() => childCall() >= 0, { timeout: 5000, interval: 5 });

        expect(toolNames(0)).toContain('ask_user');
        expect(toolNames(childCall())).not.toContain('ask_user');
      });
    });
  });
});
