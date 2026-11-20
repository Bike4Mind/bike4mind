import { mkdtemp, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import type { AuthenticatedApiClient } from '@bike4mind/client-auth';
import type { ChatMessage, ChatSessionSummary } from '@shared/chat';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AGENT_WAKES_PAUSED_NOTICE, type AgentWakeLedger, MAX_AGENT_WAKES_PER_PARENT } from './agentWake';
import { ChatService } from './ChatService';
import { MessageQueue } from './MessageQueue';
import { SessionStore } from './SessionStore';
import type { AccessStore } from './tools/AccessStore';

function frame(payload: unknown): string {
  return `data: ${typeof payload === 'string' ? payload : JSON.stringify(payload)}\n\n`;
}

const WAIT = { timeout: 5000, interval: 5 };

/**
 * An Orchestrate parent is woken once its agents have all settled, and only then.
 *
 * The project is a plain folder, so every agent shares it (no worktree to cut) and the tests are
 * about the wake alone. Each test counts the wakes exactly, because the failure being guarded is
 * a loop of automatic turns spending credits nobody typed.
 */
describe('ChatService waking an Orchestrate parent', () => {
  let store: SessionStore;
  let service: ChatService;
  let post: ReturnType<typeof vi.fn>;
  let streams: PassThrough[];
  let project: string;

  beforeEach(async () => {
    project = await realpath(await mkdtemp(join(tmpdir(), 'b4m-wake-')));
    store = new SessionStore(await mkdtemp(join(tmpdir(), 'b4m-wake-sessions-')), 'test-model');
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

  afterEach(() => {
    service.dispose();
    for (const stream of streams) stream.end();
  });

  async function orchestrator(): Promise<ChatSessionSummary> {
    const created = await service.createCodeSession({ directory: project, branch: '', workspace: false });
    if (!created.ok) throw new Error(created.error);
    await service.setSessionOrchestrate(created.session.id, true);
    await store.setApprovalMode(created.session.id, 'auto');
    return created.session;
  }

  /** Index of every stream whose request was for the session whose first prompt was `prompt`. */
  function streamIndexesOf(prompt: string): number[] {
    const found: number[] = [];
    for (let index = 0; index < streams.length; index++) {
      const messages = post.mock.calls[index]?.[1]?.messages as { content: unknown }[] | undefined;
      if (messages?.[1]?.content === prompt) found.push(index);
    }
    return found;
  }

  /** The `count`-th (1-based) stream opened for `prompt`, once it exists. */
  function nthStreamOf(prompt: string, count: number): Promise<PassThrough> {
    return vi.waitUntil(() => {
      const index = streamIndexesOf(prompt)[count - 1];
      return index === undefined ? undefined : streams[index];
    }, WAIT);
  }

  function reply(stream: PassThrough, text: string): void {
    stream.write(frame({ type: 'content', text }));
    stream.write(frame('[DONE]'));
  }

  function callTools(stream: PassThrough, tools: { id: string; name: string; arguments: object }[]): void {
    stream.write(
      frame({
        type: 'tool_use',
        tools: tools.map(tool => ({ ...tool, arguments: JSON.stringify(tool.arguments) })),
      })
    );
    stream.write(frame('[DONE]'));
  }

  function spawnTools(prefix: string, count: number) {
    return Array.from({ length: count }, (_unused, index) => ({
      id: `${prefix}-${index}`,
      name: 'session_spawn',
      arguments: { prompt: `task ${prefix}-${index}`, title: `${prefix}-${index}` },
    }));
  }

  async function messagesOf(sessionId: string): Promise<ChatMessage[]> {
    return (await store.get(sessionId))?.messages ?? [];
  }

  async function wakes(sessionId: string): Promise<ChatMessage[]> {
    return (await messagesOf(sessionId)).filter(message => message.automatic?.kind === 'agents-settled');
  }

  async function reports(sessionId: string, title: string): Promise<ChatMessage[]> {
    return (await messagesOf(sessionId)).filter(
      message => message.system && !message.automatic && message.content.includes(`"${title}"`)
    );
  }

  async function childId(title: string): Promise<string> {
    const found = await vi.waitUntil(async () => (await store.list()).find(entry => entry.title === title), WAIT);
    return found.id;
  }

  function idle(sessionId: string): Promise<boolean> {
    return vi.waitUntil(() => !service.isSessionBusy(sessionId), WAIT);
  }

  /** Long enough for a wrongly started wake to have reached the store. */
  function settleTime(): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, 150));
  }

  /** A parent that has started `count` agents and ended its own turn. */
  async function idleParentWithAgents(count: number): Promise<ChatSessionSummary> {
    const parent = await orchestrator();
    await service.send(parent.id, 'go');
    callTools(await nthStreamOf('go', 1), spawnTools('a', count));
    reply(await nthStreamOf('go', 2), 'Started them.');
    await idle(parent.id);
    return parent;
  }

  it('wakes an idle parent exactly once, when the last of its agents settles', async () => {
    const parent = await idleParentWithAgents(2);

    reply(await nthStreamOf('task a-0', 1), 'did a-0');
    await vi.waitUntil(async () => (await reports(parent.id, 'a-0')).length === 1, WAIT);
    await settleTime();
    expect(await wakes(parent.id)).toHaveLength(0);

    reply(await nthStreamOf('task a-1', 1), 'did a-1');
    const [wake] = await vi.waitUntil(async () => {
      const found = await wakes(parent.id);
      return found.length > 0 ? found : undefined;
    }, WAIT);
    expect(wake.content).toContain('"a-0"');
    expect(wake.content).toContain('Its last reply began: "did a-0"');
    expect(wake.content).toContain('"a-1"');
    expect(wake.automatic).toMatchObject({ kind: 'agents-settled', summary: '2 agents: 2 done' });

    reply(await nthStreamOf('go', 3), 'All done: here is the summary.');
    await idle(parent.id);
    await settleTime();
    expect(await wakes(parent.id)).toHaveLength(1);
    expect(streamIndexesOf('go')).toHaveLength(3);
  });

  it('wakes a parent that was busy when its agents settled once, after its own turn ends', async () => {
    const parent = await orchestrator();
    await service.send(parent.id, 'go');
    callTools(await nthStreamOf('go', 1), spawnTools('a', 2));
    const stillRunning = await nthStreamOf('go', 2);

    reply(await nthStreamOf('task a-0', 1), 'did a-0');
    reply(await nthStreamOf('task a-1', 1), 'did a-1');
    await vi.waitUntil(async () => {
      const children = (await store.list()).filter(entry => entry.origin);
      return children.length === 2 && children.every(entry => !service.isSessionBusy(entry.id));
    }, WAIT);
    await settleTime();
    expect(await wakes(parent.id)).toHaveLength(0);

    reply(stillRunning, 'Started them.');
    await vi.waitUntil(async () => (await wakes(parent.id)).length === 1, WAIT);
    reply(await nthStreamOf('go', 3), 'Summary.');
    await idle(parent.id);
    await settleTime();
    expect(await wakes(parent.id)).toHaveLength(1);
  });

  it('reports an agent re-run by session_send again, and wakes the parent for that round too', async () => {
    const parent = await idleParentWithAgents(1);
    const agentId = await childId('a-0');
    reply(await nthStreamOf('task a-0', 1), 'first pass');
    await vi.waitUntil(async () => (await wakes(parent.id)).length === 1, WAIT);

    // Woken, the parent sends the agent a correction and ends its turn.
    callTools(await nthStreamOf('go', 3), [
      { id: 'redo', name: 'session_send', arguments: { session_id: agentId, message: 'fix the edge case' } },
    ]);
    reply(await nthStreamOf('task a-0', 2), 'second pass');
    reply(await nthStreamOf('go', 4), 'Sent a correction.');

    await vi.waitUntil(async () => (await reports(parent.id, 'a-0')).length === 2, WAIT);
    const [, second] = await vi.waitUntil(async () => {
      const found = await wakes(parent.id);
      return found.length === 2 ? found : undefined;
    }, WAIT);
    expect(second.content).toContain('Its last reply began: "second pass"');
  });

  it('never wakes a parent the user stopped, until they type there again', async () => {
    const parent = await orchestrator();
    await service.send(parent.id, 'go');
    callTools(await nthStreamOf('go', 1), spawnTools('a', 1));
    await nthStreamOf('go', 2);
    service.stop(parent.id);
    await idle(parent.id);

    reply(await nthStreamOf('task a-0', 1), 'did a-0');
    await vi.waitUntil(async () => (await reports(parent.id, 'a-0')).length === 1, WAIT);
    await settleTime();
    expect(await wakes(parent.id)).toHaveLength(0);
    expect(streamIndexesOf('go')).toHaveLength(2);
  });

  it('drops the news the user already answered, so their turn is not followed by a second one', async () => {
    const parent = await idleParentWithAgents(2);
    reply(await nthStreamOf('task a-0', 1), 'did a-0');
    await vi.waitUntil(async () => (await reports(parent.id, 'a-0')).length === 1, WAIT);

    await service.send(parent.id, 'how is it going?');
    reply(await nthStreamOf('go', 3), 'a-0 is done, a-1 is still running.');
    await idle(parent.id);
    await settleTime();
    expect(await wakes(parent.id)).toHaveLength(0);

    reply(await nthStreamOf('task a-1', 1), 'did a-1');
    const [wake] = await vi.waitUntil(async () => {
      const found = await wakes(parent.id);
      return found.length > 0 ? found : undefined;
    }, WAIT);
    expect(wake.content).toContain('"a-1"');
    expect(wake.content).not.toContain('"a-0"');
  });

  it('says in the thread, once, that the cap paused the wakes, and starts no turn', async () => {
    const parent = await idleParentWithAgents(1);
    const ledger = (service as unknown as { agentWakes: AgentWakeLedger }).agentWakes;
    for (let wake = 0; wake < MAX_AGENT_WAKES_PER_PARENT; wake++) {
      ledger.record(parent.id, { sessionId: 'earlier', title: 'earlier', outcome: 'finished', lastReply: null });
      const claim = ledger.claim(parent.id);
      ledger.finish(parent.id, true, claim.ok ? claim.agents : []);
    }

    reply(await nthStreamOf('task a-0', 1), 'did a-0');
    const notices = await vi.waitUntil(async () => {
      const found = (await messagesOf(parent.id)).filter(message => message.content === AGENT_WAKES_PAUSED_NOTICE);
      return found.length > 0 ? found : undefined;
    }, WAIT);
    expect(notices).toHaveLength(1);
    expect(notices[0].system).toBe(true);
    await settleTime();
    expect(await wakes(parent.id)).toHaveLength(0);
    expect(streamIndexesOf('go')).toHaveLength(2);
  });

  it('collects nothing for a parent while Orchestrate is off, to wake it for later', async () => {
    const parent = await idleParentWithAgents(2);
    await service.setSessionOrchestrate(parent.id, false);
    reply(await nthStreamOf('task a-0', 1), 'did a-0');
    await vi.waitUntil(async () => (await reports(parent.id, 'a-0')).length === 1, WAIT);

    await service.setSessionOrchestrate(parent.id, true);
    reply(await nthStreamOf('task a-1', 1), 'did a-1');
    const [wake] = await vi.waitUntil(async () => {
      const found = await wakes(parent.id);
      return found.length > 0 ? found : undefined;
    }, WAIT);
    expect(wake.content).toContain('"a-1"');
    expect(wake.content).not.toContain('"a-0"');
  });

  it('does not wake a parent without Orchestrate', async () => {
    const parent = await idleParentWithAgents(1);
    await service.setSessionOrchestrate(parent.id, false);

    reply(await nthStreamOf('task a-0', 1), 'did a-0');
    await vi.waitUntil(async () => (await reports(parent.id, 'a-0')).length === 1, WAIT);
    await settleTime();
    expect(await wakes(parent.id)).toHaveLength(0);
  });
});
