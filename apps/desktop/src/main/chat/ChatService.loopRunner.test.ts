import { mkdtemp, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import type { AuthenticatedApiClient } from '@bike4mind/client-auth';
import type { ChatAutomaticOrigin, ChatStreamEvent, ChatToolCall } from '@shared/chat';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ChatService } from './ChatService';
import { LOOP_RUN_HEADER } from './completions';
import { MessageQueue } from './MessageQueue';
import { SessionStore } from './SessionStore';
import type { AccessStore } from './tools/AccessStore';
import { ApprovalGate } from './tools/ApprovalGate';
import { lowerPriority } from './tools/lowPriority';

vi.mock('./tools/lowPriority', () => ({ lowerPriority: vi.fn() }));

function frame(payload: unknown): string {
  return `data: ${typeof payload === 'string' ? payload : JSON.stringify(payload)}\n\n`;
}

function toolTurn(id: string, name: string, input: Record<string, unknown>): string {
  return frame({ type: 'tool_use', tools: [{ id, name, arguments: JSON.stringify(input) }] });
}

const origin: ChatAutomaticOrigin = {
  kind: 'loop-runner',
  loopId: 'loop-1',
  ticketId: 'ticket-1',
  runId: 'run-1',
  summary: 'Fix the docs',
};

describe('ChatService loop runner sessions', () => {
  let store: SessionStore;
  let service: ChatService;
  let events: ChatStreamEvent[];
  let streams: PassThrough[];
  let post: ReturnType<typeof vi.fn>;
  let root: string;
  let unattended: string[];

  const ended = (): ChatToolCall[] => events.flatMap(event => (event.type === 'tool-end' ? [event.call] : []));
  const nextStream = async (count: number) => {
    await vi.waitUntil(() => streams.length === count, { timeout: 5000, interval: 5 });
    return streams[count - 1];
  };

  beforeEach(async () => {
    vi.mocked(lowerPriority).mockClear();
    root = await realpath(await mkdtemp(join(tmpdir(), 'b4m-loop-')));
    store = new SessionStore(await mkdtemp(join(tmpdir(), 'b4m-loop-sessions-')), 'test-model');
    events = [];
    streams = [];
    unattended = [];
    post = vi.fn().mockImplementation(() => {
      const stream = new PassThrough();
      streams.push(stream);
      return Promise.resolve({ data: stream, status: 200 });
    });
    service = new ChatService({
      store,
      queue: new MessageQueue(() => undefined),
      access: { list: async () => [root] } as unknown as AccessStore,
      approvals: new ApprovalGate({
        requested: () => undefined,
        settled: () => undefined,
        unattended: sessionId => unattended.push(sessionId),
      }),
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
    service.dispose();
    for (const stream of streams) stream.end();
  });

  it('tags its completions with the run id, and a normal session does not', async () => {
    const runner = await service.createSession();
    await service.startAutomaticTurn(runner.id, 'work the ticket', origin);
    await nextStream(1);
    expect(post.mock.calls[0][2].headers).toEqual({ [LOOP_RUN_HEADER]: 'run-1' });
    expect(service.loopRunOf(runner.id)).toBe('run-1');
    expect(service.loopRunSessions('run-1')).toEqual([runner.id]);

    const normal = await service.createSession();
    await service.send(normal.id, 'hello');
    await nextStream(2);
    expect(post.mock.calls[1][2].headers).toBeUndefined();
    expect(service.loopRunOf(normal.id)).toBeUndefined();
  });

  it('refuses a shell merge and points at loop_merge_pr', async () => {
    const session = await service.createSession();
    await service.setApprovalMode(session.id, 'auto');
    await service.startAutomaticTurn(session.id, 'work the ticket', origin);
    (await nextStream(1)).write(toolTurn('c1', 'bash_execute', { command: 'gh pr merge 3 --squash', cwd: root }));
    streams[0].write(frame('[DONE]'));
    const denied = await vi.waitUntil(() => ended().find(call => call.status === 'denied'), {
      timeout: 5000,
      interval: 10,
    });
    expect(denied.error).toContain('loop_merge_pr');
  });

  it('denies a card at once instead of waiting, and tells the listener', async () => {
    const session = await service.createSession();
    await service.setApprovalMode(session.id, 'ask');
    await service.startAutomaticTurn(session.id, 'work the ticket', origin);
    (await nextStream(1)).write(toolTurn('c1', 'bash_execute', { command: 'rm -rf build', cwd: root }));
    streams[0].write(frame('[DONE]'));
    const denied = await vi.waitUntil(() => ended().find(call => call.status === 'denied'), {
      timeout: 5000,
      interval: 10,
    });
    expect(denied.approval?.decidedBy).toEqual({ kind: 'system', reason: 'unattended' });
    expect(unattended).toEqual([session.id]);
    // The card was announced first, so a stream observer saw what was being asked.
    expect(events.some(event => event.type === 'tool-start' && event.call.status === 'awaiting-approval')).toBe(true);
  });

  it('starts its shell commands at low priority; a normal session does not', async () => {
    const runner = await service.createSession();
    await service.setApprovalMode(runner.id, 'full');
    await service.startAutomaticTurn(runner.id, 'work the ticket', origin);
    (await nextStream(1)).write(toolTurn('c1', 'bash_execute', { command: 'echo hi', cwd: root }));
    streams[0].write(frame('[DONE]'));
    await vi.waitUntil(() => ended().length === 1, { timeout: 5000, interval: 10 });
    expect(lowerPriority).toHaveBeenCalledTimes(1);

    const normal = await service.createSession();
    await service.setApprovalMode(normal.id, 'full');
    await service.send(normal.id, 'go');
    (await nextStream(3)).write(toolTurn('c2', 'bash_execute', { command: 'echo hi', cwd: root }));
    streams[2].write(frame('[DONE]'));
    await vi.waitUntil(() => ended().length === 2, { timeout: 5000, interval: 10 });
    expect(lowerPriority).toHaveBeenCalledTimes(1);
  });
});
