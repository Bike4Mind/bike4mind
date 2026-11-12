import { mkdtemp } from 'node:fs/promises';
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

function frame(payload: unknown): string {
  return `data: ${typeof payload === 'string' ? payload : JSON.stringify(payload)}\n\n`;
}

function toolTurn(id: string, input: Record<string, unknown>): string {
  return frame({ type: 'tool_use', tools: [{ id, name: 'loop', arguments: JSON.stringify(input) }] });
}

const DONE = `${frame({ type: 'content', text: 'done', stopReason: 'end_turn' })}${frame('[DONE]')}`;

describe('ChatService loop tool', () => {
  let store: SessionStore;
  let service: ChatService;
  let approvals: ApprovalGate;
  let events: ChatStreamEvent[];
  let streams: PassThrough[];
  let id: string;

  const call = (callId: string, status: ChatToolCall['status']) =>
    events
      .map(event => (event.type === 'tool-start' || event.type === 'tool-end' ? event.call : null))
      .find(entry => entry?.id === callId && entry.status === status);

  const settled = (callId: string) =>
    vi.waitUntil(
      () => events.map(event => (event.type === 'tool-end' ? event.call : null)).find(entry => entry?.id === callId),
      { timeout: 5000, interval: 5 }
    );

  async function startTurn(mode: ChatApprovalMode): Promise<void> {
    await service.setApprovalMode(id, mode);
    await service.send(id, 'go');
    await vi.waitUntil(() => streams.length === 1, { timeout: 5000, interval: 5 });
  }

  beforeEach(async () => {
    store = new SessionStore(await mkdtemp(join(tmpdir(), 'b4m-loop-tool-')), 'test-model');
    approvals = new ApprovalGate();
    const testEvents: ChatStreamEvent[] = [];
    const testStreams: PassThrough[] = [];
    events = testEvents;
    streams = testStreams;
    const post = vi.fn(async () => {
      const stream = new PassThrough();
      testStreams.push(stream);
      return { data: stream, status: 200 };
    });
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
      emit: event => testEvents.push(event),
    });
    id = (await service.createSession()).id;
    await store.rename(id, 'Loop tool test');
  });

  afterEach(() => {
    service.dispose();
    for (const stream of streams) stream.end();
    vi.restoreAllMocks();
  });

  it.each(['ask', 'auto'] as const)(
    'asks before starting a loop in %s mode, showing prompt, interval and end',
    async mode => {
      await startTurn(mode);
      const until = new Date(Date.now() + 3_600_000).toISOString();
      streams[0].write(toolTurn('c1', { action: 'start', prompt: 'tell me the time', interval: '1m', until }));
      streams[0].write(frame('[DONE]'));
      const asked = await vi.waitUntil(() => call('c1', 'awaiting-approval'), { timeout: 5000, interval: 5 });
      expect(asked.approvalDetail).toContain('Prompt: tell me the time');
      expect(asked.approvalDetail).toContain('Interval: 1m after each run completes');
      expect(asked.approvalDetail).toMatch(/Until: \S/);
      expect(asked.approvalOnceOnly).toBe(true);
      expect(service.getLoop(id)).toBeNull();

      approvals.resolve(asked.approvalId as string, { decision: 'once' });
      expect((await settled('c1')).status).toBe('done');
      expect(service.getLoop(id)).toMatchObject({
        prompt: 'tell me the time',
        intervalMs: 60_000,
        until: Date.parse(until),
      });
    }
  );

  it('starts unasked in full mode, through the same path as /loop', async () => {
    await startTurn('full');
    streams[0].write(toolTurn('c1', { action: 'start', prompt: 'check the build' }));
    streams[0].write(frame('[DONE]'));
    const done = await settled('c1');
    expect(done.status).toBe('done');
    expect(call('c1', 'awaiting-approval')).toBeUndefined();
    expect(done.preview).toContain('Loop started');
    expect(service.getLoop(id)).toMatchObject({ prompt: 'check the build', intervalMs: null, phase: 'waiting' });
    expect(await service.loopCommand(id, 'list')).toMatchObject({ ok: true, state: { prompt: 'check the build' } });

    await vi.waitUntil(() => streams.length === 2, { timeout: 5000, interval: 5 });
    streams[1].write(DONE);
    await vi.waitUntil(() => streams.length === 3, { timeout: 5000, interval: 5 });
    const messages = (await store.get(id))?.messages.filter(message => message.role === 'user');
    expect(messages?.at(-1)).toMatchObject({ content: 'check the build' });
    await service.loopCommand(id, 'stop');
    expect(service.getLoop(id)).toBeNull();
  });

  it('lists and stops without asking, even in ask mode', async () => {
    await startTurn('ask');
    await service.loopCommand(id, '1h check');
    streams[0].write(toolTurn('c1', { action: 'list' }));
    streams[0].write(toolTurn('c2', { action: 'stop' }));
    streams[0].write(frame('[DONE]'));
    expect((await settled('c1')).preview).toContain('Prompt: check');
    expect((await settled('c2')).preview).toContain('Loop stopped');
    expect(call('c1', 'awaiting-approval') ?? call('c2', 'awaiting-approval')).toBeUndefined();
    expect(service.getLoop(id)).toBeNull();
  });

  it('refuses an end time in the past without a card', async () => {
    await startTurn('ask');
    const until = new Date(Date.now() - 60_000).toISOString();
    streams[0].write(toolTurn('c1', { action: 'start', prompt: 'check', until }));
    streams[0].write(frame('[DONE]'));
    const refused = await settled('c1');
    expect(refused.status).toBe('error');
    expect(refused.error).toContain('already passed');
    expect(call('c1', 'awaiting-approval')).toBeUndefined();
    expect(service.getLoop(id)).toBeNull();
  });

  it('refuses to start a loop from inside a loop run', async () => {
    await service.setApprovalMode(id, 'full');
    await service.loopCommand(id, '1h check');
    await vi.waitUntil(() => streams.length === 1, { timeout: 5000, interval: 5 });
    expect(service.getLoop(id)?.phase).toBe('running');
    streams[0].write(toolTurn('c1', { action: 'start', prompt: 'nested', interval: '30s' }));
    streams[0].write(frame('[DONE]'));
    const refused = await settled('c1');
    expect(refused.status).toBe('error');
    expect(refused.error).toContain('cannot start another loop');
    expect(service.getLoop(id)?.prompt).toBe('check');
  });
});
