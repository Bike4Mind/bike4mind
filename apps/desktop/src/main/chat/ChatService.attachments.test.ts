import { mkdtemp, readdir, readFile, realpath, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import type { AuthenticatedApiClient } from '@bike4mind/client-auth';
import type { ChatApprovalMode, ChatArtifact, ChatAttachment, ChatModelOption, ChatStreamEvent } from '@shared/chat';
import { afterEach, beforeEach, describe, expect, it, type Mock, vi } from 'vitest';
import { AttachmentStore } from './AttachmentStore';
import { ChatService } from './ChatService';
import { makePdf } from './pdfFixtures';
import { SessionStore } from './SessionStore';
import { TITLE_INSTRUCTION } from './sessionTitle';
import type { AccessStore } from './tools/AccessStore';
import type { ModelCatalog } from './ModelCatalog';
import { MediaStore } from './media/MediaStore';
import { ApprovalGate } from './tools/ApprovalGate';
import type { ScreenCapturer } from './tools/types';
import { ArtifactPublisher } from './artifacts/ArtifactPublisher';
import { MessageQueue } from './MessageQueue';

vi.mock('../git/hostGitArgs', async importOriginal =>
  (await import('./plainFolderGit.testHelper')).skipGitOutsideRepositories(await importOriginal())
);

function frame(payload: unknown): string {
  return `data: ${typeof payload === 'string' ? payload : JSON.stringify(payload)}\n\n`;
}

function waitFor(events: ChatStreamEvent[], type: ChatStreamEvent['type']): Promise<ChatStreamEvent> {
  return vi.waitUntil(() => events.find(event => event.type === type), { timeout: 2000, interval: 5 });
}

interface WireBody {
  messages: { role: string; content: unknown }[];
}

/**
 * The turn's own request among the calls, rather than whichever went out first.
 *
 * A turn puts out two: the reply, and the request that names the session. They are concurrent
 * by design, so neither is reliably first, and only the leading system turn tells them apart.
 */
function replyCallIndex(post: ReturnType<typeof vi.fn>): number {
  return post.mock.calls.findIndex(call => (call[1] as WireBody).messages[0]?.content !== TITLE_INSTRUCTION);
}

/** The content array of the user turn in the reply request, whatever shape the rest took. */
function userContent(post: ReturnType<typeof vi.fn>): unknown[] {
  const body = post.mock.calls[replyCallIndex(post)][1] as WireBody;
  const turn = body.messages.find(message => message.role === 'user');
  return Array.isArray(turn?.content) ? (turn.content as unknown[]) : [];
}

describe('ChatService attachments', () => {
  let store: SessionStore;
  let attachments: AttachmentStore;
  let service: ChatService;
  let events: ChatStreamEvent[];
  /** One stream per request: a turn now puts two out, the reply and the session's title. */
  let streams: PassThrough[];
  let post: ReturnType<typeof vi.fn>;
  let composerDrafts: { forget: Mock<(sessionId: string) => Promise<void>> };
  let cachedModels: ChatModelOption[];

  beforeEach(async () => {
    const root = await mkdtemp(join(tmpdir(), 'b4m-chat-attach-'));
    store = new SessionStore(join(root, 'sessions'), 'vision-model');
    attachments = new AttachmentStore(join(root, 'attachments'), { debug: vi.fn(), warn: vi.fn() });
    // Bound per test: a previous service replying late must not push into this test's events.
    const emitted: ChatStreamEvent[] = [];
    events = emitted;
    const opened: PassThrough[] = [];
    streams = opened;
    const boundPost = vi.fn().mockImplementation(() => {
      const stream = new PassThrough();
      opened.push(stream);
      return Promise.resolve({ data: stream, status: 200 });
    });
    post = boundPost;
    cachedModels = [{ id: 'vision-model', name: 'Vision Model', supportsVision: true }];

    composerDrafts = { forget: vi.fn<(sessionId: string) => Promise<void>>().mockResolvedValue(undefined) };
    service = new ChatService({
      store,
      attachments,
      composerDrafts,
      access: { list: async () => [] } as unknown as AccessStore,
      models: { cached: () => cachedModels, list: async () => ({ models: cachedModels }) } as unknown as ModelCatalog,
      preferredModel: 'vision-model',
      logger: { debug: vi.fn(), warn: vi.fn() },
      getApiClient: () =>
        ({
          get: vi.fn().mockResolvedValue({ sseCompletionsUrl: '' }),
          getAxiosInstance: () => ({ post: boundPost }),
        }) as unknown as AuthenticatedApiClient,
      getEnvironmentUrl: () => 'http://localhost:3000',
      emit: event => emitted.push(event),
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
    await vi.waitUntil(() => replyCallIndex(post) !== -1, { timeout: 2000, interval: 5 });
    const reply = streams[replyCallIndex(post)];
    reply.write(frame({ type: 'content', text: 'ok', stopReason: 'end_turn' }));
    reply.write(frame('[DONE]'));
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
    expect(content[1]).toMatchObject({
      type: 'text',
      text: expect.stringMatching(
        /^<attached-image-file name="bug\.png" media-type="image\/png" path="[^"]+" \/>\n\nwhat is wrong here\?$/
      ),
    });
    const storedPath = /path="([^"]+)"/.exec((content[1] as { text: string }).text)?.[1] ?? '';
    expect([...(await readFile(storedPath))]).toEqual([1, 2, 3]);
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

  it('inlines a PDF as extracted text with its page count, never as an image block', async () => {
    const { id } = await service.createSession();
    const pdf = await attach(id, {
      name: 'report.pdf',
      mediaType: 'application/pdf',
      data: makePdf(['Revenue grew', 'Costs fell']),
    });
    expect(pdf.kind).toBe('pdf');

    await service.send(id, 'summarise', [pdf]);
    await settle();

    const content = userContent(post) as { type: string; text: string }[];
    expect(content).toHaveLength(1);
    expect(content[0].type).toBe('text');
    expect(content[0].text).toContain('<attached-file name="report.pdf"');
    expect(content[0].text).toContain('pages="2"');
    expect(content[0].text).toContain('Revenue grew');
    expect(content[0].text.endsWith('summarise')).toBe(true);
  });

  it('truncates a long PDF with the same marker a text file gets', async () => {
    const { id } = await service.createSession();
    const pdf = await attach(id, { name: 'big.pdf', data: makePdf([`${'word '.repeat(40)}\n`.repeat(900)]) });
    expect(pdf.truncated).toBe(true);

    await service.send(id, 'read', [pdf]);
    await settle();

    const [block] = userContent(post) as { text: string }[];
    expect(block.text).toContain('truncated="true"');
    expect(block.text).toContain('extracted text. The rest was not sent');
  });

  it('skips a PDF whose bytes are gone', async () => {
    const { id } = await service.createSession();
    const pdf = await attach(id, { name: 'gone.pdf', data: makePdf(['vanishing']) });
    await attachments.discard(id, pdf.id);

    await service.send(id, 'hello', [pdf]);
    await settle();

    const body = post.mock.calls[replyCallIndex(post)][1] as WireBody;
    expect(body.messages.find(message => message.role === 'user')?.content).toBe('hello');
  });

  it('never refuses a PDF over vision', async () => {
    cachedModels = [{ id: 'vision-model', name: 'Blind Model', supportsVision: false }];
    const { id } = await service.createSession();
    const pdf = await attach(id, { name: 'a.pdf', data: makePdf(['text here']) });

    expect(await service.send(id, 'read this', [pdf])).toMatchObject({ ok: true });
    await settle();
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
    streams.length = 0;
    post.mockClear();
    await service.send(id, 'and now?');
    await settle();

    const resent = (post.mock.calls[replyCallIndex(post)][1] as WireBody).messages;
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
    const body = post.mock.calls[replyCallIndex(post)][1] as WireBody;
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

  it('forgets the unsent draft only after the stored conversation is deleted', async () => {
    const { id } = await service.createSession();
    const order: string[] = [];
    const deleteStored = store.delete.bind(store);
    vi.spyOn(store, 'delete').mockImplementation(async (...args) => {
      await deleteStored(...args);
      order.push('store.delete');
    });
    composerDrafts.forget.mockImplementation(async () => void order.push('forget'));

    await service.deleteSession(id);

    expect(composerDrafts.forget).toHaveBeenCalledWith(id);
    expect(order).toEqual(['store.delete', 'forget']);
  });
});

describe('images', () => {
  function frame(payload: unknown): string {
    return `data: ${typeof payload === 'string' ? payload : JSON.stringify(payload)}\n\n`;
  }

  type WireMessage = { role: string; content: unknown };

  const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.from('pixels')]);

  describe('ChatService images shown by tools', () => {
    let service: ChatService;
    let events: ChatStreamEvent[];
    let post: ReturnType<typeof vi.fn>;
    let streams: PassThrough[];
    let root: string;
    let store: SessionStore;
    let media: MediaStore;
    let mediaRoot: string;
    let capture: ReturnType<typeof vi.fn<ScreenCapturer['capture']>>;

    beforeEach(async () => {
      root = await realpath(await mkdtemp(join(tmpdir(), 'b4m-images-')));
      await writeFile(join(root, 'shot.png'), PNG);
      const emitted: ChatStreamEvent[] = [];
      events = emitted;
      const opened: PassThrough[] = [];
      streams = opened;
      post = vi.fn().mockImplementation(() => {
        const stream = new PassThrough();
        opened.push(stream);
        return Promise.resolve({ data: stream, status: 200 });
      });
      const boundPost = post;
      capture = vi.fn<ScreenCapturer['capture']>(async () => PNG);
      const screen: ScreenCapturer = {
        access: () => ({ state: 'granted' }),
        list: async () => [{ id: 'window:7:0', kind: 'window', name: 'My App - Dev' }],
        capture,
      };
      store = new SessionStore(await mkdtemp(join(tmpdir(), 'b4m-images-sessions-')), 'test-model');
      mediaRoot = await mkdtemp(join(tmpdir(), 'b4m-images-media-'));
      media = new MediaStore(mediaRoot);
      service = new ChatService({
        store,
        approvals: new ApprovalGate(),
        access: { list: async () => [root] } as unknown as AccessStore,
        media,
        models: {
          list: async () => ({ models: [{ id: 'test-model', name: 'Test', backend: 'anthropic' }] }),
          cached: () => [],
        } as unknown as ModelCatalog,
        screen,
        prepareImage: (bytes, mediaType) => ({
          bytes,
          mediaType,
          width: 10,
          height: 10,
          sourceWidth: 10,
          sourceHeight: 10,
        }),
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

    afterEach(() => {
      service.dispose();
      for (const stream of streams) stream.end();
    });

    async function codeSession(mode: ChatApprovalMode = 'ask'): Promise<string> {
      const created = await service.createCodeSession({ directory: root, branch: '', workspace: false });
      if (!created.ok) throw new Error(created.error);
      await store.setApprovalMode(created.session.id, mode);
      return created.session.id;
    }

    /** One round calling `tool`, then a plain answer; resolves with the follow-up request's messages. */
    async function toolRound(sessionId: string, name: string, args: Record<string, unknown>): Promise<WireMessage[]> {
      const before = post.mock.calls.length;
      await service.send(sessionId, 'look at it');
      await vi.waitUntil(() => streams.length === before + 1, { timeout: 3000, interval: 5 });
      streams[before].write(
        frame({ type: 'tool_use', tools: [{ id: `${name}_1`, name, arguments: JSON.stringify(args) }] })
      );
      streams[before].write(frame('[DONE]'));
      await vi.waitUntil(() => post.mock.calls.length === before + 2, { timeout: 3000, interval: 5 });
      streams[before + 1].write(frame({ type: 'content', text: 'Seen.' }));
      streams[before + 1].write(frame('[DONE]'));
      await vi.waitUntil(() => events.filter(event => event.type === 'done').length > 0, {
        timeout: 3000,
        interval: 5,
      });
      return post.mock.calls[before + 1][1].messages as WireMessage[];
    }

    it('shows the model a file_read image on the next request only, and never stores it', async () => {
      const id = await codeSession();
      const messages = await toolRound(id, 'file_read', { path: join(root, 'shot.png') });
      expect(messages.at(-1)).toMatchObject({
        role: 'user',
        content: [
          { type: 'text', text: 'Image from the file_read call above.' },
          { type: 'image', source: { type: 'base64', media_type: 'image/png', data: PNG.toString('base64') } },
        ],
      });

      const stored = JSON.stringify(await store.get(id));
      expect(stored).not.toContain(PNG.toString('base64'));
      expect(stored).toContain('is a PNG image');

      events.length = 0;
      await service.send(id, 'and now?');
      await vi.waitUntil(() => post.mock.calls.length === 3, { timeout: 3000, interval: 5 });
      expect(JSON.stringify(post.mock.calls[2][1].messages)).not.toContain('"type":"image"');
    });

    it('keeps a read image on the row once per content, so an overwrite shows on the new row only', async () => {
      const id = await codeSession();
      /** One read round, and the media its call settled with. */
      const readShot = async (args: Record<string, unknown> = {}) => {
        events.length = 0;
        await toolRound(id, 'file_read', { path: join(root, 'shot.png'), ...args });
        const end = events.find(event => event.type === 'tool-end');
        return end && 'call' in end ? end.call.media : undefined;
      };

      const first = await readShot();
      expect(first).toEqual([
        expect.objectContaining({ kind: 'image', caption: join(root, 'shot.png'), width: 10, height: 10 }),
      ]);
      expect((await readShot())?.[0].url).toBe(first?.[0].url);

      await writeFile(join(root, 'shot.png'), Buffer.concat([PNG, Buffer.from('changed')]));
      // `limit` only so the doom-loop guard does not stop a third identical call; an image ignores it.
      const changed = await readShot({ limit: 1 });
      expect(changed?.[0].url).not.toBe(first?.[0].url);

      const stored = await store.get(id);
      const urls = (stored?.messages ?? [])
        .flatMap(message => message.toolCalls ?? [])
        .flatMap(call => call.media ?? [])
        .map(item => item.url);
      expect(urls).toEqual([first?.[0].url, first?.[0].url, changed?.[0].url]);
    });

    it('does not keep an image whose file read finishes after conversation deletion', async () => {
      const id = await codeSession();
      const started = Promise.withResolvers<void>();
      const release = Promise.withResolvers<void>();
      const saveForContent = media.saveForContent.bind(media);
      const keep = vi.spyOn(media, 'saveForContent').mockImplementation(async (...args) => {
        started.resolve();
        await release.promise;
        return saveForContent(...args);
      });
      await service.send(id, 'look at it');
      await vi.waitUntil(() => streams.length === 1, { interval: 5 });
      streams[0].write(
        frame({
          type: 'tool_use',
          tools: [{ id: 'read', name: 'file_read', arguments: JSON.stringify({ path: join(root, 'shot.png') }) }],
        })
      );
      streams[0].write(frame('[DONE]'));
      await started.promise;
      try {
        await service.deleteSession(id);
      } finally {
        release.resolve();
      }
      const attempt = keep.mock.results[0];
      if (attempt.type !== 'return') throw new Error('Image save did not start');
      await expect(attempt.value).rejects.toThrow(/deleted/);
      expect(await readdir(mediaRoot)).toEqual([]);
      expect(await store.get(id)).toBeNull();
    });

    it('caps the images one round sends and tells the model how many were left out', async () => {
      const id = await codeSession('full');
      await service.send(id, 'look at them all');
      await vi.waitUntil(() => streams.length === 1, { timeout: 3000, interval: 5 });
      const tools = Array.from({ length: 10 }, (_, index) => ({
        id: `read_${index}`,
        name: 'file_read',
        arguments: JSON.stringify({ path: join(root, 'shot.png') }),
      }));
      streams[0].write(frame({ type: 'tool_use', tools }));
      streams[0].write(frame('[DONE]'));
      await vi.waitUntil(() => post.mock.calls.length === 2, { timeout: 3000, interval: 5 });
      const turn = (post.mock.calls[1][1].messages as WireMessage[]).at(-1);
      const content = turn?.content as { type: string; text?: string }[];
      expect(content.filter(block => block.type === 'image')).toHaveLength(8);
      expect(content[0].text).toBe(
        "Images from the file_read calls above. 2 more were left out to keep the request under the provider's size limit; read or capture them in smaller batches."
      );
    });

    it('declares screen_capture and tells the model what it is for', async () => {
      const id = await codeSession();
      await service.send(id, 'hi');
      await vi.waitUntil(() => streams.length === 1, { timeout: 3000, interval: 5 });
      const request = post.mock.calls[0][1];
      const names = request.options.tools.map((entry: { toolSchema: { name: string } }) => entry.toolSchema.name);
      expect(names).toContain('screen_capture');
      expect(request.messages[0].content).toContain('screen_capture looks at other apps');
      expect(request.messages[0].content).toContain('PNG, JPEG, GIF or WebP file as an image');
    });

    it('captures unasked in full access, and shows the capture to both the model and the user', async () => {
      const id = await codeSession('full');
      const messages = await toolRound(id, 'screen_capture', { target: 'My App' });
      expect(capture).toHaveBeenCalledWith('window:7:0', 1568);
      expect(JSON.stringify(messages.at(-1))).toContain('Image from the screen_capture call above.');
      const end = events.find(event => event.type === 'tool-end');
      expect(end && 'call' in end ? end.call.media?.[0] : undefined).toMatchObject({ kind: 'image' });
    });

    it('asks before a capture in auto mode', async () => {
      const id = await codeSession('auto');
      await service.send(id, 'look at it');
      await vi.waitUntil(() => streams.length === 1, { timeout: 3000, interval: 5 });
      streams[0].write(
        frame({ type: 'tool_use', tools: [{ id: 'cap_1', name: 'screen_capture', arguments: '{"target":"My App"}' }] })
      );
      streams[0].write(frame('[DONE]'));
      await vi.waitUntil(
        () => events.some(event => event.type === 'tool-start' && event.call.status === 'awaiting-approval'),
        { timeout: 3000, interval: 5 }
      );
      expect(capture).not.toHaveBeenCalled();
    });
  });
});

describe('artifacts', () => {
  function frame(payload: unknown): string {
    return `data: ${typeof payload === 'string' ? payload : JSON.stringify(payload)}\n\n`;
  }

  function waitFor(events: ChatStreamEvent[], type: ChatStreamEvent['type']): Promise<ChatStreamEvent> {
    return vi.waitUntil(() => events.find(event => event.type === type), { timeout: 5000, interval: 5 });
  }

  const HTML_ARTIFACT =
    '<artifact identifier="counter" type="text/html" title="Counter">' +
    '<!DOCTYPE html><html><body><button>0</button></body></html>' +
    '</artifact>';

  const cleanups: (() => void)[] = [];

  async function createFixture() {
    const store = new SessionStore(await mkdtemp(join(tmpdir(), 'b4m-artifacts-')), 'test-model');
    const events: ChatStreamEvent[] = [];
    const streams: PassThrough[] = [];
    const responses: PassThrough[] = [];
    function enqueueResponse() {
      const response = new PassThrough();
      streams.push(response);
      responses.push(response);
      return response;
    }
    const initialStream = enqueueResponse();
    const artifactSave = { reject: false };
    const post = vi.fn().mockImplementation((endpoint: string) => {
      if (endpoint === '/api/artifacts') {
        return artifactSave.reject
          ? Promise.reject(new Error('network down'))
          : Promise.resolve({ status: 201, data: {} });
      }
      const response = responses.shift();
      if (!response) throw new Error('No completion response configured for this fixture');
      return Promise.resolve({ data: response, status: 200 });
    });
    const get = vi.fn(async () => ({ sseCompletionsUrl: '' }));
    const refreshArtifacts = vi.fn<(sessionId: string, artifacts: readonly ChatArtifact[]) => void>();
    const apiClient = {
      get,
      getAxiosInstance: () => ({ post }),
    } as unknown as AuthenticatedApiClient;
    const service = new ChatService({
      store,
      access: { list: async () => [] } as unknown as AccessStore,
      logger: { debug: vi.fn(), warn: vi.fn() },
      queue: new MessageQueue(() => undefined),
      artifacts: new ArtifactPublisher(() => apiClient, { debug: vi.fn() }),
      browser: { context: vi.fn(), closeSession: vi.fn(async () => undefined), refreshArtifacts },
      getApiClient: () => apiClient,
      getEnvironmentUrl: () => 'http://localhost:3000',
      emit: event => events.push(event),
    });
    cleanups.push(() => {
      service.dispose();
      for (const response of streams) response.destroy();
    });
    return {
      service,
      store,
      events,
      stream: initialStream,
      post,
      get,
      refreshArtifacts,
      artifactSave,
      enqueueResponse,
    };
  }

  type Fixture = Awaited<ReturnType<typeof createFixture>>;
  let fixture: Fixture;

  async function waitForRequest(target: Fixture, count = 1) {
    await vi.waitUntil(() => target.post.mock.calls.filter(call => call[0] !== '/api/artifacts').length === count, {
      timeout: 5000,
      interval: 5,
    });
  }

  describe('ChatService artifacts', () => {
    let service: ChatService;
    let events: ChatStreamEvent[];
    let post: ReturnType<typeof vi.fn>;
    let refreshArtifacts: Fixture['refreshArtifacts'];
    let store: SessionStore;
    let stream: PassThrough;

    beforeEach(async () => {
      fixture = await createFixture();
      service = fixture.service;
      events = fixture.events;
      post = fixture.post;
      refreshArtifacts = fixture.refreshArtifacts;
      store = fixture.store;
      stream = fixture.stream;
    });
    afterEach(() => {
      for (const cleanup of cleanups.splice(0)) cleanup();
    });

    /** Runs one turn, feeding the model's reply in as a single content frame. */
    async function reply(text: string, target = fixture): Promise<string> {
      const { id } = await target.service.createSession();
      await target.service.send(id, 'build me something');
      await waitFor(target.events, 'start');
      await waitForRequest(target);
      target.stream.write(frame({ type: 'content', text, stopReason: 'end_turn' }));
      target.stream.write(frame('[DONE]'));
      await waitFor(target.events, 'done');
      return id;
    }

    function createCalls(): Record<string, unknown>[] {
      return post.mock.calls.filter(call => call[0] === '/api/artifacts').map(call => call[1]);
    }

    it('keeps a delayed prior turn bound to its own response when another fixture starts', async () => {
      const prior = fixture;
      const configuration = Promise.withResolvers<{ sseCompletionsUrl: string }>();
      prior.get.mockReturnValue(configuration.promise);
      const { id } = await prior.service.createSession();
      await prior.service.send(id, 'prior turn');
      await waitFor(prior.events, 'start');
      const next = await createFixture();
      // Simulate the next beforeEach while the prior request is still in preflight.
      fixture = next;
      configuration.resolve({ sseCompletionsUrl: '' });
      await waitForRequest(prior);
      const result = prior.post.mock.results[0];
      if (result?.type !== 'return') throw new Error('Prior completion POST did not return a response');
      expect((await result.value).data).toBe(prior.stream);
      prior.stream.write(frame({ type: 'content', text: 'PRIOR_REPLY', stopReason: 'end_turn' }));
      prior.stream.write(frame('[DONE]'));
      await waitFor(prior.events, 'done');
      expect(prior.events.find(event => event.type === 'done')).toMatchObject({ content: 'PRIOR_REPLY' });
      expect(next.events).toEqual([]);
      expect(next.stream.destroyed).toBe(false);
    });

    it('leaves a reply with no artifact alone and posts nothing', async () => {
      const id = await reply('Here is the answer, in prose.');

      const done = events.find(event => event.type === 'done');
      expect(done).toMatchObject({ content: 'Here is the answer, in prose.' });
      expect(done).not.toHaveProperty('artifacts');
      expect(createCalls()).toEqual([]);

      const session = await service.getSession(id);
      expect(session?.messages[1].artifacts).toBeUndefined();
    });

    it('shows the artifact as a card and the prose without its markup', async () => {
      const id = await reply(`Here you go.\n${HTML_ARTIFACT}\nSay if you want it styled.`);

      const done = events.find(event => event.type === 'done');
      expect(done).toMatchObject({ content: 'Here you go.\n\nSay if you want it styled.' });
      // The markup must not survive into the text, or the transcript shows it raw.
      expect((done as { content: string }).content).not.toContain('<artifact');

      const session = await service.getSession(id);
      expect(session?.messages[1].artifacts).toMatchObject([
        { type: 'html', title: 'Counter', identifier: 'counter', save: { status: 'saved' } },
      ]);
    });

    it("hands the reply's artifacts to the browser, so a tab still showing one reloads", async () => {
      const id = await reply(`Here.\n${HTML_ARTIFACT}`);

      expect(refreshArtifacts).toHaveBeenCalledTimes(1);
      expect(refreshArtifacts).toHaveBeenCalledWith(id, [
        expect.objectContaining({
          identifier: 'counter',
          type: 'html',
          content: expect.stringContaining('<button>0</button>'),
        }),
      ]);
    });

    it('tells the browser nothing for a reply with no artifact', async () => {
      await reply('Just prose.');

      expect(refreshArtifacts).not.toHaveBeenCalled();
    });

    it('persists every artifact of a reply that emits several, in order', async () => {
      await reply(
        'Two of them.\n' +
          '<artifact identifier="one" type="text/html" title="First">a</artifact>\n' +
          '<artifact identifier="two" type="application/vnd.ant.python" title="Second">b</artifact>'
      );

      expect(createCalls().map(payload => [payload.type, payload.title])).toEqual([
        ['html', 'First'],
        ['python', 'Second'],
      ]);
    });

    it('keeps the artifact locally when the server refuses to store it', async () => {
      fixture.artifactSave.reject = true;

      const id = await reply(`Here.\n${HTML_ARTIFACT}`);

      const session = await service.getSession(id);
      expect(session?.messages[1].artifacts?.[0]).toMatchObject({
        title: 'Counter',
        content: expect.stringContaining('<button>0</button>'),
        save: { status: 'failed' },
      });
    });

    // Only Date is faked: every wait below is moved by advancing the clock, never by real time.
    describe("a reply's total time", () => {
      const UPLOAD_MS = 400;
      const ARRIVAL_WAIT_MS = 500;
      const TOOL_MS = 100;
      const advance = (ms: number) => vi.setSystemTime(Date.now() + ms);
      const tool = (id: string) =>
        frame({ type: 'tool_use', tools: [{ id, name: 'glob_files', arguments: '{"pattern":"*"}' }] });

      beforeEach(() => {
        vi.useFakeTimers({ toFake: ['Date'], now: Date.UTC(2026, 10, 2) });
      });

      afterEach(() => {
        vi.useRealTimers();
        vi.restoreAllMocks();
      });

      const slowUpload = () =>
        post.mockImplementation((endpoint: string) => {
          if (endpoint !== '/api/artifacts') return Promise.resolve({ data: stream, status: 200 });
          advance(UPLOAD_MS);
          return Promise.resolve({ status: 201, data: {} });
        });

      const spyOnWaits = (arrivalWaitMs = ARRIVAL_WAIT_MS) => {
        const proto = ChatService.prototype as unknown as Record<
          'runTools' | 'takeArrivals',
          (...a: unknown[]) => unknown
        >;
        const runTools = proto.runTools;
        const takeArrivals = proto.takeArrivals;
        vi.spyOn(proto, 'runTools').mockImplementation(function (this: unknown, ...args: unknown[]) {
          advance(TOOL_MS);
          return runTools.apply(this, args);
        });
        vi.spyOn(proto, 'takeArrivals').mockImplementation(function (this: unknown, ...args: unknown[]) {
          advance(arrivalWaitMs);
          return takeArrivals.apply(this, args);
        });
      };

      // Polls on the real clock: vi.waitUntil moves a faked Date forward as it waits.
      const until = async (check: () => boolean) => {
        for (let attempt = 0; attempt < 400 && !check(); attempt++)
          await new Promise(resolve => setTimeout(resolve, 5));
        expect(check()).toBe(true);
      };
      const completions = () => post.mock.calls.filter(call => call[0] !== '/api/artifacts').length;
      const ended = (type: 'done' | 'error') => events.filter(event => event.type === type).length;

      const replies = async (id: string) =>
        ((await service.getSession(id))?.messages ?? []).filter(message => message.role === 'assistant');

      it('leaves the artifact upload out', async () => {
        slowUpload();
        const { id } = await service.createSession();
        await service.send(id, 'build me something');
        await until(() => completions() === 1);
        advance(50);
        stream.write(frame({ type: 'content', text: `Here.\n${HTML_ARTIFACT}`, stopReason: 'end_turn' }));
        stream.write(frame('[DONE]'));
        await until(() => ended('done') === 1);

        expect(createCalls()).toHaveLength(1);
        expect((await replies(id))[0].stats?.totalMs).toBe(50);
      });

      it('adds a continued run to the earlier total and leaves its artifact upload out', async () => {
        slowUpload();
        const { id } = await service.createSession();
        await store.appendMessage(id, { id: 'u1', role: 'user', content: 'go', createdAt: new Date().toISOString() });
        await store.appendMessage(id, {
          id: 'a1',
          role: 'assistant',
          content: 'partway',
          createdAt: new Date().toISOString(),
          stopReason: 'tool_turn_limit',
          stats: { totalMs: 8_000, modelMs: 3_000, toolMs: 5_000 },
        });

        expect(await service.continueReply(id)).toMatchObject({ ok: true });
        await until(() => completions() === 1);
        advance(70);
        stream.write(frame({ type: 'content', text: `More.\n${HTML_ARTIFACT}`, stopReason: 'end_turn' }));
        stream.write(frame('[DONE]'));
        await until(() => ended('done') === 1);

        expect(createCalls()).toHaveLength(1);
        expect((await replies(id))[0].stats).toMatchObject({ totalMs: 8_070, modelMs: 3_070, toolMs: 5_000 });
      });

      it('leaves the wait for a mid-turn message out of both replies it splits', async () => {
        spyOnWaits();
        const { id } = await service.createSession();
        await service.send(id, 'list');
        await until(() => completions() === 1);
        expect(await service.send(id, 'and the hidden ones?')).toMatchObject({ ok: true, queued: true });
        advance(20);
        const second = fixture.enqueueResponse();
        stream.write(tool('c1'));
        stream.write(frame('[DONE]'));
        await until(() => completions() === 2);
        advance(30);
        second.write(frame({ type: 'content', text: 'none', stopReason: 'end_turn' }));
        second.write(frame('[DONE]'));
        await until(() => ended('done') === 2);

        const [first, next] = await replies(id);
        expect(first.stats).toMatchObject({ totalMs: 20 + TOOL_MS, modelMs: 20, toolMs: TOOL_MS });
        expect(next.stats).toMatchObject({ totalMs: 30, modelMs: 30, toolMs: 0 });
      });

      it('ends a failed reply at the time of the failure', async () => {
        spyOnWaits(0);
        const FAILURE_AFTER_MS = 300;
        let requests = 0;
        post.mockImplementation(() => {
          requests++;
          if (requests === 1) return Promise.resolve({ data: stream, status: 200 });
          advance(FAILURE_AFTER_MS);
          return Promise.reject(new Error('network down'));
        });
        const { id } = await service.createSession();
        await service.send(id, 'list');
        await until(() => requests === 1);
        advance(20);
        stream.write(tool('c1'));
        stream.write(frame('[DONE]'));
        await until(() => ended('error') === 1);

        expect((await replies(id))[0].stats).toMatchObject({
          totalMs: 20 + TOOL_MS + FAILURE_AFTER_MS,
          toolMs: TOOL_MS,
        });
      });
    });

    it('gives the artifact back to the model on the next turn', async () => {
      const id = await reply(`Here.\n${HTML_ARTIFACT}`);

      fixture.enqueueResponse();
      await service.send(id, 'make the button blue');
      await waitForRequest(fixture, 2);

      const secondRequest = post.mock.calls.filter(call => call[0] !== '/api/artifacts')[1][1];
      const assistantTurn = secondRequest.messages.find(
        (message: { role: string }) => message.role === 'assistant'
      ) as {
        content: string;
      };

      // Stripped from storage, restored on the wire: without this the model is asked to recolour
      // a button it can no longer see.
      expect(assistantTurn.content).toContain('<artifact');
      expect(assistantTurn.content).toContain('<button>0</button>');
      expect(assistantTurn.content).toContain('identifier="counter"');
    });

    it('asks the model for artifacts at all, which nothing on this path does otherwise', async () => {
      // The completions endpoint assembles no prompt (executeCompletion forwards the messages
      // as given), so if this preamble stops carrying the instruction no artifact is ever emitted.
      await reply('done');

      const systemMessage = post.mock.calls.filter(call => call[0] !== '/api/artifacts')[0][1].messages[0];
      expect(systemMessage.role).toBe('system');
      expect(systemMessage.content).toContain('<artifact');
      expect(systemMessage.content).toContain('text/html');
    });
  });
});
