import { mkdtemp, realpath, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import type { AuthenticatedApiClient } from '@bike4mind/client-auth';
import { ChatModels } from '@bike4mind/common';
import type { ChatMessage, ChatStreamEvent } from '@shared/chat';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ChatService, sessionForRenderer } from './ChatService';
import { MessageQueue } from './MessageQueue';
import type { ModelCatalog } from './ModelCatalog';
import { SessionStore } from './SessionStore';
import type { AccessStore } from './tools/AccessStore';

type WireMessage = { role: string; content: unknown; cache?: boolean };
type Body = { messages: WireMessage[] };
type Call = { id: string; name: string; input: Record<string, unknown> };

const thinkingBlock = (text: string) => ({ type: 'thinking', thinking: text, signature: `sig-${text}` });

function frame(payload: unknown): string {
  return `data: ${typeof payload === 'string' ? payload : JSON.stringify(payload)}\n\n`;
}

const unmarked = ({ cache: _cache, ...rest }: WireMessage) => rest;

/** The messages of a request with the cache breakpoints, which move every turn, left out. */
const plain = (body: Body) => body.messages.map(unmarked);

const thinkingOf = (message: WireMessage): unknown[] =>
  Array.isArray(message.content) ? message.content.filter(block => block.type === 'thinking') : [];

