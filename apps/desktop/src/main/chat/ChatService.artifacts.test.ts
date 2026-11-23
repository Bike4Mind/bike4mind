import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import type { AuthenticatedApiClient } from '@bike4mind/client-auth';
import type { ChatArtifact, ChatStreamEvent } from '@shared/chat';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ArtifactPublisher } from './artifacts/ArtifactPublisher';
import { ChatService } from './ChatService';
import { MessageQueue } from './MessageQueue';
import { SessionStore } from './SessionStore';
import type { AccessStore } from './tools/AccessStore';

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
  return { service, store, events, stream: initialStream, post, get, refreshArtifacts, artifactSave, enqueueResponse };
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
      for (let attempt = 0; attempt < 400 && !check(); attempt++) await new Promise(resolve => setTimeout(resolve, 5));
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

      expect((await replies(id))[0].stats).toMatchObject({ totalMs: 20 + TOOL_MS + FAILURE_AFTER_MS, toolMs: TOOL_MS });
    });
  });

  it('gives the artifact back to the model on the next turn', async () => {
    const id = await reply(`Here.\n${HTML_ARTIFACT}`);

    fixture.enqueueResponse();
    await service.send(id, 'make the button blue');
    await waitForRequest(fixture, 2);

    const secondRequest = post.mock.calls.filter(call => call[0] !== '/api/artifacts')[1][1];
    const assistantTurn = secondRequest.messages.find((message: { role: string }) => message.role === 'assistant') as {
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
