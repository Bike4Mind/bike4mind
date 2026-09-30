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

interface WireBlock {
  type?: string;
  tool_use_id?: string;
  content?: unknown;
}

interface WireMessage {
  role: string;
  content: string | WireBlock[];
}

describe('ChatService stale tool results', () => {
  let service: ChatService;
  let events: ChatStreamEvent[];
  let streams: PassThrough[];
  /** Each request's messages as serialized when it was sent; the live wire keeps growing after. */
  let sent: string[];
  let root: string;
  let store: SessionStore;

  beforeEach(async () => {
    root = await realpath(await mkdtemp(join(tmpdir(), 'b4m-prune-')));
    // About 25K characters each: two of them pass the batch floor, one does not.
    const body = `${Array.from({ length: 250 }, (_, n) => `line ${n} ${'y'.repeat(90)}`).join('\n')}\n`;
    await writeFile(join(root, 'a.ts'), body, 'utf8');
    await writeFile(join(root, 'b.ts'), body, 'utf8');

    store = new SessionStore(await mkdtemp(join(tmpdir(), 'b4m-prune-sessions-')), 'test-model');
    events = [];
    streams = [];
    sent = [];
    const post = vi.fn().mockImplementation((_url: string, body: { messages: unknown[] }) => {
      sent.push(JSON.stringify(body.messages));
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

  async function reply(index: number, payload: unknown): Promise<void> {
    await vi.waitUntil(() => streams.length === index + 1, { timeout: 3000, interval: 5 });
    streams[index].write(frame(payload));
    streams[index].write(frame('[DONE]'));
  }

  function readBoth(prefix: string, input: Record<string, unknown> = {}): unknown {
    return {
      type: 'tool_use',
      tools: ['a.ts', 'b.ts'].map(name => ({
        id: `${prefix}_${name}`,
        name: 'file_read',
        arguments: JSON.stringify({ path: join(root, name), ...input }),
      })),
    };
  }

  function messages(index: number): WireMessage[] {
    return JSON.parse(sent[index]) as WireMessage[];
  }

  function resultFor(wire: WireMessage[], id: string): unknown {
    for (const message of wire) {
      if (!Array.isArray(message.content)) continue;
      const block = message.content.find(entry => entry.type === 'tool_result' && entry.tool_use_id === id);
      if (block) return block.content;
    }
    return undefined;
  }

  it('keeps the wire prefix stable until a batch fires, then keeps the placeholders on later turns', async () => {
    const { id } = await service.createSession();
    await service.send(id, 'look at both files');

    await reply(0, readBoth('r0'));
    // Same range under different arguments, so the loop does not read it as a repeated round.
    await reply(1, readBoth('r1', { offset: 1, limit: 5000 }));
    await reply(2, { type: 'tool_use', tools: [{ id: 'g2', name: 'glob_files', arguments: '{"pattern":"*"}' }] });
    await reply(3, { type: 'content', text: 'Both files look fine.' });
    await vi.waitUntil(() => events.some(event => event.type === 'done'), { timeout: 3000, interval: 5 });

    // Round 2's request is round 1's plus the new pair: nothing earlier moved.
    const round1 = messages(1);
    const round2 = messages(2);
    expect(round2).toHaveLength(round1.length + 2);
    expect(JSON.stringify(round2.slice(0, round1.length))).toBe(JSON.stringify(round1));

    // Before round 3, the round-0 reads are no longer exempt and together pass the floor.
    const round3 = messages(3);
    const placeholder = `[stale: ${join(root, 'a.ts')} was read here; the file changed or was re-read later. Read it again if you need it.]`;
    expect(resultFor(round3, 'r0_a.ts')).toBe(placeholder);
    expect(resultFor(round3, 'r0_b.ts')).toMatch(/^\[stale: .*b\.ts was read here;/);
    expect(resultFor(round3, 'r1_a.ts')).toMatch(/^ *1\tline 0 /);
    expect(resultFor(round2, 'r0_a.ts')).toMatch(/^ *1\tline 0 /);

    const stored = (await service.getSession(id))?.messages[1];
    const cleared = stored?.toolCalls?.filter(call => call.cleared).map(call => call.id);
    expect(cleared).toEqual(['r0_a.ts', 'r0_b.ts']);
    expect(stored?.toolCalls?.find(call => call.id === 'r0_a.ts')?.preview).toMatch(/^ *1\tline 0 /);

    await service.send(id, 'and now?');
    await reply(4, { type: 'content', text: 'Still fine.' });
    const nextTurn = messages(4);
    expect(resultFor(nextTurn, 'r0_a.ts')).toBe(placeholder);
    expect(resultFor(nextTurn, 'r0_b.ts')).toBe(resultFor(round3, 'r0_b.ts'));
  });

  it('sends a single stale read untouched while the tally is under the floor', async () => {
    const { id } = await service.createSession();
    await service.send(id, 'look at a');

    const readA = (callId: string, input: Record<string, unknown> = {}) => ({
      type: 'tool_use',
      tools: [{ id: callId, name: 'file_read', arguments: JSON.stringify({ path: join(root, 'a.ts'), ...input }) }],
    });
    await reply(0, readA('first'));
    await reply(1, readA('second', { limit: 5000 }));
    await reply(2, { type: 'tool_use', tools: [{ id: 'g', name: 'glob_files', arguments: '{"pattern":"*"}' }] });
    await reply(3, { type: 'content', text: 'ok' });
    await vi.waitUntil(() => events.some(event => event.type === 'done'), { timeout: 3000, interval: 5 });

    const round2 = messages(2);
    const round3 = messages(3);
    expect(JSON.stringify(round3.slice(0, round2.length))).toBe(JSON.stringify(round2));
    expect(resultFor(round3, 'first')).toMatch(/^ *1\tline 0 /);
  });
});
