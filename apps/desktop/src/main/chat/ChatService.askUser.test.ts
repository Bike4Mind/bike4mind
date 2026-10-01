import { mkdtemp, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import type { AuthenticatedApiClient } from '@bike4mind/client-auth';
import type { ChatApprovalMode, ChatStreamEvent, ChatToolCall } from '@shared/chat';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ChatService } from './ChatService';
import { MessageQueue } from './MessageQueue';
import { SessionStore } from './SessionStore';
import type { AccessStore } from './tools/AccessStore';
import { ApprovalGate } from './tools/ApprovalGate';

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

      const gate = await awaitStatus('awaiting-approval');
      approvals.resolve(gate.approvalId as string, { decision: 'once', optionId: 'local' });
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
