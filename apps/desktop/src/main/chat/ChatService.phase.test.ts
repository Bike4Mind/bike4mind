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

describe('ChatService model phase', () => {
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

  beforeEach(() => {
    streams = [];
    events = [];
    debug = vi.fn<(message: string) => void>();
  });

  const phases = () => events.flatMap(event => (event.type === 'phase' ? [event.phase] : []));

  it('reports each phase of a round once, in the order the stream shows it', async () => {
    const service = await serviceWith(false);
    await runTurn(service, [
      { type: 'content', text: '<think>' },
      { type: 'content', text: '</think>' },
      { type: 'content', text: 'Updating ' },
      { type: 'content', text: 'the file.' },
      { type: 'content', text: '', toolStarted: { name: 'file_write', id: 'c1' } },
    ]);

    expect(phases()).toEqual([
      { kind: 'waiting' },
      { kind: 'thinking' },
      { kind: 'responding' },
      { kind: 'writing-tool', name: 'file_write' },
    ]);
  });

  it('announces a call to any tool, not only the ones that write files', async () => {
    const service = await serviceWith(false);
    await runTurn(service, [{ type: 'content', text: '', toolStarted: { name: 'grep_search' } }]);

    expect(phases()).toContainEqual({ kind: 'writing-tool', name: 'grep_search' });
  });
});