describe('ChatService tool turn replay', () => {
  let store: SessionStore;
  let root: string;
  let roots: string[];
  let backends: Record<string, string>;
  let post: ReturnType<typeof vi.fn>;
  let streams: PassThrough[];
  let events: ChatStreamEvent[];
  let service: ChatService;

  beforeEach(async () => {
    root = await realpath(await mkdtemp(join(tmpdir(), 'b4m-replay-')));
    await writeFile(join(root, 'tiny.txt'), 'z', 'utf8');
    store = new SessionStore(await mkdtemp(join(tmpdir(), 'b4m-replay-sessions-')), ChatModels.CLAUDE_5_5_OPUS);
    roots = [root];
    backends = { [ChatModels.CLAUDE_5_5_OPUS]: 'anthropic', [ChatModels.CLAUDE_5_SONNET]: 'anthropic' };
    events = [];
    const opened: PassThrough[] = [];
    streams = opened;
    const boundPost = vi.fn().mockImplementation(() => {
      const stream = new PassThrough();
      opened.push(stream);
      return Promise.resolve({ data: stream, status: 200 });
    });
    post = boundPost;
    const emitted = events;
    service = new ChatService({
      store,
      queue: new MessageQueue(() => {}),
      models: {
        list: async () => ({
          models: Object.entries(backends).map(([id, backend]) => ({ id, name: id, backend })),
        }),
        cached: () => [],
      } as unknown as ModelCatalog,
      access: { list: async () => roots } as unknown as AccessStore,
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

  const body = (index: number): Body => post.mock.calls[index][1] as Body;
  const doneCount = () => events.filter(event => event.type === 'done').length;
  const waitForRequest = (count: number) => vi.waitUntil(() => streams.length >= count, { timeout: 3000, interval: 5 });

  /** Answers request `index` with one round: optional thinking and text, then optional tool calls. */
  function answer(index: number, round: { text?: string; thinking?: unknown[]; calls?: Call[] }): void {
    const stream = streams[index];
    if (round.text) stream.write(frame({ type: 'content', text: round.text }));
    if (round.calls) {
      stream.write(
        frame({
          type: 'tool_use',
          tools: round.calls.map(call => ({ id: call.id, name: call.name, arguments: JSON.stringify(call.input) })),
          ...(round.thinking ? { thinking: round.thinking } : {}),
        })
      );
    }
    stream.write(frame('[DONE]'));
  }

  /** Runs a whole turn from a script of rounds, the last of which answers; returns each request's body. */
  async function scripted(
    sessionId: string,
    prompt: string,
    rounds: { text?: string; thinking?: unknown[]; calls?: Call[]; before?: () => void }[]
  ): Promise<Body[]> {
    const first = post.mock.calls.length;
    const done = doneCount();
    await service.send(sessionId, prompt);
    for (const [offset, round] of rounds.entries()) {
      await waitForRequest(first + offset + 1);
      round.before?.();
      answer(first + offset, round);
    }
    await vi.waitUntil(() => doneCount() === done + 1, { timeout: 5000, interval: 5 });
    return rounds.map((_round, offset) => body(first + offset));
  }

  async function nextTurn(sessionId: string, text: string): Promise<Body> {
    const [request] = await scripted(sessionId, text, [{ text: 'ok' }]);
    return request;
  }

  const bad = (id: string, tag: string): Call => ({ id, name: 'no_such_tool', input: { tag } });
  const lastText = (message: WireMessage) => JSON.stringify(message.content);

  it('replays every round with its thinking, a folder note and a cleared result as the last request sent them', async () => {
    const big = join(root, 'big.txt');
    await writeFile(big, `${Array.from({ length: 2000 }, (_unused, i) => `line ${i} ${'x'.repeat(40)}`).join('\n')}\n`);
    const extra = await realpath(await mkdtemp(join(tmpdir(), 'b4m-replay-extra-')));
    const read: Call = { id: 'read_1', name: 'file_read', input: { path: big } };
    const { id } = await service.createSession();

    const requests = await scripted(id, 'dig in', [
      {
        text: 'Reading.',
        thinking: [thinkingBlock('one')],
        calls: [read],
        before: () => {
          roots = [root, extra];
          service.refreshAccessScopes();
        },
      },
      { thinking: [thinkingBlock('two')], calls: [{ ...read, id: 'read_2' }] },
      { text: 'Hmm.', thinking: [thinkingBlock('three')], calls: [bad('bad_3', 'a')] },
      { thinking: [thinkingBlock('four')], calls: [bad('bad_4', 'b'), bad('bad_5', 'c')] },
      { text: 'All done.' },
    ]);
    const lastRequest = requests[4];
    const wire = JSON.stringify(lastRequest.messages);
    // The note rode the first result, which the stale clear then replaced whole.
    expect(JSON.stringify(requests[1].messages)).toContain('now shared');
    expect(wire).not.toContain('now shared');
    expect(wire).toContain('[stale:');
    // The next turn's system prompt lists the folders as they are then; keep it as this turn started.
    roots = [root];
    for (const name of ['one', 'two', 'three', 'four']) expect(wire).toContain(`"thinking":"${name}"`);

    const next = await nextTurn(id, 'thanks');
    expect(plain(next).slice(0, lastRequest.messages.length)).toEqual(plain(lastRequest));
    expect(plain(next).slice(lastRequest.messages.length)).toEqual([
      { role: 'assistant', content: 'All done.' },
      { role: 'user', content: 'thanks' },
    ]);
  });

  it('replays the stale-plan nudge where the last request sent it', async () => {
    const { id } = await service.createSession();
    const todo: Call = {
      id: 'todo_1',
      name: 'todo_write',
      input: { todos: [{ content: 'Check things', status: 'in_progress' }] },
    };
    const requests = await scripted(id, 'plan it', [
      { thinking: [thinkingBlock('plan')], calls: [todo] },
      { thinking: [thinkingBlock('r2')], calls: [bad('bad_1', 'a')] },
      { thinking: [thinkingBlock('r3')], calls: [bad('bad_2', 'b')] },
      { thinking: [thinkingBlock('r4')], calls: [bad('bad_3', 'c'), bad('bad_4', 'd')] },
      { text: 'Finished.' },
    ]);
    const lastRequest = requests[4];
    const results = lastRequest.messages.at(-1) as WireMessage;
    const nudged = (results.content as { content: string }[]).map(block => block.content);
    expect(nudged[0]).not.toContain('has not changed in');
    expect(nudged[1]).toContain('has not changed in 3 rounds');

    const next = await nextTurn(id, 'thanks');
    expect(plain(next).slice(0, lastRequest.messages.length)).toEqual(plain(lastRequest));
    expect(plain(next).slice(lastRequest.messages.length)[0]).toEqual({ role: 'assistant', content: 'Finished.' });
  });

  it('keeps what each round sent out of what the renderer is sent', async () => {
    const { id } = await service.createSession();
    await scripted(id, 'dig in', [{ thinking: [thinkingBlock('one')], calls: [bad('bad_1', 'a')] }, { text: 'Done.' }]);
    const stored = (await store.get(id))?.messages.find(message => message.rounds);
    expect(stored?.rounds?.every(round => round.sent)).toBe(true);

    const done = events.find(event => event.type === 'done');
    expect(done?.type === 'done' && done.rounds?.some(round => 'sent' in round)).toBe(false);
    const shown = sessionForRenderer(await service.getSession(id))?.messages.find(message => message.rounds);
    expect(shown?.rounds?.map(round => round.text)).toEqual(stored?.rounds?.map(round => round.text));
    expect(shown?.rounds?.some(round => 'sent' in round)).toBe(false);
  });

  async function arrivalTurn() {
    const { id } = await service.createSession();
    const first = post.mock.calls.length;
    await service.send(id, 'build it');
    await waitForRequest(first + 1);
    expect(await service.send(id, 'what are you building?')).toMatchObject({ ok: true, queued: true });
    answer(first, { text: 'Looking.', thinking: [thinkingBlock('one')], calls: [bad('bad_1', 'a')] });
    await waitForRequest(first + 2);
    answer(first + 1, { thinking: [thinkingBlock('two')], calls: [bad('bad_2', 'b')] });
    await waitForRequest(first + 3);
    answer(first + 2, { text: 'A docker image.' });
    await vi.waitUntil(() => doneCount() === 2, { timeout: 5000, interval: 5 });
    const lastRequest = body(first + 2);
    expect(lastText(lastRequest.messages.at(-3) as WireMessage)).toContain('what are you building?');
    return { lastRequest, next: await nextTurn(id, 'thanks') };
  }

  // The arrival is a one-block array live (arrivalWire) but a plain string when rebuilt (toCompletionMessages).
  it('replays a message that arrived mid-turn between the rounds it split, up to its content shape', async () => {
    const { lastRequest, next } = await arrivalTurn();
    const asBlocks = ({ role, content }: WireMessage) => ({
      role,
      content: typeof content === 'string' && role === 'user' ? [{ type: 'text', text: content }] : content,
    });
    expect(plain(next).slice(0, lastRequest.messages.length).map(asBlocks)).toEqual(plain(lastRequest).map(asBlocks));
    expect(plain(next).slice(lastRequest.messages.length)).toEqual([
      { role: 'assistant', content: 'A docker image.' },
      { role: 'user', content: 'thanks' },
    ]);
  });

  it('replays a turn stored before rounds recorded what they sent in the legacy shape', async () => {
    const { id } = await service.createSession();
    const user: ChatMessage = { id: 'u1', role: 'user', content: 'read it', createdAt: new Date().toISOString() };
    const assistant: ChatMessage = {
      id: 'a1',
      role: 'assistant',
      content: 'Reading.\n\nIt says z.',
      createdAt: new Date().toISOString(),
      thinking: [thinkingBlock('last')],
      toolCalls: [
        { id: 'call_1', name: 'file_read', input: { path: join(root, 'tiny.txt') }, status: 'done', preview: '1\tz' },
      ],
      rounds: [
        { text: 'Reading.', toolCallIds: ['call_1'] },
        { text: 'It says z.', toolCallIds: [] },
      ],
    };
    await store.appendMessage(id, user);
    await store.appendMessage(id, assistant);

    const next = await nextTurn(id, 'thanks');
    const [system, ...rest] = plain(next);
    expect(system.role).toBe('system');
    expect(rest.slice(0, 4)).toEqual([
      { role: 'user', content: 'read it' },
      {
        role: 'assistant',
        content: [
          thinkingBlock('last'),
          { type: 'text', text: 'Reading.\n\nIt says z.' },
          { type: 'tool_use', id: 'call_1', name: 'file_read', input: { path: join(root, 'tiny.txt') } },
        ],
      },
      { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'call_1', content: '1\tz' }] },
      { role: 'user', content: 'thanks' },
    ]);
  });

  describe('after the session switches provider', () => {
    async function turnOnAnthropic() {
      const { id } = await service.createSession();
      const requests = await scripted(id, 'dig in', [
        { text: 'Reading.', thinking: [thinkingBlock('one')], calls: [bad('bad_1', 'a')] },
        { thinking: [thinkingBlock('two')], calls: [bad('bad_2', 'b')] },
        { text: 'Done.' },
      ]);
      return { id, lastRequest: requests[2] };
    }

    it('sends the same blocks on the new provider and none of the cache markers', async () => {
      const { id, lastRequest } = await turnOnAnthropic();
      expect(lastRequest.messages.some(message => message.cache)).toBe(true);
      backends[ChatModels.CLAUDE_5_SONNET] = 'openai';
      await service.setSessionModel(id, ChatModels.CLAUDE_5_SONNET);

      const next = await nextTurn(id, 'thanks');
      expect(next.messages.some(message => message.cache)).toBe(false);
      const sent = next.messages.slice(1);
      // The client does not filter reasoning blocks by provider; the server adapter decides what to do with them.
      expect(sent.flatMap(thinkingOf)).toEqual([thinkingBlock('one'), thinkingBlock('two')]);
      expect(plain(next).slice(1, lastRequest.messages.length)).toEqual(plain(lastRequest).slice(1));
    });

    it("replays only the last round's reasoning in the legacy shape", async () => {
      const { id } = await turnOnAnthropic();
      backends[ChatModels.CLAUDE_5_SONNET] = 'openai';
      await service.setSessionModel(id, ChatModels.CLAUDE_5_SONNET);
      const stored = await store.get(id);
      const assistant = stored?.messages.find(message => message.toolCalls?.length);
      expect(assistant?.thinking).toEqual([thinkingBlock('two')]);

      await store.updateMessage(id, assistant!.id, {
        rounds: assistant!.rounds?.map(({ sent: _sent, ...round }) => round),
      });
      const legacy = await nextTurn(id, 'thanks');
      // Legacy carried only the last tool round's blocks, all in one assistant message.
      expect(legacy.messages.flatMap(thinkingOf)).toEqual([thinkingBlock('two')]);
    });
  });
});
