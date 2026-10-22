import { mkdtemp, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import type { AuthenticatedApiClient } from '@bike4mind/client-auth';
import type { ChatAutomaticOrigin, ChatStreamEvent, ChatToolCall } from '@shared/chat';
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

const origin: ChatAutomaticOrigin = {
  kind: 'auto-fix',
  prUrl: 'https://github.com/example-org/widgets/pull/611',
  prNumber: 611,
  summary: '1 failing check on #611',
};

describe('ChatService automatic turns', () => {
  let store: SessionStore;
  let service: ChatService;
  let events: ChatStreamEvent[];
  let streams: PassThrough[];
  let root: string;

  const ended = (): ChatToolCall[] => events.flatMap(event => (event.type === 'tool-end' ? [event.call] : []));

  beforeEach(async () => {
    root = await realpath(await mkdtemp(join(tmpdir(), 'b4m-autofix-')));
    store = new SessionStore(await mkdtemp(join(tmpdir(), 'b4m-autofix-sessions-')), 'test-model');
    const testEvents: ChatStreamEvent[] = [];
    const testStreams: PassThrough[] = [];
    const post = vi.fn().mockImplementation(() => {
      const stream = new PassThrough();
      testStreams.push(stream);
      return Promise.resolve({ data: stream, status: 200 });
    });
    events = testEvents;
    streams = testStreams;
    service = new ChatService({
      store,
      queue: new MessageQueue(() => undefined),
      access: { list: async () => [root] } as unknown as AccessStore,
      approvals: new ApprovalGate(),
      logger: { debug: vi.fn(), warn: vi.fn() },
      getApiClient: () =>
        ({
          get: vi.fn().mockResolvedValue({}),
          getAxiosInstance: () => ({ post }),
        }) as unknown as AuthenticatedApiClient,
      getEnvironmentUrl: () => 'http://localhost:3000',
      emit: event => testEvents.push(event),
    });
  });

  afterEach(() => {
    service.dispose();
    for (const stream of streams) stream.end();
  });

  it('marks the turn as started by auto-fix, not by the user', async () => {
    const session = await service.createSession();
    expect(await service.startAutomaticTurn(session.id, 'fix the build', origin)).toEqual({ ok: true });
    await vi.waitUntil(() => streams.length === 1, { timeout: 5000, interval: 5 });

    const messages = (await store.get(session.id))?.messages ?? [];
    expect(messages[0]).toMatchObject({ role: 'user', system: true, automatic: origin, content: 'fix the build' });
  });

  it('refuses to start while a turn is running', async () => {
    const session = await service.createSession();
    await service.send(session.id, 'go');
    await vi.waitUntil(() => streams.length === 1, { timeout: 5000, interval: 5 });
    expect(await service.startAutomaticTurn(session.id, 'fix the build', origin)).toMatchObject({
      ok: false,
      busy: true,
    });
  });

  it('refuses to start while a send is still being accepted', async () => {
    const session = await service.createSession();
    const typed = service.send(session.id, 'mine');
    expect(await service.startAutomaticTurn(session.id, 'fix the build', origin)).toMatchObject({
      ok: false,
      busy: true,
    });
    await typed;
  });

  it('denies a force-push inside an auto-fix turn', async () => {
    const session = await service.createSession();
    await service.setApprovalMode(session.id, 'auto');
    await service.startAutomaticTurn(session.id, 'fix the build', origin);
    await vi.waitUntil(() => streams.length === 1, { timeout: 5000, interval: 5 });
    streams[0].write(toolTurn('c1', 'bash_execute', { command: 'git push --force', cwd: root }));
    streams[0].write(frame('[DONE]'));

    const denied = await vi.waitUntil(() => ended().find(call => call.status === 'denied'), {
      timeout: 5000,
      interval: 10,
    });
    expect(denied.error).toContain('may not force-push');
  });
});
