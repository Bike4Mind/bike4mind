import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import type { AuthenticatedApiClient } from '@bike4mind/client-auth';
import type { ChatAttachment, ChatModelOption, ChatStreamEvent } from '@shared/chat';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { AttachmentStore } from './AttachmentStore';
import { ChatService } from './ChatService';
import { SessionStore } from './SessionStore';
import type { AccessStore } from './tools/AccessStore';
import type { ModelCatalog } from './ModelCatalog';

function frame(payload: unknown): string {
  return `data: ${typeof payload === 'string' ? payload : JSON.stringify(payload)}\n\n`;
}

function waitFor(events: ChatStreamEvent[], type: ChatStreamEvent['type']): Promise<ChatStreamEvent> {
  return vi.waitUntil(() => events.find(event => event.type === type), { timeout: 2000, interval: 5 });
}

/** The content array of the user turn in the request body, whatever shape the rest took. */
function userContent(post: ReturnType<typeof vi.fn>): unknown[] {
  const body = post.mock.calls[0][1] as { messages: { role: string; content: unknown }[] };
  const turn = body.messages.find(message => message.role === 'user');
  return Array.isArray(turn?.content) ? (turn.content as unknown[]) : [];
}

describe('ChatService attachments', () => {
  let store: SessionStore;
  let attachments: AttachmentStore;
  let service: ChatService;
  let events: ChatStreamEvent[];
  let stream: PassThrough;
  let post: ReturnType<typeof vi.fn>;
  let cachedModels: ChatModelOption[];

  beforeEach(async () => {
    const root = await mkdtemp(join(tmpdir(), 'b4m-chat-attach-'));
    store = new SessionStore(join(root, 'sessions'), 'vision-model');
    attachments = new AttachmentStore(join(root, 'attachments'), { debug: vi.fn(), warn: vi.fn() });
    events = [];
    stream = new PassThrough();
    post = vi.fn().mockResolvedValue({ data: stream, status: 200 });
    cachedModels = [{ id: 'vision-model', name: 'Vision Model', supportsVision: true }];

    service = new ChatService({
      store,
      attachments,
      access: { list: async () => [] } as unknown as AccessStore,
      models: { cached: () => cachedModels, list: async () => ({ models: cachedModels }) } as unknown as ModelCatalog,
      preferredModel: 'vision-model',
      logger: { debug: vi.fn(), warn: vi.fn() },
      getApiClient: () =>
        ({
          get: vi.fn().mockResolvedValue({ sseCompletionsUrl: '' }),
          getAxiosInstance: () => ({ post }),
        }) as unknown as AuthenticatedApiClient,
      getEnvironmentUrl: () => 'http://localhost:3000',
      emit: event => events.push(event),
    });
  });

  const attach = async (
    sessionId: string,
    input: { name: string; mediaType?: string; data: Uint8Array }
  ): Promise<ChatAttachment> => {
    const result = await attachments.add(sessionId, [{ source: 'bytes', ...input }]);
    return result.attachments[0];
  };

  const settle = async () => {
    await waitFor(events, 'start');
    stream.write(frame({ type: 'content', text: 'ok', stopReason: 'end_turn' }));
    stream.write(frame('[DONE]'));
    await waitFor(events, 'done');
  };

  it('sends an image as an image block, ahead of the text', async () => {
    const { id } = await service.createSession();
    const image = await attach(id, { name: 'bug.png', mediaType: 'image/png', data: new Uint8Array([1, 2, 3]) });

    expect(await service.send(id, 'what is wrong here?', [image])).toMatchObject({ ok: true });
    await settle();

    const content = userContent(post);
    expect(content[0]).toEqual({
      type: 'image',
      source: { type: 'base64', media_type: 'image/png', data: Buffer.from([1, 2, 3]).toString('base64') },
    });
    expect(content[1]).toEqual({ type: 'text', text: 'what is wrong here?' });
  });

  it('inlines a text file ahead of the prompt, tagged with its name', async () => {
    const { id } = await service.createSession();
    const log = await attach(id, { name: 'app.log', data: new Uint8Array(Buffer.from('boom\n', 'utf8')) });

    await service.send(id, 'why?', [log]);
    await settle();

    const [block] = userContent(post) as { type: string; text: string }[];
    expect(block.type).toBe('text');
    expect(block.text).toContain('<attached-file name="app.log"');
    expect(block.text).toContain('boom');
    // The question is the last thing the model reads.
    expect(block.text.endsWith('why?')).toBe(true);
  });

  it('accepts an attachment with no words as a turn of its own', async () => {
    const { id } = await service.createSession();
    const image = await attach(id, { name: 'shot.png', mediaType: 'image/png', data: new Uint8Array([9]) });

    expect(await service.send(id, '', [image])).toMatchObject({ ok: true });
    await settle();

    // With nothing typed, the filename is all there is to name the conversation after.
    expect((await service.getSession(id))?.title).toBe('shot.png');
  });

  it('persists attachments with the session and replays them on the next turn', async () => {
    const { id } = await service.createSession();
    const image = await attach(id, { name: 'bug.png', mediaType: 'image/png', data: new Uint8Array([7]) });
    await service.send(id, 'look', [image]);
    await settle();

    const reopened = await service.getSession(id);
    expect(reopened?.messages[0].attachments).toEqual([expect.objectContaining({ name: 'bug.png' })]);

    // A stateless endpoint means the image is resent verbatim with every later turn.
    events.length = 0;
    stream = new PassThrough();
    post.mockResolvedValue({ data: stream, status: 200 });
    post.mockClear();
    await service.send(id, 'and now?');
    await settle();

    const resent = (post.mock.calls[0][1] as { messages: { role: string; content: unknown }[] }).messages;
    const firstUser = resent.find(message => message.role === 'user');
    expect(firstUser?.content).toEqual([expect.objectContaining({ type: 'image' }), expect.anything()]);
  });

  it('refuses images on a model the catalog says cannot read them, without storing the turn', async () => {
    cachedModels = [{ id: 'vision-model', name: 'Blind Model', supportsVision: false }];
    const { id } = await service.createSession();
    const image = await attach(id, { name: 'bug.png', mediaType: 'image/png', data: new Uint8Array([1]) });

    const result = await service.send(id, 'look', [image]);

    expect(result).toMatchObject({ ok: false });
    if (result.ok) return;
    expect(result.error).toContain('Blind Model');
    expect(post).not.toHaveBeenCalled();
    // Refused before anything was persisted - a prompt left in the thread with no reply coming
    // is worse than a refusal the user can act on.
    expect((await service.getSession(id))?.messages).toEqual([]);
  });

  // The catalog only carries the flag for backends that report it, so silence is not a "no".
  it('allows images when the catalog says nothing about vision', async () => {
    cachedModels = [{ id: 'vision-model', name: 'Quiet Model' }];
    const { id } = await service.createSession();
    const image = await attach(id, { name: 'bug.png', mediaType: 'image/png', data: new Uint8Array([1]) });

    expect(await service.send(id, 'look', [image])).toMatchObject({ ok: true });
    await settle();
  });

  it('never refuses a text attachment over vision', async () => {
    cachedModels = [{ id: 'vision-model', name: 'Blind Model', supportsVision: false }];
    const { id } = await service.createSession();
    const log = await attach(id, { name: 'a.txt', data: new Uint8Array(Buffer.from('hi', 'utf8')) });

    expect(await service.send(id, 'read this', [log])).toMatchObject({ ok: true });
    await settle();
  });

  it('drops an attachment whose bytes are gone rather than sending its filename', async () => {
    const { id } = await service.createSession();
    const image = await attach(id, { name: 'bug.png', mediaType: 'image/png', data: new Uint8Array([1]) });
    await attachments.discard(id, image.id);

    await service.send(id, 'look', [image]);
    await settle();

    expect((await service.getSession(id))?.messages[0].attachments).toBeUndefined();
    const body = post.mock.calls[0][1] as { messages: { role: string; content: unknown }[] };
    expect(body.messages.find(message => message.role === 'user')?.content).toBe('look');
  });

  it('ignores an attachment belonging to another conversation', async () => {
    const mine = await service.createSession();
    const theirs = await service.createSession();
    const image = await attach(theirs.id, { name: 'bug.png', mediaType: 'image/png', data: new Uint8Array([1]) });

    await service.send(mine.id, 'look', [image]);
    await settle();

    expect((await service.getSession(mine.id))?.messages[0].attachments).toBeUndefined();
  });

  it('throws away attachments the user added and then removed before sending', async () => {
    const { id } = await service.createSession();
    const kept = await attach(id, { name: 'kept.png', mediaType: 'image/png', data: new Uint8Array([1]) });
    const removed = await attach(id, { name: 'gone.png', mediaType: 'image/png', data: new Uint8Array([2]) });

    await service.send(id, 'look', [kept]);
    await settle();

    await vi.waitUntil(async () => (await attachments.read(id, removed.id)) === null, { timeout: 2000, interval: 5 });
    expect(await attachments.read(id, kept.id)).not.toBeNull();
  });

  it('deletes a conversation attachment bytes and all', async () => {
    const { id } = await service.createSession();
    const image = await attach(id, { name: 'bug.png', mediaType: 'image/png', data: new Uint8Array([1]) });
    await service.send(id, 'look', [image]);
    await settle();

    await service.deleteSession(id);

    expect(await attachments.read(id, image.id)).toBeNull();
  });
});
