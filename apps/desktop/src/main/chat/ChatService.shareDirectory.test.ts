import { mkdir, mkdtemp, realpath, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import type { AuthenticatedApiClient } from '@bike4mind/client-auth';
import type { ChatStreamEvent, ChatToolCall } from '@shared/chat';
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

function harness(store: SessionStore, streams: PassThrough[], events: ChatStreamEvent[]) {
  const post = vi.fn().mockImplementation(() => {
    const stream = new PassThrough();
    streams.push(stream);
    return Promise.resolve({ data: stream, status: 200 });
  });
  const service = new ChatService({
    store,
    access: { list: async () => [], grant: vi.fn(), revoke: vi.fn() } as unknown as AccessStore,
    approvals: new ApprovalGate(),
    queue: new MessageQueue(() => {}),
    logger: { debug: vi.fn(), warn: vi.fn() },
    getApiClient: () =>
      ({
        get: vi.fn().mockResolvedValue({}),
        getAxiosInstance: () => ({ post }),
      }) as unknown as AuthenticatedApiClient,
    getEnvironmentUrl: () => 'http://localhost:3000',
    emit: event => events.push(event),
  });
  const body = (callIndex: number) => post.mock.calls[callIndex][1];
  const toolNames = (callIndex: number): string[] =>
    (body(callIndex).options.tools as { toolSchema: { name: string } }[]).map(tool => tool.toolSchema.name);
  const systemPrompt = (callIndex: number): string => (body(callIndex).messages as { content: string }[])[0].content;
  const lastToolResult = (callIndex: number): string => {
    const messages = body(callIndex).messages as { content: unknown }[];
    const results = messages[messages.length - 1].content as { content: string }[];
    return results[results.length - 1].content;
  };
  const awaitRound = (count: number) => vi.waitUntil(() => streams.length === count, { timeout: 5000, interval: 5 });
  return { service, toolNames, systemPrompt, lastToolResult, awaitRound };
}

/** The chip's picker and `/add-dir` share a folder any time, and a running turn follows along. */
describe('ChatService.shareDirectory', () => {
  let base: string;
  let store: SessionStore;
  let events: ChatStreamEvent[];
  let streams: PassThrough[];
  let project: string;
  let outside: string;
  let h: ReturnType<typeof harness>;

  const awaitSettled = (id: string): Promise<ChatToolCall> =>
    vi.waitUntil(
      () =>
        events
          .map(event => (event.type === 'tool-end' ? event.call : null))
          .find((call): call is ChatToolCall => call !== null && call.id === id),
      { timeout: 5000, interval: 10 }
    );

  beforeEach(async () => {
    base = await realpath(await mkdtemp(join(tmpdir(), 'b4m-share-')));
    project = join(base, 'project');
    outside = join(base, 'outside');
    await mkdir(join(project, 'nested'), { recursive: true });
    await mkdir(outside);
    await writeFile(join(outside, 'NOTES.md'), 'outside notes', 'utf8');
    await writeFile(join(base, 'file.txt'), 'not a folder', 'utf8');
    store = new SessionStore(await mkdtemp(join(tmpdir(), 'b4m-share-sessions-')), 'test-model');
    events = [];
    streams = [];
    h = harness(store, streams, events);
  });

  afterEach(() => {
    h.service.dispose();
    for (const stream of streams) stream.end();
  });

  async function codeSession(): Promise<string> {
    const created = await h.service.createCodeSession({ directory: project, branch: '', workspace: false });
    if (!created.ok) throw new Error(created.error);
    return created.session.id;
  }

  it('adds a Code session context folder by its real path, after the session has run', async () => {
    const id = await codeSession();
    await h.service.send(id, 'go');
    await h.awaitRound(1);
    streams[0].write(frame({ type: 'content', text: 'Done.' }));
    streams[0].write(frame('[DONE]'));
    await vi.waitUntil(() => events.some(event => event.type === 'done'), { timeout: 5000, interval: 10 });

    expect(await h.service.shareDirectory(id, outside)).toMatchObject({ status: 'added', path: outside });
    expect((await store.get(id))?.project?.contextDirectories).toEqual([outside]);
    expect((await store.get(id))?.grantedDirectories).toBeUndefined();
  });

  it('gives a Chat session a granted folder instead', async () => {
    const chat = await h.service.createSession();

    expect(await h.service.shareDirectory(chat.id, outside)).toMatchObject({ status: 'added', path: outside });
    expect((await store.get(chat.id))?.grantedDirectories).toEqual([outside]);
  });

  it('resolves a relative path against the working directory and shares the target of a symlink', async () => {
    const id = await codeSession();
    const link = join(base, 'link');
    await symlink(outside, link);

    expect(await h.service.shareDirectory(id, '../outside')).toMatchObject({ status: 'added', path: outside });
    await h.service.removeContextDirectory(id, outside);
    expect(await h.service.shareDirectory(id, link)).toMatchObject({ status: 'added', path: outside });
    expect((await store.get(id))?.project?.contextDirectories).toEqual([outside]);
  });

  it.each([
    ['a missing path', 'missing', /not an existing folder/],
    ['a file', 'file.txt', /not an existing folder/],
    ['the filesystem root', '/', /root cannot be shared/],
  ])('refuses %s with a message and grants nothing', async (_name, path, message) => {
    const id = await codeSession();
    const result = await h.service.shareDirectory(id, path === '/' ? path : join(base, path));

    expect(result.status).toBe('refused');
    if (result.status === 'refused') expect(result.error).toMatch(message);
    expect((await store.get(id))?.project?.contextDirectories).toEqual([]);
  });

  it('is a no-op for a folder already shared, the project or one beneath it included', async () => {
    const id = await codeSession();
    await h.service.shareDirectory(id, outside);

    expect(await h.service.shareDirectory(id, outside)).toEqual({ status: 'already', path: outside });
    expect(await h.service.shareDirectory(id, 'nested')).toEqual({ status: 'already', path: join(project, 'nested') });
    expect((await store.get(id))?.project?.contextDirectories).toEqual([outside]);
  });

  it('offers request_directory in a Code session that already has a project', async () => {
    const id = await codeSession();
    await h.service.send(id, 'go');
    await h.awaitRound(1);

    expect(h.toolNames(0)).toContain('request_directory');
    expect(h.systemPrompt(0)).toContain('call request_directory');
  });

  it('applies a folder shared mid-turn to the calls the model asks for next, and tells it', async () => {
    const id = await codeSession();
    await h.service.send(id, 'read the notes');
    await h.awaitRound(1);

    // Shared while the first round is still streaming, before the model has asked for anything.
    await h.service.shareDirectory(id, outside);
    streams[0].write(toolTurn('read-1', 'file_read', { path: join(outside, 'NOTES.md') }));
    streams[0].write(frame('[DONE]'));

    expect((await awaitSettled('read-1')).preview).toContain('outside notes');
    await h.awaitRound(2);
    expect(h.lastToolResult(1)).toContain(`now shared: ${outside}`);
  });

  it('drops a folder removed mid-turn before the next round runs its calls', async () => {
    const id = await codeSession();
    await h.service.shareDirectory(id, outside);
    await h.service.send(id, 'read the notes');
    await h.awaitRound(1);
    streams[0].write(toolTurn('read-1', 'file_read', { path: join(outside, 'NOTES.md') }));
    streams[0].write(frame('[DONE]'));
    expect((await awaitSettled('read-1')).preview).toContain('outside notes');
    await h.awaitRound(2);
    expect(h.lastToolResult(1)).not.toContain('shared folders');

    await h.service.removeContextDirectory(id, outside);
    streams[1].write(toolTurn('read-2', 'file_read', { path: join(outside, 'NOTES.md') }));
    streams[1].write(frame('[DONE]'));

    expect((await awaitSettled('read-2')).error).toMatch(/outside the folders shared with you/);
    await h.awaitRound(3);
    expect(h.lastToolResult(2)).toContain(`no longer shared: ${outside}`);
  });
});

/** A spawned session's seed run has nobody to answer a card; a turn the user types into it does. */
describe('request_directory in a spawned session', () => {
  let store: SessionStore;
  let streams: PassThrough[];
  let h: ReturnType<typeof harness>;

  beforeEach(async () => {
    store = new SessionStore(await mkdtemp(join(tmpdir(), 'b4m-share-spawn-')), 'test-model');
    streams = [];
    h = harness(store, streams, []);
  });

  afterEach(() => {
    h.service.dispose();
    for (const stream of streams) stream.end();
  });

  async function spawned(): Promise<string> {
    const child = await store.create(undefined, { origin: { parentSessionId: 'parent', depth: 1, seedPrompt: 'go' } });
    return child.id;
  }

  it('is withheld from the seed run, which is pointed at /add-dir rather than a chip', async () => {
    const id = await spawned();
    await h.service.send(id, 'go', [], undefined, 0);
    await h.awaitRound(1);

    expect(h.toolNames(0)).not.toContain('request_directory');
    expect(h.systemPrompt(0)).toContain('/add-dir');
    expect(h.systemPrompt(0)).not.toMatch(/chip/);
  });

  it('is offered on a turn the user typed into it', async () => {
    const id = await spawned();
    await h.service.send(id, 'please read my notes');
    await h.awaitRound(1);

    expect(h.toolNames(0)).toContain('request_directory');
    expect(h.systemPrompt(0)).toContain('call request_directory');
  });
});
