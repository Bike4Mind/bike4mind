import { createHash } from 'node:crypto';
import { mkdtemp, realpath, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import type { AuthenticatedApiClient } from '@bike4mind/client-auth';
import { ChatModels, DEFERRED_ANCHOR_TOOL_NAME, ToolChangeMessageContentSchema } from '@bike4mind/common';
import type { ChatStreamEvent } from '@shared/chat';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ChatService } from './ChatService';
import type { ModelCatalog } from './ModelCatalog';
import { SessionStore } from './SessionStore';
import type { AccessStore } from './tools/AccessStore';

type WireTool = { toolSchema: { name: string; defer_loading?: boolean } };
type WireMessage = { role: string; content: unknown; cache?: boolean };
type Body = { messages: WireMessage[]; options: { tools: WireTool[] } };

function frame(payload: unknown): string {
  return `data: ${typeof payload === 'string' ? payload : JSON.stringify(payload)}\n\n`;
}

/** What Anthropic renders as the shared head: the loaded tools (sorted, as the server sends them) and the system prompt. */
function headHash(body: Body): string {
  const loaded = body.options.tools
    .filter(tool => !tool.toolSchema.defer_loading)
    .map(tool => tool.toolSchema)
    .sort((left, right) => (left.name < right.name ? -1 : left.name > right.name ? 1 : 0));
  const anyDeferred = body.options.tools.some(tool => tool.toolSchema.defer_loading);
  return createHash('sha256')
    .update(JSON.stringify({ loaded, anyDeferred, system: body.messages[0] }))
    .digest('hex');
}

const changes = (body: Body) =>
  body.messages.filter(message => message.role === 'system' && Array.isArray(message.content)).map(m => m.content);

