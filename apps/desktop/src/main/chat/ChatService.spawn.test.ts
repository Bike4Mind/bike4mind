import { mkdtemp, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import type { AuthenticatedApiClient } from '@bike4mind/client-auth';
import type { ChatSessionSummary, ChatStreamEvent } from '@shared/chat';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ChatService } from './ChatService';
import type { ModelMemory } from './ModelPreference';
import { SessionStore } from './SessionStore';
import type { AccessStore } from './tools/AccessStore';

function frame(payload: unknown): string {
  return `data: ${typeof payload === 'string' ? payload : JSON.stringify(payload)}\n\n`;
}

/**
 * The spawn caps, which are the one part of this feature that has to hold against a model
 * actively working against it.
 *
 * Every test here drives a model that asks to spawn on every single turn, because that is the
 * failure being guarded: one session spawning sessions, each of which spawns more, is a fork
 * bomb that spends the user real money on a live account. Neither cap is sufficient alone - the
 * depth cap stops a chain and the concurrency cap stops a fan - so both are exercised, and the
 * concurrency one is exercised against PARALLEL spawns specifically, since a turn asking for
 * four at once is where a check made before an await would let all four through.
 *
 * No approval gate is wired in deliberately. The gate would stop the loop by itself, and a test
 * that passes because the user was asked proves nothing about the caps underneath it.
 */
