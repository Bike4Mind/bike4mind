import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import type { AuthenticatedApiClient } from '@bike4mind/client-auth';
import type { ChatModelOption, ChatSessionSummary } from '@shared/chat';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ChatService } from './ChatService';
import type { ModelCatalog } from './ModelCatalog';
import { deriveTitle, SessionStore } from './SessionStore';
import { TITLE_INSTRUCTION, TITLE_MODELS } from './sessionTitle';
import type { AccessStore } from './tools/AccessStore';

const SESSION_MODEL = 'claude-opus-4-5-20251101';
const TITLE_MODEL = TITLE_MODELS[0];

const CATALOG: ChatModelOption[] = [
  { id: SESSION_MODEL, name: 'Claude 4.5 Opus' },
  { id: TITLE_MODEL, name: 'Claude 4.5 Haiku' },
];

function frame(payload: unknown): string {
  return `data: ${typeof payload === 'string' ? payload : JSON.stringify(payload)}\n\n`;
}

/** What the title request looks like on the wire: the small model, and no transcript. */
type WireRequest = { model: string; messages: { role: string; content: unknown }[]; options: { tools: unknown[] } };

describe('ChatService session titles', () => {
  let store: SessionStore;
  let service: ChatService;
  let available: ChatModelOption[];
  let summaries: ChatSessionSummary[];
  /** One stream per request, so the reply and the title are answered independently. */
  let streams: PassThrough[];
  let post: ReturnType<typeof vi.fn>;
  let applied: ReturnType<typeof vi.fn<(summary: ChatSessionSummary | null) => void>>;

  const titleCall = (): [string, WireRequest] | undefined =>
    post.mock.calls.find(call => (call[1] as WireRequest).model === TITLE_MODEL) as [string, WireRequest] | undefined;

  /** The turn's own request. The two are concurrent by design, so neither is reliably first. */
  const replyIndex = (): number =>
    post.mock.calls.findIndex(call => (call[1] as WireRequest).messages[0]?.content !== TITLE_INSTRUCTION);

  /** The stream the title request was handed, once it has gone out. */
  async function titleStream(): Promise<PassThrough> {
    await vi.waitUntil(() => titleCall() !== undefined, { timeout: 5000, interval: 5 });
    return streams[post.mock.calls.findIndex(call => (call[1] as WireRequest).model === TITLE_MODEL)];
  }

  beforeEach(async () => {
    store = new SessionStore(await mkdtemp(join(tmpdir(), 'b4m-title-')), SESSION_MODEL);
    // The end of the title path, spied on so a test can wait for it rather than for a timeout:
    // most of what these cases assert is that NOTHING changed, which no push announces.
    const applyGeneratedTitle = store.applyGeneratedTitle.bind(store);
    applied = vi.fn<(summary: ChatSessionSummary | null) => void>();
    vi.spyOn(store, 'applyGeneratedTitle').mockImplementation(async (id, title) => {
      const result = await applyGeneratedTitle(id, title);
      applied(result);
      return result;
    });
    available = CATALOG;
    summaries = [];
    streams = [];
    post = vi.fn().mockImplementation(() => {
      const stream = new PassThrough();
      streams.push(stream);
      return Promise.resolve({ data: stream, status: 200 });
    });

    service = new ChatService({
      store,
      access: { list: async () => [] } as unknown as AccessStore,
      models: { list: async () => ({ models: available }), cached: () => available } as unknown as ModelCatalog,
      preferredModel: SESSION_MODEL,
      logger: { debug: vi.fn(), warn: vi.fn() },
      getApiClient: () =>
        ({
          get: async () => ({ sseCompletionsUrl: '' }),
          getAxiosInstance: () => ({ post }),
        }) as unknown as AuthenticatedApiClient,
      getEnvironmentUrl: () => 'http://localhost:3000',
      emit: () => {},
      summaryChanged: summary => summaries.push(summary),
    });
  });

  async function answerTitle(text: string): Promise<void> {
    const stream = await titleStream();
    stream.write(frame({ type: 'content', text }));
    stream.write(frame('[DONE]'));
  }

  it('names the session from its first prompt, and tells the sidebar', async () => {
    const { id } = await service.createSession();
    await service.send(id, 'In my shared folder, read alpha.txt and tell me what it says');

    await answerTitle('Reading alpha.txt');

    await vi.waitUntil(() => summaries.length > 0, { timeout: 5000, interval: 5 });
    expect(summaries[0]).toMatchObject({ id, title: 'Reading alpha.txt' });
    expect((await service.getSession(id))?.title).toBe('Reading alpha.txt');
  });

  // The property that matters: a reply runs to completion while the title request is still
  // unanswered. Nothing about the turn waits on naming the row.
  it('does not hold up the reply', async () => {
    const { id } = await service.createSession();
    expect(await service.send(id, 'explain event loops')).toMatchObject({ ok: true });

    const title = await titleStream();
    const reply = streams[replyIndex()];
    reply.write(frame({ type: 'content', text: 'An event loop', stopReason: 'end_turn' }));
    reply.write(frame('[DONE]'));

    await vi.waitUntil(async () => (await service.getSession(id))?.messages.length === 2, {
      timeout: 5000,
      interval: 5,
    });
    expect(title.writableEnded).toBe(false);
    expect((await service.getSession(id))?.title).toBe('explain event loops');
  });

  it('sends the prompt alone on the cheap model - no transcript, no tools', async () => {
    const { id } = await service.createSession();
    await service.send(id, 'explain event loops');

    const request = (await vi.waitUntil(titleCall, { timeout: 5000, interval: 5 }))[1];

    expect(request.model).toBe(TITLE_MODEL);
    expect(request.options.tools).toEqual([]);
    expect(request.messages.map(message => message.role)).toEqual(['system', 'user']);
    expect(request.messages[1].content).toBe('explain event loops');
  });

  it('titles a session only once, not on every turn', async () => {
    const { id } = await service.createSession();
    await service.send(id, 'first');
    await answerTitle('The first thing');
    await vi.waitUntil(() => summaries.length > 0, { timeout: 5000, interval: 5 });

    streams[replyIndex()].write(frame({ type: 'content', text: 'ok' }));
    streams[replyIndex()].write(frame('[DONE]'));
    await vi.waitUntil(async () => (await service.getSession(id))?.messages.length === 2, {
      timeout: 5000,
      interval: 5,
    });

    const before = post.mock.calls.length;
    await service.send(id, 'second');
    await vi.waitUntil(() => post.mock.calls.length > before, { timeout: 5000, interval: 5 });

    expect(post.mock.calls.slice(before).some(call => (call[1] as WireRequest).model === TITLE_MODEL)).toBe(false);
  });

  // The two paths that break quietly: generation fails, and the user renames mid-flight.
  it('keeps the truncated title when the title request fails', async () => {
    const prompt = 'Run the shell command echo hello-from-a-very-long-prompt please';
    const { id } = await service.createSession();
    await service.send(id, prompt);

    const stream = await titleStream();
    stream.destroy(new Error('socket hung up'));

    // Nothing reaches the sidebar and nothing reaches the conversation: a title that could not
    // be generated is cosmetic.
    await vi.waitUntil(() => stream.destroyed, { timeout: 5000, interval: 5 });
    expect(summaries).toEqual([]);
    expect((await service.getSession(id))?.title).toBe(deriveTitle(prompt));
  });

  it('keeps the truncated title when the model answers instead of naming', async () => {
    const { id } = await service.createSession();
    await service.send(id, 'what is a monad');

    const stream = await titleStream();
    await answerTitle(`I'd be happy to explain. ${'A monad is a monoid in the category of endofunctors. '.repeat(3)}`);

    // Rejected before the store is even asked: an answer is not a title.
    await vi.waitUntil(() => stream.destroyed, { timeout: 5000, interval: 5 });
    expect(applied).not.toHaveBeenCalled();
    expect(summaries).toEqual([]);
    expect((await service.getSession(id))?.title).toBe('what is a monad');
  });

  it('lets a rename made while the request was in flight win', async () => {
    const { id } = await service.createSession();
    await service.send(id, 'what is a monad');
    await vi.waitUntil(() => titleCall() !== undefined, { timeout: 5000, interval: 5 });

    await service.renameSession(id, 'Category theory reading');
    await answerTitle('Understanding monads');

    // The store was asked and refused, which is the guard working rather than the request
    // simply never arriving.
    await vi.waitUntil(() => applied.mock.calls.length > 0, { timeout: 5000, interval: 5 });
    expect(applied).toHaveBeenCalledWith(null);
    expect(summaries).toEqual([]);
    expect((await service.getSession(id))?.title).toBe('Category theory reading');
  });

  // An unreadable catalog is not evidence about what the server offers, and the session's own
  // model could be the most expensive thing on it.
  it('does not generate a title when the catalog is unreadable', async () => {
    available = [];
    const { id } = await service.createSession();
    await service.send(id, 'what is a monad');

    await new Promise(resolve => setTimeout(resolve, 20));
    expect(titleCall()).toBeUndefined();
    expect((await service.getSession(id))?.title).toBe('what is a monad');
  });

  // A session the agent named at spawn time never pays for a title it would not be allowed to use.
  it('does not generate a title for a session that was already named', async () => {
    const { id } = await service.createSession();
    await service.renameSession(id, 'Named up front');
    await service.send(id, 'what is a monad');

    await new Promise(resolve => setTimeout(resolve, 20));
    expect(titleCall()).toBeUndefined();
    expect((await service.getSession(id))?.title).toBe('Named up front');
  });
});
