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

function waitFor(events: ChatStreamEvent[], type: ChatStreamEvent['type']): Promise<ChatStreamEvent> {
  return vi.waitUntil(() => events.find(event => event.type === type), { timeout: 3000, interval: 5 });
}

describe('ChatService tool loop', () => {
  let service: ChatService;
  let events: ChatStreamEvent[];
  let post: ReturnType<typeof vi.fn>;
  let streams: PassThrough[];
  let root: string;

  /**
   * Wait for the request itself, not the 'start' event: 'start' is emitted before the endpoint
   * is resolved and the POST issued, so there is no stream to write to yet when it fires.
   */
  function firstRequest(): Promise<unknown> {
    return vi.waitUntil(() => streams.length === 1, { timeout: 3000, interval: 5 });
  }

  beforeEach(async () => {
    root = await realpath(await mkdtemp(join(tmpdir(), 'b4m-loop-')));
    await writeFile(join(root, 'huge.bin'), 'z'.repeat(4096), 'utf8');
    await writeFile(join(root, 'tiny.txt'), 'z', 'utf8');

    const store = new SessionStore(await mkdtemp(join(tmpdir(), 'b4m-loop-sessions-')), 'test-model');
    events = [];
    streams = [];
    // A fresh stream per POST, so each turn of the loop has its own response.
    post = vi.fn().mockImplementation(() => {
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

  it('declares the file tools once a folder is granted', async () => {
    const { id } = await service.createSession();
    await service.send(id, 'hi');
    await firstRequest();

    const declared = post.mock.calls[0][1].options.tools.map(
      (entry: { toolSchema: { name: string } }) => entry.toolSchema.name
    );
    expect(declared).toEqual(['file_read', 'glob_files', 'grep_search']);
  });

  it('names the granted roots so the model looks them up instead of guessing a path', async () => {
    const { id } = await service.createSession();
    await service.send(id, 'what is in my shared folder?');
    await firstRequest();

    const preamble = post.mock.calls[0][1].messages[0];
    expect(preamble.role).toBe('system');
    expect(preamble.content).toContain(root);
    expect(preamble.content).toMatch(/absolute paths/);
  });

  it('runs the tool the model asks for and feeds the result back as a second turn', async () => {
    const { id } = await service.createSession();
    await service.send(id, 'what is the largest file?');
    await firstRequest();

    streams[0].write(
      frame({
        type: 'tool_use',
        tools: [{ id: 'call_1', name: 'glob_files', arguments: JSON.stringify({ pattern: '*', sort: 'size' }) }],
      })
    );
    streams[0].write(frame('[DONE]'));

    // A second POST only happens once the tool has actually run.
    await vi.waitUntil(() => post.mock.calls.length === 2, { timeout: 3000, interval: 5 });
    streams[1].write(frame({ type: 'content', text: 'huge.bin is the largest.' }));
    streams[1].write(frame('[DONE]'));

    const done = await waitFor(events, 'done');
    expect(done).toMatchObject({ content: 'huge.bin is the largest.' });

    const toolEnd = events.find(event => event.type === 'tool-end');
    expect(events.find(event => event.type === 'tool-start')).toMatchObject({
      call: { name: 'glob_files', status: 'running' },
    });
    expect(toolEnd).toMatchObject({ call: { name: 'glob_files', status: 'done' } });
    expect(toolEnd && 'call' in toolEnd ? toolEnd.call.preview : '').toContain('huge.bin');

    // The second request must carry the provider's tool_use / tool_result pair.
    // Index 0 is the access preamble, 1 the user prompt.
    const second = post.mock.calls[1][1].messages;
    expect(second[2]).toMatchObject({ role: 'assistant', content: [{ type: 'tool_use', id: 'call_1' }] });
    expect(second[3]).toMatchObject({ role: 'user', content: [{ type: 'tool_result', tool_use_id: 'call_1' }] });

    const persisted = (await service.getSession(id))?.messages[1];
    expect(persisted?.toolCalls).toHaveLength(1);
    expect(persisted?.toolCalls?.[0]).toMatchObject({ name: 'glob_files', status: 'done' });
  });

  it('reports a denied path back to the model rather than failing the turn', async () => {
    const { id } = await service.createSession();
    await service.send(id, 'read /etc/passwd');
    await firstRequest();

    streams[0].write(
      frame({
        type: 'tool_use',
        tools: [{ id: 'call_1', name: 'file_read', arguments: JSON.stringify({ path: '/etc/passwd' }) }],
      })
    );
    streams[0].write(frame('[DONE]'));

    await vi.waitUntil(() => post.mock.calls.length === 2, { timeout: 3000, interval: 5 });
    expect(events.find(event => event.type === 'tool-end')).toMatchObject({ call: { status: 'denied' } });

    const result = post.mock.calls[1][1].messages[3].content[0];
    expect(result).toMatchObject({ type: 'tool_result', is_error: true });
    expect(result.content).toMatch(/outside the folders you have granted/);

    streams[1].write(frame({ type: 'content', text: 'I cannot read that.' }));
    streams[1].write(frame('[DONE]'));
    await expect(waitFor(events, 'done')).resolves.toMatchObject({ content: 'I cannot read that.' });
  });

  it('reports an unknown tool without aborting the turn', async () => {
    const { id } = await service.createSession();
    await service.send(id, 'go');
    await firstRequest();

    streams[0].write(frame({ type: 'tool_use', tools: [{ id: 'c1', name: 'launch_missiles', arguments: '{}' }] }));
    streams[0].write(frame('[DONE]'));

    await vi.waitUntil(() => post.mock.calls.length === 2, { timeout: 3000, interval: 5 });
    expect(events.find(event => event.type === 'tool-end')).toMatchObject({ call: { status: 'error' } });
  });

  it('stops after the tool-turn ceiling instead of looping forever', async () => {
    const { id } = await service.createSession();
    await service.send(id, 'loop');
    await firstRequest();

    // A model that only ever asks for another tool would otherwise never terminate.
    for (let turn = 0; turn < 10; turn++) {
      await vi.waitUntil(() => streams.length === turn + 1, { timeout: 3000, interval: 5 });
      streams[turn].write(
        frame({ type: 'tool_use', tools: [{ id: `c${turn}`, name: 'glob_files', arguments: '{}' }] })
      );
      streams[turn].write(frame('[DONE]'));
    }

    const done = await waitFor(events, 'done');
    expect(done).toMatchObject({ stopReason: 'tool_turn_limit' });
    expect(post).toHaveBeenCalledTimes(10);
  });
});