describe('ChatService deferred tools', () => {
  let store: SessionStore;
  let root: string;
  let roots: string[];
  let backend: string;
  let post: ReturnType<typeof vi.fn>;
  let streams: PassThrough[];
  let events: ChatStreamEvent[];
  let service: ChatService;

  beforeEach(async () => {
    root = await realpath(await mkdtemp(join(tmpdir(), 'b4m-deferred-')));
    await writeFile(join(root, 'tiny.txt'), 'z', 'utf8');
    store = new SessionStore(await mkdtemp(join(tmpdir(), 'b4m-deferred-sessions-')), ChatModels.CLAUDE_5_5_OPUS);
    roots = [root];
    backend = 'anthropic';
    events = [];
    const opened: PassThrough[] = [];
    streams = opened;
    const boundPost = vi.fn().mockImplementation(() => {
      const stream = new PassThrough();
      opened.push(stream);
      return Promise.resolve({ data: stream, status: 200 });
    });
    post = boundPost;
    const emitted = events;
    service = new ChatService({
      store,
      models: {
        list: async () => ({
          models: [
            { id: ChatModels.CLAUDE_5_5_OPUS, name: 'Opus 5.5', backend },
            { id: ChatModels.CLAUDE_5_SONNET, name: 'Sonnet 5', backend },
          ],
        }),
        cached: () => [],
      } as unknown as ModelCatalog,
      access: { list: async () => roots } as unknown as AccessStore,
      logger: { debug: vi.fn(), warn: vi.fn() },
      getApiClient: () =>
        ({
          get: vi.fn().mockResolvedValue({}),
          getAxiosInstance: () => ({ post: boundPost }),
        }) as unknown as AuthenticatedApiClient,
      getEnvironmentUrl: () => 'http://localhost:3000',
      emit: event => emitted.push(event),
    });
  });

  const body = (index: number): Body => post.mock.calls[index][1] as Body;

  async function turn(sessionId: string, text: string, reply = 'ok'): Promise<Body> {
    const before = post.mock.calls.length;
    const done = events.filter(event => event.type === 'done').length;
    await service.send(sessionId, text);
    await vi.waitUntil(() => streams.length === before + 1, { timeout: 3000, interval: 5 });
    streams[before].write(frame({ type: 'content', text: reply }));
    streams[before].write(frame('[DONE]'));
    await vi.waitUntil(() => events.filter(event => event.type === 'done').length === done + 1, {
      timeout: 3000,
      interval: 5,
    });
    return body(before);
  }

  it('sends two different tool sets with the same head', async () => {
    const withFolder = await service.createSession();
    const first = await turn(withFolder.id, 'hi');
    roots = [];
    const withoutFolder = await service.createSession();
    const second = await turn(withoutFolder.id, 'hi');

    const deferredNames = (request: Body) =>
      request.options.tools.filter(tool => tool.toolSchema.defer_loading).map(tool => tool.toolSchema.name);
    expect(deferredNames(first)).toContain('file_read');
    expect(deferredNames(second)).not.toContain('file_read');
    expect(deferredNames(second)).toContain(DEFERRED_ANCHOR_TOOL_NAME);
    expect(headHash(first)).toBe(headHash(second));

    // The guidance moved out of the system prompt into a reminder on the turn.
    expect(first.messages[0].content).not.toContain('These folders are shared');
    expect(first.messages[1].content).toContain(root);
    expect(first.messages[1].content).toContain('<system-reminder>');
    const [change] = changes(first);
    expect(ToolChangeMessageContentSchema.safeParse(change).success).toBe(true);
    expect(first.messages[first.messages.length - 1].role).toBe('system');
    expect(first.messages.find(message => message.role === 'system' && Array.isArray(message.content))?.cache).toBe(
      undefined
    );
    expect(first.messages[1].cache).toBe(true);
  });

  it('keeps the earlier turns byte-identical when the tool set changes', async () => {
    roots = [];
    const { id } = await service.createSession();
    const first = await turn(id, 'hello');
    roots = [root];
    const second = await turn(id, 'now look at my folder');

    // Everything the first request sent is still the start of the second; only the breakpoints move.
    const unmarked = ({ cache: _cache, ...rest }: WireMessage) => rest;
    expect(second.messages.slice(0, first.messages.length).map(unmarked)).toEqual(first.messages.map(unmarked));
    expect(headHash(first)).toBe(headHash(second));

    const [, added] = changes(second) as { type: string; tool: { name: string } }[][];
    expect(added.map(block => `${block.type}:${block.tool.name}`)).toContain('tool_addition:file_read');
    const stored = await store.get(id);
    const records = stored?.messages.filter(message => message.toolState).map(message => message.toolState?.tools);
    expect(records).toHaveLength(2);
  });

  it('keeps the request shape of today on Bedrock and on a model without tool changes', async () => {
    backend = 'bedrock';
    const onBedrock = await service.createSession();
    const bedrock = await turn(onBedrock.id, 'hi');
    expect(bedrock.options.tools.some(tool => tool.toolSchema.defer_loading)).toBe(false);
    expect(changes(bedrock)).toEqual([]);
    expect(bedrock.messages[0].content).toContain('These folders are shared');
    roots = [];
    const noFolder = await service.createSession();
    expect(headHash(await turn(noFolder.id, 'hi'))).not.toBe(headHash(bedrock));
    roots = [root];

    backend = 'anthropic';
    const older = await service.createSession();
    await service.setSessionModel(older.id, ChatModels.CLAUDE_5_SONNET);
    const sonnet = await turn(older.id, 'hi');
    expect(sonnet.options.tools.some(tool => tool.toolSchema.defer_loading)).toBe(false);
    expect(changes(sonnet)).toEqual([]);
  });

  it('refuses a declared tool the turn no longer offers', async () => {
    const { id } = await service.createSession();
    await turn(id, 'hi');
    roots = [];
    const before = post.mock.calls.length;
    await service.send(id, 'read it again');
    await vi.waitUntil(() => streams.length === before + 1, { timeout: 3000, interval: 5 });
    const request = body(before);
    expect(request.options.tools.find(tool => tool.toolSchema.name === 'file_read')?.toolSchema.defer_loading).toBe(
      true
    );
    const removal = changes(request).at(-1) as { type: string; tool: { name: string } }[];
    expect(removal.map(block => `${block.type}:${block.tool.name}`)).toContain('tool_removal:file_read');

    streams[before].write(
      frame({
        type: 'tool_use',
        tools: [{ id: 'call_1', name: 'file_read', arguments: JSON.stringify({ path: join(root, 'tiny.txt') }) }],
      })
    );
    streams[before].write(frame('[DONE]'));
    const ended = await vi.waitUntil(() => events.find(event => event.type === 'tool-end'), {
      timeout: 3000,
      interval: 5,
    });
    expect(ended).toMatchObject({ call: { name: 'file_read', status: 'error' } });
    expect(JSON.stringify(ended)).toContain('not available in this conversation any more');
  });
});
