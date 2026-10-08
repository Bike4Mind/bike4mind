import { mkdtemp, realpath, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import type { AuthenticatedApiClient } from '@bike4mind/client-auth';
import type { ChatStreamEvent } from '@shared/chat';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ChatService } from './ChatService';
import { SessionStore } from './SessionStore';
import type { AccessStore } from './tools/AccessStore';

function frame(payload: unknown): string {
  return `data: ${typeof payload === 'string' ? payload : JSON.stringify(payload)}\n\n`;
}

/**
 * The provider's prompt cache matches on a byte prefix, so what matters is not what the history
 * means but whether each request starts with exactly the previous one's bytes.
 */
describe('ChatService request prefix stability', () => {
  let service: ChatService;
  let events: ChatStreamEvent[];
  let streams: PassThrough[];
  let sent: unknown[][];
  let root: string;

  beforeEach(async () => {
    root = await realpath(await mkdtemp(join(tmpdir(), 'b4m-prefix-')));
    await writeFile(join(root, 'a.ts'), 'export const a = 1;\n', 'utf8');
    const store = new SessionStore(await mkdtemp(join(tmpdir(), 'b4m-prefix-sessions-')), 'test-model');
    events = [];
    streams = [];
    sent = [];
    const post = vi.fn().mockImplementation((_url: string, body: { messages: unknown[] }) => {
      sent.push(JSON.parse(JSON.stringify(body.messages)) as unknown[]);
      const stream = new PassThrough();
      streams.push(stream);
      return Promise.resolve({ data: stream, status: 200 });
    });
    service = new ChatService({
      store,
      access: { list: async () => [root] } as unknown as AccessStore,
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

  async function reply(index: number, ...payloads: unknown[]): Promise<void> {
    await vi.waitUntil(() => streams.length === index + 1, { timeout: 3000, interval: 5 });
    for (const payload of payloads) streams[index].write(frame(payload));
    streams[index].write(frame('[DONE]'));
  }

  const tool = (id: string, pattern: string) => ({
    type: 'tool_use',
    tools: [{ id, name: 'glob_files', arguments: JSON.stringify({ pattern }) }],
  });

  function expectExtends(next: unknown[], previous: unknown[]): void {
    expect(next.length).toBeGreaterThanOrEqual(previous.length);
    expect(JSON.stringify(next.slice(0, previous.length))).toBe(JSON.stringify(previous));
  }

  it('sends the next turn as a byte-prefix extension of the last round of the previous turn', async () => {
    const { id } = await service.createSession();
    await service.send(id, 'look around');

    // Raw model text carries trailing whitespace, as streamed text does.
    await reply(0, { type: 'content', text: 'Checking the layout.\n\n' }, tool('c1', '*.ts'));
    await reply(1, tool('c2', '*.md'));
    await reply(2, { type: 'content', text: 'Now the config.  ' }, tool('c3', '*.json'));
    await reply(3, { type: 'content', text: 'Nothing odd.\n' });
    await vi.waitUntil(() => events.some(event => event.type === 'done'), { timeout: 3000, interval: 5 });

    // Within a turn: each round extends the one before it.
    expectExtends(sent[1], sent[0]);
    expectExtends(sent[2], sent[1]);
    expectExtends(sent[3], sent[2]);

    await service.send(id, 'and now?');
    await reply(4, { type: 'content', text: 'Still odd.' });

    // Across turns: the first request of the new turn carries the last request of the old one
    // unchanged, then the reply that ended it, then the new user message.
    expectExtends(sent[4], sent[3]);
    expect(sent[4]).toHaveLength(sent[3].length + 2);
  });
});
