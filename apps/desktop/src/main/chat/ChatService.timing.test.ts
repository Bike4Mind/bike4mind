import { mkdtemp, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import type { AuthenticatedApiClient } from '@bike4mind/client-auth';
import type { ChatStreamEvent } from '@shared/chat';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ChatService } from './ChatService';
import type { ModelCatalog } from './ModelCatalog';
import { SessionStore } from './SessionStore';
import type { AccessStore } from './tools/AccessStore';

function frame(payload: unknown): string {
  return `data: ${typeof payload === 'string' ? payload : JSON.stringify(payload)}\n\n`;
}

describe('ChatService round timing', () => {
  let streams: PassThrough[];
  let events: ChatStreamEvent[];
  let debug: ReturnType<typeof vi.fn<(message: string) => void>>;

  async function serviceWith(turnTiming: boolean): Promise<ChatService> {
    const root = await realpath(await mkdtemp(join(tmpdir(), 'b4m-timing-')));
    const post = vi.fn().mockImplementation(() => {
      const stream = new PassThrough();
      streams.push(stream);
      return Promise.resolve({ data: stream, status: 200 });
    });
    return new ChatService({
      store: new SessionStore(await mkdtemp(join(tmpdir(), 'b4m-timing-sessions-')), 'test-model'),
      models: {
        list: async () => ({ models: [{ id: 'test-model', name: 'Test', backend: 'openai' }] }),
        cached: () => [],
      } as unknown as ModelCatalog,
      access: { list: async () => [root] } as unknown as AccessStore,
      logger: { debug, warn: vi.fn() },
      turnTiming,
      getApiClient: () =>
        ({
          get: vi.fn().mockResolvedValue({}),
          getAxiosInstance: () => ({ post }),
        }) as unknown as AuthenticatedApiClient,
      getEnvironmentUrl: () => 'http://localhost:3000',
      emit: event => events.push(event),
    });
  }

  async function runTurn(service: ChatService, frames: unknown[]): Promise<void> {
    const { id } = await service.createSession();
    await service.send(id, 'go');
    await vi.waitUntil(() => streams.length === 1, { timeout: 3000, interval: 5 });
    for (const payload of frames) streams[0].write(frame(payload));
    streams[0].write(frame('[DONE]'));
    await vi.waitUntil(() => events.some(event => event.type === 'done'), { timeout: 3000, interval: 5 });
  }

  const timingLines = () =>
    debug.mock.calls
      .map(([line]) => line)
      .filter(line => line.startsWith('CHAT_TIMING '))
      .map(line => JSON.parse(line.slice('CHAT_TIMING '.length)) as Record<string, unknown>);

  beforeEach(() => {
    streams = [];
    events = [];
    debug = vi.fn<(message: string) => void>();
  });

  it('records an empty thinking block as markers, not reasoning', async () => {
    const service = await serviceWith(true);
    await runTurn(service, [
      { type: 'meta', requestId: 'r1' },
      { type: 'content', text: '<think>' },
      { type: 'content', text: '</think>' },
      { type: 'content', text: 'hello' },
    ]);

    const [round] = timingLines();
    expect(round).toMatchObject({ model: 'test-model', round: 0, frames: 4 });
    expect(round.firstMetaMs).toEqual(expect.any(Number));
    expect(round.firstMarkerMs).toEqual(expect.any(Number));
    expect(round.firstTextMs).toEqual(expect.any(Number));
    expect(round.firstReasoningMs).toBeUndefined();
    expect(round.beforeSendMs).toEqual(expect.any(Number));
  });

  it('counts text the think filter holds back as a possible marker as text', async () => {
    const service = await serviceWith(true);
    await runTurn(service, [
      { type: 'content', text: '<' },
      { type: 'content', text: 'b>bold' },
    ]);

    const [round] = timingLines();
    expect(round.firstMarkerMs).toBeUndefined();
    expect(round).toMatchObject({ frames: 2, firstTextMs: expect.any(Number) });
  });

  it('logs nothing when timing is off', async () => {
    const service = await serviceWith(false);
    await runTurn(service, [{ type: 'content', text: 'hello' }]);

    expect(timingLines()).toEqual([]);
  });
});
