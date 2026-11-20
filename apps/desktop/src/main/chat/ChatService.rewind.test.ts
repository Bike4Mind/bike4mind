import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import type { AuthenticatedApiClient } from '@bike4mind/client-auth';
import type { ChatMessage, ChatStreamEvent } from '@shared/chat';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { formatModelEditNote, modelEditSummary } from '@shared/modelEdit';
import { AttachmentStore } from './AttachmentStore';
import { ChatService } from './ChatService';
import { SessionStore } from './SessionStore';
import { TITLE_INSTRUCTION } from './sessionTitle';
import type { AccessStore } from './tools/AccessStore';

function frame(payload: unknown): string {
  return `data: ${typeof payload === 'string' ? payload : JSON.stringify(payload)}\n\n`;
}

type WireMessage = { role: string; content: unknown };
type WireBody = { messages: WireMessage[] };

/** Every text the user role carried in one request, flattened, so a dropped prompt is easy to spot. */
function wireText(body: WireBody): string {
  return JSON.stringify(body.messages.filter(message => message.role === 'user' || message.role === 'assistant'));
}

/**
 * Editing a sent prompt and regenerating a reply: both rewind the STORED thread in main, so what
 * the model is sent next, and what a reload shows, no longer carries the dropped turns.
 */
describe('ChatService rewind', () => {
  let directory: string;
  let store: SessionStore;
  let service: ChatService;
  let events: ChatStreamEvent[];
  let streams: PassThrough[];
  let post: ReturnType<typeof vi.fn>;
  let attachments: AttachmentStore;

  const streamFor = (index: number) => {
    streams[index] ??= new PassThrough();
    return streams[index];
  };
  /** Indexes of the completion requests that are replies, not the first prompt's title request. */
  const replyCalls = () =>
    post.mock.calls.flatMap((call, index) =>
      (call[1] as WireBody).messages[0]?.content === TITLE_INSTRUCTION ? [] : [index]
    );
  const replyBody = (nth: number) => post.mock.calls[replyCalls()[nth]][1] as WireBody;
  const doneCount = () => events.filter(event => event.type === 'done').length;

  /** Wait for the nth reply's request, answer it, and wait for it to settle. */
  const answer = async (nth: number, text: string) => {
    await vi.waitUntil(() => replyCalls().length > nth, { timeout: 2000, interval: 5 });
    const before = doneCount();
    const stream = streamFor(replyCalls()[nth]);
    stream.write(frame({ type: 'content', text, stopReason: 'end_turn' }));
    stream.write(frame('[DONE]'));
    await vi.waitUntil(() => doneCount() > before, { timeout: 2000, interval: 5 });
    // The reply settles to disk just after 'done' is announced.
    await vi.waitUntil(async () => (await store.get(sessionIdOf))?.messages.at(-1)?.content === text, {
      timeout: 2000,
      interval: 5,
    });
  };
  let sessionIdOf = '';

  const thread = async (id: string) =>
    ((await store.get(id))?.messages ?? []).map(message => `${message.role}:${message.content}`);

  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), 'b4m-rewind-'));
    store = new SessionStore(directory, 'test-model');
    events = [];
    streams = [];
    const boundPost = vi
      .fn()
      .mockImplementation(() => Promise.resolve({ data: streamFor(boundPost.mock.calls.length - 1), status: 200 }));
    post = boundPost;
    const apiClient = {
      get: vi.fn().mockResolvedValue({ sseCompletionsUrl: '' }),
      getAxiosInstance: () => ({ post: boundPost }),
    } as unknown as AuthenticatedApiClient;
    attachments = new AttachmentStore(await mkdtemp(join(tmpdir(), 'b4m-rewind-attachments-')), {
      debug: vi.fn(),
      warn: vi.fn(),
    });
    service = new ChatService({
      store,
      attachments,
      access: { list: async () => [] } as unknown as AccessStore,
      logger: { debug: vi.fn(), warn: vi.fn() },
      getApiClient: () => apiClient,
      getEnvironmentUrl: () => 'http://localhost:3000',
      emit: event => events.push(event),
    });
  });

  /** A conversation of two finished turns: "first" / "reply one", "second" / "reply two". */
  const twoTurns = async () => {
    const { id } = await service.createSession();
    sessionIdOf = id;
    await service.send(id, 'first');
    await answer(0, 'reply one');
    await service.send(id, 'second');
    await answer(1, 'reply two');
    return id;
  };

  describe('editMessage', () => {
    it('replaces the prompt, drops every later turn from the thread and the wire, and survives a reload', async () => {
      const id = await twoTurns();
      const first = (await store.get(id))!.messages[0];

      const result = await service.editMessage(id, first.id, 'first, edited');
      expect(result).toMatchObject({ ok: true });
      await answer(2, 'reply to the edit');

      const wire = wireText(replyBody(2));
      expect(wire).toContain('first, edited');
      for (const dropped of ['"first"', 'reply one', 'second', 'reply two']) expect(wire).not.toContain(dropped);

      expect(await thread(id)).toEqual(['user:first, edited', 'assistant:reply to the edit']);
      // A fresh store reads the file, as reopening the session does.
      const reopened = await new SessionStore(directory, 'test-model').get(id);
      expect(reopened?.messages.map(message => message.content)).toEqual(['first, edited', 'reply to the edit']);
    });

    it('edits a later prompt and keeps the turns before it', async () => {
      const id = await twoTurns();
      const second = (await store.get(id))!.messages[2];

      expect(await service.editMessage(id, second.id, 'second, edited')).toMatchObject({ ok: true });
      await answer(2, 'reply three');

      expect(await thread(id)).toEqual([
        'user:first',
        'assistant:reply one',
        'user:second, edited',
        'assistant:reply three',
      ]);
    });

    it('is refused, not queued, while a turn is running, and leaves the thread alone', async () => {
      const id = await twoTurns();
      const first = (await store.get(id))!.messages[0];
      await service.send(id, 'third');
      await vi.waitUntil(() => replyCalls().length > 2, { timeout: 2000, interval: 5 });

      const result = await service.editMessage(id, first.id, 'too soon');
      expect(result).toMatchObject({ ok: false, error: expect.stringMatching(/replying/i) });
      await answer(2, 'reply three');
      expect(await thread(id)).toEqual([
        'user:first',
        'assistant:reply one',
        'user:second',
        'assistant:reply two',
        'user:third',
        'assistant:reply three',
      ]);
    });

    it('refuses a message that is not a prompt the user typed', async () => {
      const id = await twoTurns();
      const reply = (await store.get(id))!.messages[1];
      expect(await service.editMessage(id, reply.id, 'nope')).toMatchObject({ ok: false });
      expect(await service.editMessage(id, 'no-such-message', 'nope')).toMatchObject({ ok: false });
      expect(await thread(id)).toHaveLength(4);
    });

    it('refuses an empty edit without touching the thread', async () => {
      const id = await twoTurns();
      const first = (await store.get(id))!.messages[0];
      expect(await service.editMessage(id, first.id, '   ')).toMatchObject({ ok: false });
      expect(await thread(id)).toHaveLength(4);
    });

    it('keeps the point-and-edit note of the edited prompt, so the resent turn still names the parts', async () => {
      const { id } = await service.createSession();
      sessionIdOf = id;
      const note = formatModelEditNote({
        path: 'model.ts',
        units: 'mm',
        parts: [{ name: 'lid', lines: [3], min: [0, 0, 0], max: [1, 1, 1] }],
        sharedLines: [],
      });
      await service.send(id, 'make this red', [], { notes: [note] });
      await answer(0, 'made it red');

      const first = (await store.get(id))!.messages[0];
      expect(await service.editMessage(id, first.id, 'make this blue')).toMatchObject({ ok: true });
      await answer(1, 'made it blue');

      const edited = (await store.get(id))!.messages[0];
      expect(edited.content).toBe('make this blue');
      expect(modelEditSummary(edited.notes)).toEqual({ parts: ['lid'] });
      expect(JSON.stringify(replyBody(1).messages)).toContain('Point-and-edit request');
    });

    it('keeps the edited prompt attachments and prunes the files only dropped turns referenced', async () => {
      const { id } = await service.createSession();
      sessionIdOf = id;
      const kept = (await attachments.add(id, [{ source: 'bytes', name: 'kept.txt', data: Buffer.from('a') }]))
        .attachments[0];
      await service.send(id, 'look', [kept]);
      await answer(0, 'seen');
      const dropped = (await attachments.add(id, [{ source: 'bytes', name: 'later.txt', data: Buffer.from('b') }]))
        .attachments[0];
      await service.send(id, 'and this', [dropped]);
      await answer(1, 'seen too');
      const prune = vi.spyOn(attachments, 'prune');

      const first = (await store.get(id))!.messages[0];
      expect(await service.editMessage(id, first.id, 'look again')).toMatchObject({ ok: true });
      await answer(2, 'looked again');

      const stored = (await store.get(id))!.messages;
      expect(stored[0].attachments?.map(attachment => attachment.id)).toEqual([kept.id]);
      const keep = prune.mock.calls.at(-1)?.[1];
      expect(keep?.has(kept.id)).toBe(true);
      expect(keep?.has(dropped.id)).toBe(false);
    });
  });

  describe('regenerateReply', () => {
    it('drops the last reply and runs its prompt again', async () => {
      const id = await twoTurns();

      expect(await service.regenerateReply(id)).toMatchObject({ ok: true });
      await answer(2, 'reply two, again');

      const wire = replyBody(2).messages;
      expect(wire.at(-1)).toMatchObject({ role: 'user' });
      expect(wireText(replyBody(2))).not.toContain('reply two"');
      expect(wireText(replyBody(2))).toContain('reply one');
      expect(await thread(id)).toEqual([
        'user:first',
        'assistant:reply one',
        'user:second',
        'assistant:reply two, again',
      ]);
    });

    it('is refused while a turn is running', async () => {
      const id = await twoTurns();
      await service.send(id, 'third');
      await vi.waitUntil(() => replyCalls().length > 2, { timeout: 2000, interval: 5 });

      expect(await service.regenerateReply(id)).toMatchObject({ ok: false, error: expect.stringMatching(/replying/i) });
      await answer(2, 'reply three');
      expect((await thread(id)).at(-1)).toBe('assistant:reply three');
    });

    it('is refused when the thread does not end in a reply', async () => {
      const { id } = await service.createSession();
      expect(await service.regenerateReply(id)).toMatchObject({ ok: false });
      const prompt: ChatMessage = { id: 'p1', role: 'user', content: 'hi', createdAt: new Date().toISOString() };
      await store.appendMessage(id, prompt);
      expect(await service.regenerateReply(id)).toMatchObject({ ok: false });
      expect(await thread(id)).toEqual(['user:hi']);
    });
  });
});