describe('ChatService spawn caps', () => {
  let store: SessionStore;
  let service: ChatService;
  let events: ChatStreamEvent[];
  let post: ReturnType<typeof vi.fn>;
  let streams: PassThrough[];
  let project: string;
  let modelMemory: ModelMemory & { record: ReturnType<typeof vi.fn<ModelMemory['record']>> };

  beforeEach(async () => {
    project = await realpath(await mkdtemp(join(tmpdir(), 'b4m-spawn-')));
    store = new SessionStore(await mkdtemp(join(tmpdir(), 'b4m-spawn-sessions-')), 'test-model');
    events = [];
    streams = [];
    post = vi.fn().mockImplementation(() => {
      const stream = new PassThrough();
      streams.push(stream);
      return Promise.resolve({ data: stream, status: 200 });
    });

    modelMemory = { read: async () => null, record: vi.fn<ModelMemory['record']>(async () => {}) };

    service = new ChatService({
      store,
      access: { list: async () => [] } as unknown as AccessStore,
      modelMemory,
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

  afterEach(() => {
    // Children are left mid-reply on purpose, which is what keeps them counting against the
    // concurrency cap; they have to be released or the run does not end.
    service.dispose();
    for (const stream of streams) stream.end();
  });

  async function codeSession(): Promise<ChatSessionSummary> {
    const created = await service.createCodeSession({ directory: project, branch: '', workspace: false });
    if (!created.ok) throw new Error(created.error);
    return created.session;
  }

  /** The index of the next stream, once the POST that opened it has been made. */
  function awaitStream(index: number): Promise<unknown> {
    return vi.waitUntil(() => streams.length > index, { timeout: 5000, interval: 5 });
  }

  /** Ask for `count` spawns in one assistant turn, the way a model asks for parallel tools. */
  function requestSpawns(stream: PassThrough, count: number, prefix: string): void {
    stream.write(
      frame({
        type: 'tool_use',
        tools: Array.from({ length: count }, (_unused, index) => ({
          id: `${prefix}-${index}`,
          name: 'session_spawn',
          arguments: JSON.stringify({ prompt: `task ${prefix}-${index}`, title: `${prefix}-${index}` }),
        })),
      })
    );
    stream.write(frame('[DONE]'));
  }

  /**
   * The newest open stream belonging to the session whose first prompt was `prompt`.
   *
   * Sessions are told apart by their opening user message rather than by id, because that is
   * what the request body carries: this endpoint is stateless, so every turn resends the whole
   * history and index 1 is always that first prompt (index 0 being the access preamble).
   */
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

  /** Every settled call of a given tool, in the order they finished. */
  function settledCalls(name: string) {
    return events
      .filter(event => event.type === 'tool-end')
      .map(event => (event.type === 'tool-end' ? event.call : null))
      .filter(call => call?.name === name);
  }

  it('refuses the fourth parallel spawn rather than letting a turn fan out without limit', async () => {
    const parent = await codeSession();
    await service.send(parent.id, 'do four things at once');
    await awaitStream(0);

    // Four at once, so the cap is tested against the parallel path: runTools runs a turn's
    // calls with Promise.all, and a check that read the count before awaiting the create would
    // let every one of them through.
    requestSpawns(streams[0], 4, 'fan');

    await vi.waitUntil(() => settledCalls('session_spawn').length === 4, { timeout: 5000, interval: 5 });
    const calls = settledCalls('session_spawn');

    const started = calls.filter(call => call?.status === 'done');
    const refused = calls.filter(call => call?.status === 'error');
    expect(started).toHaveLength(3);
    expect(refused).toHaveLength(1);
    expect(refused[0]?.error).toMatch(/already running, which is the limit/);

    const sessions = await store.list();
    expect(sessions.filter(session => session.origin)).toHaveLength(3);
  });

  it('frees a concurrency slot when a spawned session finishes, and not before', async () => {
    const parent = await codeSession();
    await service.send(parent.id, 'fill the slots');
    await awaitStream(0);
    requestSpawns(streams[0], 3, 'fill');

    await vi.waitUntil(() => settledCalls('session_spawn').length === 3, { timeout: 5000, interval: 5 });
    expect(settledCalls('session_spawn').every(call => call?.status === 'done')).toBe(true);

    // A fourth while all three are still replying is refused: the cap counts runs in flight.
    requestSpawns(await awaitStreamOf('fill the slots'), 1, 'over');
    await vi.waitUntil(() => settledCalls('session_spawn').length === 4, { timeout: 5000, interval: 5 });
    expect(settledCalls('session_spawn')[3]?.status).toBe('error');

    // Let one child finish and the slot comes back, so the cap is a live count rather than a
    // lifetime quota that a long-running session could exhaust permanently.
    const child = await awaitStreamOf('task fill-0');
    child.write(frame({ type: 'content', text: 'done with it' }));
    child.write(frame('[DONE]'));
    await vi.waitUntil(() => events.some(event => event.type === 'done' && event.content === 'done with it'), {
      timeout: 5000,
      interval: 5,
    });

    requestSpawns(await awaitStreamOf('fill the slots'), 1, 'again');
    await vi.waitUntil(() => settledCalls('session_spawn').length === 5, { timeout: 5000, interval: 5 });
    expect(settledCalls('session_spawn')[4]?.status).toBe('done');
  });

  it('refuses to nest deeper than the depth cap, so a chain of spawns terminates', async () => {
    const parent = await codeSession();
    await service.send(parent.id, 'start a chain');
    await awaitStream(0);
    requestSpawns(streams[0], 1, 'chain');

    requestSpawns(await awaitStreamOf('task chain-0'), 1, 'chain-2');

    // The grandchild, at depth 2, asks for one more.
    await vi.waitUntil(() => settledCalls('session_spawn').length === 2, { timeout: 5000, interval: 5 });
    const grandchild = (await store.list()).find(session => session.origin?.depth === 2);
    expect(grandchild).toBeDefined();

    requestSpawns(await awaitStreamOf('task chain-2-0'), 1, 'chain-3');

    await vi.waitUntil(() => settledCalls('session_spawn').length === 3, { timeout: 5000, interval: 5 });
    const deepest = settledCalls('session_spawn')[2];
    expect(deepest?.status).toBe('error');
    expect(deepest?.error).toMatch(/only be nested 2 deep/);

    // Nothing beyond depth 2 ever reached disk, which is the property that matters: the chain
    // is bounded by what was created, not merely by what was reported back.
    const depths = (await store.list()).map(session => session.origin?.depth ?? 0);
    expect(Math.max(...depths)).toBe(2);
  });

  it("starts a spawned session on its parent's model without recording it as the user's pick", async () => {
    const parent = await codeSession();
    await store.setModel(parent.id, 'parent-model');
    await service.send(parent.id, 'go');
    await awaitStream(0);
    requestSpawns(streams[0], 1, 'model');

    await vi.waitUntil(() => settledCalls('session_spawn').length === 1, { timeout: 5000, interval: 5 });

    const child = (await store.list()).find(session => session.origin);
    expect(child?.model).toBe('parent-model');
    expect(modelMemory.record).not.toHaveBeenCalled();
  });

  it('gives a spawned session exactly its parent grants, with no way to name others', async () => {
    const parent = await codeSession();
    await service.send(parent.id, 'go');
    await awaitStream(0);
    requestSpawns(streams[0], 1, 'grants');

    await vi.waitUntil(() => settledCalls('session_spawn').length === 1, { timeout: 5000, interval: 5 });

    const parentSession = await store.get(parent.id);
    const child = (await store.list()).find(session => session.origin);
    expect(child?.project).toEqual(parentSession?.project);
    expect(child?.origin).toMatchObject({ parentSessionId: parent.id, depth: 1, seedPrompt: 'task grants-0' });

    // The schema is the enforcement point for "cannot widen": there is no argument through
    // which a directory, a branch or a worktree could be asked for in the first place.
    const declared = post.mock.calls[0][1].options.tools as { toolSchema: { name: string; parameters: object } }[];
    const spawnSchema = declared.find(entry => entry.toolSchema.name === 'session_spawn');
    expect(Object.keys((spawnSchema?.toolSchema.parameters as { properties: object }).properties)).toEqual([
      'prompt',
      'title',
    ]);
  });
});
