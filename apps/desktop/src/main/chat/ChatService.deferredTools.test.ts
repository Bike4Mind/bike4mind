import { createHash } from 'node:crypto';
import { mkdtemp, realpath, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import type { AuthenticatedApiClient } from '@bike4mind/client-auth';
import { ChatModels, DEFERRED_ANCHOR_TOOL_NAME, ToolChangeMessageContentSchema } from '@bike4mind/common';
import type { ChatStreamEvent } from '@shared/chat';
import { type Mock, beforeEach, describe, expect, it, vi } from 'vitest';
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
  let deferredTools: { startSetMaxTokens: number } | undefined;
  let logger: { debug: Mock<(message: string) => void>; warn: Mock<(message: string) => void> };

  beforeEach(async () => {
    logger = { debug: vi.fn(), warn: vi.fn() };
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
    deferredTools = { startSetMaxTokens: 100_000 };
    service = new ChatService({
      store,
      // Read per turn, so a test can switch the flag or the limit before a turn.
      get deferredTools() {
        return deferredTools;
      },
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
      logger,
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

  /** A turn whose first round reads tiny.txt and whose second answers. */
  async function readingTurn(sessionId: string, text: string, callId: string): Promise<void> {
    const before = post.mock.calls.length;
    const done = events.filter(event => event.type === 'done').length;
    await service.send(sessionId, text);
    await vi.waitUntil(() => streams.length === before + 1, { timeout: 3000, interval: 5 });
    streams[before].write(
      frame({
        type: 'tool_use',
        tools: [{ id: callId, name: 'file_read', arguments: JSON.stringify({ path: join(root, 'tiny.txt') }) }],
      })
    );
    streams[before].write(frame('[DONE]'));
    await vi.waitUntil(() => streams.length === before + 2, { timeout: 3000, interval: 5 });
    streams[before + 1].write(frame({ type: 'content', text: 'It says z.' }));
    streams[before + 1].write(frame('[DONE]'));
    await vi.waitUntil(() => events.filter(event => event.type === 'done').length === done + 1, {
      timeout: 3000,
      interval: 5,
    });
  }

  const blockNames = (message: WireMessage, type: string) =>
    Array.isArray(message.content)
      ? (message.content as { type: string; name?: string; tool?: { name: string } }[])
          .filter(block => block.type === type)
          .map(block => block.name ?? block.tool?.name)
      : [];

  /** Where the first tool_use of `name` sits, and where the first addition of it sits. */
  const positions = (request: Body, name: string) => ({
    use: request.messages.findIndex(message => blockNames(message, 'tool_use').includes(name)),
    addition: request.messages.findIndex(
      message => message.role === 'system' && blockNames(message, 'tool_addition').includes(name)
    ),
  });

  describe('a tool called on a turn that was not deferred', () => {
    async function switchAwayAndBack(shareOnReturn: boolean) {
      roots = [];
      const { id } = await service.createSession();
      const first = await turn(id, 'hello');
      expect(first.options.tools.some(tool => tool.toolSchema.name === 'file_read')).toBe(false);

      await service.setSessionModel(id, ChatModels.CLAUDE_5_SONNET);
      roots = [root];
      await readingTurn(id, 'read my file', 'call_1');
      await service.setSessionModel(id, ChatModels.CLAUDE_5_5_OPUS);
      if (!shareOnReturn) roots = [];
      const third = await turn(id, 'back on Opus');
      const fourth = await turn(id, 'and again');
      return { first, third, fourth };
    }

    const unmarked = ({ cache: _cache, ...rest }: WireMessage) => rest;

    it.each([
      ['still shared', true],
      ['unshared again', false],
    ])('is added before its replayed call and declared deferred (%s)', async (_label, shared) => {
      const { first, third, fourth } = await switchAwayAndBack(shared);
      for (const request of [third, fourth]) {
        const { use, addition } = positions(request, 'file_read');
        expect(use).toBeGreaterThan(0);
        expect(addition).toBeGreaterThan(0);
        expect(addition).toBeLessThan(use);
        // The change sits on the read's own prompt, so nothing before that prompt moved.
        expect(request.messages[addition - 1]).toMatchObject({ role: 'user', content: 'read my file' });
        expect(request.options.tools.find(tool => tool.toolSchema.name === 'file_read')?.toolSchema.defer_loading).toBe(
          true
        );
      }
      expect(third.messages.slice(0, first.messages.length).map(unmarked)).toEqual(first.messages.map(unmarked));
      expect(fourth.messages.slice(0, third.messages.length).map(unmarked)).toEqual(third.messages.map(unmarked));
      expect(headHash(first)).toBe(headHash(third));
      expect(headHash(third)).toBe(headHash(fourth));

      const lastChange = changes(third).at(-1) as { type: string; tool: { name: string } }[];
      const summary = lastChange.map(block => `${block.type}:${block.tool.name}`);
      if (shared) {
        expect(summary).not.toContain('tool_addition:file_read');
        expect(summary.every(entry => entry.startsWith('tool_addition:'))).toBe(true);
      } else {
        expect(summary).toEqual(['tool_removal:file_read']);
      }
    });
  });

  it('retries a tool-state write that failed once', async () => {
    const original = store.updateMessage.bind(store);
    let failures = 0;
    const update = vi.spyOn(store, 'updateMessage').mockImplementation((sessionId, messageId, changes) => {
      if (changes.toolState && failures++ === 0) return Promise.reject(new Error('disk busy'));
      return original(sessionId, messageId, changes);
    });
    const { id } = await service.createSession();
    await turn(id, 'hi');

    const writes = update.mock.calls.filter(([, , changes]) => changes.toolState);
    expect(writes).toHaveLength(2);
    expect(writes[1][1]).toBe(writes[0][1]);
    const stored = await store.get(id);
    expect(stored?.messages.find(message => message.id === writes[0][1])?.toolState).toEqual(writes[0][2].toolState);
    expect(logger.warn).not.toHaveBeenCalledWith(expect.stringContaining('could not store the tool state'));
  });

  it('sends two different tool sets with the same head when every optional tool is deferred', async () => {
    deferredTools = { startSetMaxTokens: 0 };
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

  it('keeps the start set loaded and adds a folder shared later append-only', async () => {
    roots = [];
    const { id } = await service.createSession();
    const first = await turn(id, 'hello');
    // The start set is loaded, so a turn with no MCP tools needs no change message.
    expect(changes(first)).toEqual([]);
    expect(first.options.tools.find(tool => tool.toolSchema.name === 'ask_user')?.toolSchema.defer_loading).toBe(
      undefined
    );
    roots = [root];
    const second = await turn(id, 'now look at my folder');
    const third = await turn(id, 'and again');

    // Everything the first request sent is still the start of the second; only the breakpoints move.
    const unmarked = ({ cache: _cache, ...rest }: WireMessage) => rest;
    expect(second.messages.slice(0, first.messages.length).map(unmarked)).toEqual(first.messages.map(unmarked));
    expect(headHash(first)).toBe(headHash(second));
    expect(headHash(second)).toBe(headHash(third));

    const [added] = changes(second) as { type: string; tool: { name: string } }[][];
    expect(added.map(block => `${block.type}:${block.tool.name}`)).toContain('tool_addition:file_read');
    expect(added.every(block => block.type === 'tool_addition')).toBe(true);
    expect(second.options.tools.find(tool => tool.toolSchema.name === 'file_read')?.toolSchema.defer_loading).toBe(
      true
    );
    const stored = await store.get(id);
    const records = stored?.messages.filter(message => message.toolState).map(message => message.toolState?.tools);
    expect(records).toHaveLength(2);

    // The turn after the change re-marks the second request's rolling breakpoint, which the change's
    // blocks could push past the provider's lookback.
    const secondPrompt = second.messages.findLastIndex(message => message.role === 'user');
    expect(third.messages[secondPrompt].cache).toBe(true);
    expect(third.messages.filter(message => message.cache).length).toBe(3);
  });

  it.each([
    ['today', undefined],
    ['deferred', { startSetMaxTokens: 100_000 }],
  ])('replays a tool turn exactly as its rounds sent it (%s)', async (_label, flag) => {
    deferredTools = flag;
    const { id } = await service.createSession();
    const before = post.mock.calls.length;
    await service.send(id, 'read it');
    await vi.waitUntil(() => streams.length === before + 1, { timeout: 3000, interval: 5 });
    streams[before].write(frame({ type: 'content', text: 'Reading.' }));
    streams[before].write(
      frame({
        type: 'tool_use',
        tools: [{ id: 'call_1', name: 'file_read', arguments: JSON.stringify({ path: join(root, 'tiny.txt') }) }],
      })
    );
    streams[before].write(frame('[DONE]'));
    await vi.waitUntil(() => streams.length === before + 2, { timeout: 3000, interval: 5 });
    streams[before + 1].write(frame({ type: 'content', text: 'It says z.' }));
    streams[before + 1].write(frame('[DONE]'));
    await vi.waitUntil(() => events.some(event => event.type === 'done'), { timeout: 3000, interval: 5 });
    const lastRound = body(before + 1);

    const next = await turn(id, 'thanks');
    const unmarked = ({ cache: _cache, ...rest }: WireMessage) => rest;
    expect(next.messages.slice(0, lastRound.messages.length).map(unmarked)).toEqual(lastRound.messages.map(unmarked));
    expect(next.messages[lastRound.messages.length]).toEqual({ role: 'assistant', content: 'It says z.' });
  });

  it('keeps the request shape of today with the flag off', async () => {
    deferredTools = undefined;
    const { id } = await service.createSession();
    const request = await turn(id, 'hi');
    expect(request.options.tools.some(tool => tool.toolSchema.defer_loading)).toBe(false);
    expect(request.messages[0].content).toContain('These folders are shared');
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
    // Still declared, and still loaded: it is in the start set, so the head keeps its bytes.
    expect(request.options.tools.find(tool => tool.toolSchema.name === 'file_read')?.toolSchema.defer_loading).toBe(
      undefined
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
