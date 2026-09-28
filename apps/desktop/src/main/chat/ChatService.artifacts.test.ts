import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import type { AuthenticatedApiClient } from '@bike4mind/client-auth';
import type { ChatStreamEvent } from '@shared/chat';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ArtifactPublisher } from './artifacts/ArtifactPublisher';
import { ChatService } from './ChatService';
import { SessionStore } from './SessionStore';
import type { AccessStore } from './tools/AccessStore';

function frame(payload: unknown): string {
  return `data: ${typeof payload === 'string' ? payload : JSON.stringify(payload)}\n\n`;
}

function waitFor(events: ChatStreamEvent[], type: ChatStreamEvent['type']): Promise<ChatStreamEvent> {
  return vi.waitUntil(() => events.find(event => event.type === type), { timeout: 2000, interval: 5 });
}

const HTML_ARTIFACT =
  '<artifact identifier="counter" type="text/html" title="Counter">' +
  '<!DOCTYPE html><html><body><button>0</button></body></html>' +
  '</artifact>';

describe('ChatService artifacts', () => {
  let store: SessionStore;
  let service: ChatService;
  let events: ChatStreamEvent[];
  let stream: PassThrough;
  let post: ReturnType<typeof vi.fn>;

  beforeEach(async () => {
    store = new SessionStore(await mkdtemp(join(tmpdir(), 'b4m-artifacts-')), 'test-model');
    events = [];
    stream = new PassThrough();
    // One axios instance serves both the completion stream and the artifact create; they are
    // told apart by endpoint, exactly as they are in the app.
    post = vi.fn().mockImplementation((endpoint: string) => {
      if (endpoint === '/api/artifacts') return Promise.resolve({ status: 201, data: {} });
      return Promise.resolve({ data: stream, status: 200 });
    });

    const apiClient = {
      get: vi.fn().mockResolvedValue({ sseCompletionsUrl: '' }),
      getAxiosInstance: () => ({ post }),
    } as unknown as AuthenticatedApiClient;

    service = new ChatService({
      store,
      access: { list: async () => [] } as unknown as AccessStore,
      logger: { debug: vi.fn(), warn: vi.fn() },
      artifacts: new ArtifactPublisher(() => apiClient, { debug: vi.fn() }),
      getApiClient: () => apiClient,
      getEnvironmentUrl: () => 'http://localhost:3000',
      emit: event => events.push(event),
    });
  });

  /** Runs one turn, feeding the model's reply in as a single content frame. */
  async function reply(text: string): Promise<string> {
    const { id } = await service.createSession();
    await service.send(id, 'build me something');
    await waitFor(events, 'start');
    stream.write(frame({ type: 'content', text, stopReason: 'end_turn' }));
    stream.write(frame('[DONE]'));
    await waitFor(events, 'done');
    return id;
  }

  function createCalls(): Record<string, unknown>[] {
    return post.mock.calls.filter(call => call[0] === '/api/artifacts').map(call => call[1]);
  }

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
    post.mockImplementation((endpoint: string) => {
      if (endpoint === '/api/artifacts') return Promise.reject(new Error('network down'));
      return Promise.resolve({ data: stream, status: 200 });
    });

    const id = await reply(`Here.\n${HTML_ARTIFACT}`);

    const session = await service.getSession(id);
    expect(session?.messages[1].artifacts?.[0]).toMatchObject({
      title: 'Counter',
      content: expect.stringContaining('<button>0</button>'),
      save: { status: 'failed' },
    });
  });

  it('gives the artifact back to the model on the next turn', async () => {
    const id = await reply(`Here.\n${HTML_ARTIFACT}`);

    stream = new PassThrough();
    await service.send(id, 'make the button blue');
    await vi.waitUntil(() => post.mock.calls.filter(call => call[0] !== '/api/artifacts').length === 2, {
      timeout: 2000,
      interval: 5,
    });

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
