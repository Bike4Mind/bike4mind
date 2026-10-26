import { PassThrough } from 'node:stream';
import {
  AxiosError,
  type AxiosAdapter,
  type AxiosInstance,
  type AxiosResponse,
  type InternalAxiosRequestConfig,
} from 'axios';
import {
  AuthenticatedApiClient,
  SessionRevokedError,
  type AuthTokens,
  type RefreshingOAuthClient,
  type TokenStore,
} from '@bike4mind/client-auth';
import { describe, expect, it, vi } from 'vitest';
import { streamCompletion, supportsPromptCache, withCacheBreakpoints } from './completions';
import type { CompletionStreamEvent } from './streamEvents';

/** One SSE frame. The blank-line terminator is what the parser splits on. */
function frame(payload: unknown): string {
  return `data: ${typeof payload === 'string' ? payload : JSON.stringify(payload)}\n\n`;
}

function fakeAxios(stream: PassThrough): { instance: AxiosInstance; post: ReturnType<typeof vi.fn> } {
  const post = vi.fn().mockResolvedValue({ data: stream, status: 200 });
  return { instance: { post } as unknown as AxiosInstance, post };
}

const REQUEST = { model: 'm', messages: [{ role: 'user' as const, content: 'hi' }] };

describe('streamCompletion reasoning effort', () => {
  async function sentOptions(request: Parameters<typeof streamCompletion>[2]): Promise<Record<string, unknown>> {
    const stream = new PassThrough();
    const { instance, post } = fakeAxios(stream);
    const done = streamCompletion(instance, '/c', request, () => undefined);
    stream.end();
    await done;
    return post.mock.calls[0][1].options;
  }

  it('puts the effort under options when one is set', async () => {
    expect(await sentOptions({ ...REQUEST, reasoningEffort: 'low' })).toMatchObject({ reasoningEffort: 'low' });
  });

  it('leaves the field off the payload when none is set', async () => {
    expect(await sentOptions(REQUEST)).not.toHaveProperty('reasoningEffort');
  });
});

describe('streamCompletion', () => {
  it('decodes content frames in order and stops at [DONE]', async () => {
    const stream = new PassThrough();
    const { instance } = fakeAxios(stream);
    const events: CompletionStreamEvent[] = [];

    const done = streamCompletion(instance, '/c', REQUEST, event => events.push(event));

    stream.write(frame({ type: 'meta', requestId: 'r1' }));
    stream.write(frame({ type: 'content', text: 'Hel' }));
    stream.write(frame({ type: 'content', text: 'lo', stopReason: 'end_turn' }));
    stream.write(frame('[DONE]'));
    await done;

    expect(events.map(event => ('text' in event ? event.text : event.type))).toEqual(['meta', 'Hel', 'lo']);
  });

  it('reassembles a frame split across chunk boundaries', async () => {
    const stream = new PassThrough();
    const { instance } = fakeAxios(stream);
    const events: CompletionStreamEvent[] = [];

    const done = streamCompletion(instance, '/c', REQUEST, event => events.push(event));

    const whole = frame({ type: 'content', text: 'split' });
    stream.write(whole.slice(0, 12));
    stream.write(whole.slice(12));
    stream.end();
    await done;

    expect(events).toEqual([{ type: 'content', text: 'split' }]);
  });

  describe('tool arguments split across chunk boundaries', () => {
    // The arguments are JSON inside JSON, so the middle dot is `\\u00b7` on the wire and `\u00b7`
    // once the frame is decoded; both layers must survive a split at any byte.
    const escaped = '{"path":"a.tsx","content":"{x} \\u00b7 {y}"}';
    const raw = '{"path":"a.tsx","content":"{x} \u00b7 {y}"}';

    async function roundTrip(args: string, splitAt: number): Promise<string | undefined> {
      const stream = new PassThrough();
      const { instance } = fakeAxios(stream);
      const events: CompletionStreamEvent[] = [];
      const done = streamCompletion(instance, '/c', REQUEST, event => events.push(event));
      const bytes = Buffer.from(frame({ type: 'tool_use', tools: [{ name: 'file_write', arguments: args, id: 't' }] }));
      stream.write(bytes.subarray(0, splitAt));
      stream.write(bytes.subarray(splitAt));
      stream.end();
      await done;
      const event = events[0];
      return event?.type === 'tool_use' ? event.tools?.[0]?.arguments : undefined;
    }

    it.each([
      ['an escaped middle dot', escaped],
      ['a literal middle dot', raw],
    ])('delivers %s intact at every split position', async (_name, args) => {
      const total = Buffer.byteLength(
        frame({ type: 'tool_use', tools: [{ name: 'file_write', arguments: args, id: 't' }] })
      );
      for (let at = 1; at < total; at += 1) {
        const received = await roundTrip(args, at);
        expect(received, `split at byte ${at}`).toBe(args);
        expect(received).not.toContain('\u0000');
        expect(received).not.toContain('\ufffd');
        expect((JSON.parse(received as string) as { content: string }).content).toBe('{x} \u00b7 {y}');
      }
    });
  });

  it('resolves on socket end without [DONE], so a truncated stream keeps its text', async () => {
    const stream = new PassThrough();
    const { instance } = fakeAxios(stream);
    const events: CompletionStreamEvent[] = [];

    const done = streamCompletion(instance, '/c', REQUEST, event => events.push(event));
    stream.write(frame({ type: 'content', text: 'partial' }));
    stream.end();

    await expect(done).resolves.toBeUndefined();
    expect(events).toHaveLength(1);
  });

  it('rejects with the server message on an in-band error event', async () => {
    const stream = new PassThrough();
    const { instance } = fakeAxios(stream);

    const done = streamCompletion(instance, '/c', REQUEST, () => {});
    stream.write(frame({ type: 'error', message: 'insufficient credits' }));

    await expect(done).rejects.toThrow('insufficient credits');
  });

  it('skips a malformed frame rather than failing the rest of the reply', async () => {
    const stream = new PassThrough();
    const { instance } = fakeAxios(stream);
    const events: CompletionStreamEvent[] = [];

    const done = streamCompletion(instance, '/c', REQUEST, event => events.push(event));
    stream.write('data: {oops\n\n');
    stream.write(frame({ type: 'content', text: 'still here' }));
    stream.write(frame('[DONE]'));
    await done;

    expect(events).toEqual([{ type: 'content', text: 'still here' }]);
  });

  it('treats an abort mid-stream as a normal end, keeping what arrived', async () => {
    const stream = new PassThrough();
    const { instance } = fakeAxios(stream);
    const controller = new AbortController();
    const events: CompletionStreamEvent[] = [];

    const done = streamCompletion(instance, '/c', REQUEST, event => events.push(event), controller.signal);
    stream.write(frame({ type: 'content', text: 'half a th' }));
    // The frame has to be delivered before aborting, or this asserts on an abort that raced
    // the stream's first 'data' event rather than on one that interrupted a live reply.
    await vi.waitUntil(() => events.length === 1, { timeout: 2000, interval: 5 });
    controller.abort();

    await expect(done).resolves.toBeUndefined();
    expect(events).toEqual([{ type: 'content', text: 'half a th' }]);
  });

  it('never opens a request that was aborted before it started', async () => {
    const { instance, post } = fakeAxios(new PassThrough());
    const controller = new AbortController();
    controller.abort();

    await streamCompletion(instance, '/c', REQUEST, () => {}, controller.signal);
    expect(post).not.toHaveBeenCalled();
  });

  it('asks for a stream, declaring no tools when the caller passes none', async () => {
    const stream = new PassThrough();
    const { instance, post } = fakeAxios(stream);

    const done = streamCompletion(instance, '/c', REQUEST, () => {});
    stream.write(frame('[DONE]'));
    await done;

    const [url, body, config] = post.mock.calls[0];
    expect(url).toBe('/c');
    expect(body).toMatchObject({ model: 'm', options: { stream: true, tools: [] } });
    expect(body).not.toHaveProperty('max_tokens');
    expect(body.options).not.toHaveProperty('thinking');
    expect(config.responseType).toBe('stream');
  });

  it('sends an output ceiling as the top-level max_tokens the endpoint normalizes', async () => {
    const stream = new PassThrough();
    const { instance, post } = fakeAxios(stream);

    const done = streamCompletion(instance, '/c', { ...REQUEST, maxTokens: 16_384 }, () => {});
    stream.write(frame('[DONE]'));
    await done;

    expect(post.mock.calls[0][1]).toMatchObject({ max_tokens: 16_384 });
  });

  it('asks for readable reasoning only when told to', async () => {
    const stream = new PassThrough();
    const { instance, post } = fakeAxios(stream);

    const done = streamCompletion(instance, '/c', { ...REQUEST, thinking: true }, () => {});
    stream.write(frame('[DONE]'));
    await done;

    expect(post.mock.calls[0][1].options.thinking).toEqual({ enabled: true });
  });

  it('forwards declared tools in the envelope the endpoint expects', async () => {
    const stream = new PassThrough();
    const { instance, post } = fakeAxios(stream);
    const tools = [{ toolSchema: { name: 'file_read', description: 'x', parameters: { type: 'object' } } }];

    const done = streamCompletion(instance, '/c', { ...REQUEST, tools }, () => {});
    stream.write(frame('[DONE]'));
    await done;

    expect(post.mock.calls[0][1].options.tools).toEqual(tools);
  });

  it('passes structured tool_result content through untouched', async () => {
    const stream = new PassThrough();
    const { instance, post } = fakeAxios(stream);
    const content = [{ type: 'tool_result', tool_use_id: 'c1', content: 'result' }];

    const done = streamCompletion(instance, '/c', { model: 'm', messages: [{ role: 'user', content }] }, () => {});
    stream.write(frame('[DONE]'));
    await done;

    expect(post.mock.calls[0][1].messages[0].content).toEqual(content);
  });

  it("describes a 403 as not allowed, with the server's words, rather than as an expired session", async () => {
    const post = vi.fn().mockRejectedValue(
      Object.assign(new Error('Request failed'), {
        isAxiosError: true,
        response: { status: 403, data: JSON.stringify({ message: 'Model not enabled for this organization' }) },
      })
    );
    const instance = { post } as unknown as AxiosInstance;

    const err = await streamCompletion(instance, '/c', REQUEST, () => {}).catch((caught: Error) => caught);

    expect(err).toBeInstanceOf(Error);
    expect((err as Error).message).toBe('Model not enabled for this organization (status 403)');
  });
});

describe('streamCompletion through the shared authenticated client', () => {
  function unexpired(accessToken: string): AuthTokens {
    return {
      accessToken,
      refreshToken: `refresh-${accessToken}`,
      expiresAt: new Date(Date.now() + 600_000).toISOString(),
      userId: 'user-1',
    };
  }

  /** The desktop's client settings over an in-memory store; `respond` plays the server. */
  function client(respond: (config: InternalAxiosRequestConfig) => Promise<AxiosResponse>) {
    let stored: AuthTokens | null = unexpired('access-0');
    const tokenStore: TokenStore = {
      getAuthTokens: async () => stored,
      setAuthTokens: async next => {
        stored = next;
      },
      clearAuthTokens: async () => {
        stored = null;
      },
      isAuthenticated: async () => stored !== null,
    };
    const refreshToken = vi.fn(async () => ({
      access_token: 'access-1',
      refresh_token: 'refresh-1',
      token_type: 'Bearer',
      expires_in: 1800,
    }));
    const api = new AuthenticatedApiClient({
      baseUrl: 'https://b4m.example.com',
      tokenStore,
      oauthClient: { refreshToken } as unknown as RefreshingOAuthClient,
      logger: { debug: vi.fn(), warn: vi.fn(), error: vi.fn() },
      reauthMessages: { refreshFailed: 'refresh failed', stillUnauthorized: 'still unauthorized' },
      refreshUnexpiredOn401: true,
    });
    const adapter = vi.fn(respond);
    api.getAxiosInstance().defaults.adapter = adapter as unknown as AxiosAdapter;
    return { axios: api.getAxiosInstance(), adapter, refreshToken };
  }

  function sseResponse(config: InternalAxiosRequestConfig, body: string): AxiosResponse {
    const stream = new PassThrough();
    stream.end(body);
    return { data: stream, status: 200, statusText: 'OK', headers: {}, config } as AxiosResponse;
  }

  function unauthorized(config: InternalAxiosRequestConfig): AxiosError {
    const body = new PassThrough();
    body.end('{"error":"Unauthorized"}');
    return new AxiosError('Request failed with status code 401', 'ERR_BAD_REQUEST', config, {}, {
      data: body,
      status: 401,
      statusText: 'Unauthorized',
      headers: {},
      config,
    } as AxiosResponse);
  }

  it('refreshes and retries a 401 that arrives before anything streamed', async () => {
    const { axios, adapter, refreshToken } = client(async config => {
      if (config.headers.Authorization !== 'Bearer access-1') throw unauthorized(config);
      return sseResponse(config, frame({ type: 'content', text: 'hello' }) + frame('[DONE]'));
    });
    const events: CompletionStreamEvent[] = [];

    await streamCompletion(axios, '/c', REQUEST, event => events.push(event));

    expect(refreshToken).toHaveBeenCalledTimes(1);
    expect(adapter).toHaveBeenCalledTimes(2);
    expect(events).toEqual([{ type: 'content', text: 'hello' }]);
  });

  it('does not retry once the reply has started streaming', async () => {
    const { axios, adapter, refreshToken } = client(async config =>
      sseResponse(
        config,
        frame({ type: 'content', text: 'partial' }) + frame({ type: 'error', message: 'Unauthorized' })
      )
    );
    const events: CompletionStreamEvent[] = [];

    await expect(streamCompletion(axios, '/c', REQUEST, event => events.push(event))).rejects.toThrow('Unauthorized');

    expect(events).toEqual([{ type: 'content', text: 'partial' }]);
    expect(adapter).toHaveBeenCalledTimes(1);
    expect(refreshToken).not.toHaveBeenCalled();
  });

  it("passes an unrecoverable session through as the client's own error, not a status line", async () => {
    const { axios, adapter } = client(async config => {
      throw unauthorized(config);
    });

    const err = await streamCompletion(axios, '/c', REQUEST, () => {}).catch((caught: unknown) => caught);

    expect(err).toBeInstanceOf(SessionRevokedError);
    expect(adapter).toHaveBeenCalledTimes(2);
  });
});

describe('withCacheBreakpoints', () => {
  const history = [
    { role: 'system' as const, content: 'sys' },
    { role: 'user' as const, content: 'one' },
    { role: 'assistant' as const, content: [{ type: 'tool_use' }] },
    { role: 'user' as const, content: [{ type: 'tool_result' }] },
  ];

  it('marks the system message and the last message, and nothing between', () => {
    expect(withCacheBreakpoints(history).map(message => message.cache)).toEqual([true, undefined, undefined, true]);
  });

  it('never touches the messages it was given', () => {
    const stamped = withCacheBreakpoints(history);
    expect(history.some(message => 'cache' in message)).toBe(false);
    expect(stamped[3]).not.toBe(history[3]);
    expect(stamped[1]).toBe(history[1]);
  });

  it('moves the rolling breakpoint when the conversation grows', () => {
    const grown = [...history, { role: 'assistant' as const, content: 'two' }, { role: 'user' as const, content: 'x' }];
    const marked = withCacheBreakpoints(grown).flatMap((message, index) => (message.cache ? [index] : []));
    expect(marked).toEqual([0, 5]);
  });

  it('never marks a message that ends on a reasoning block, and moves back to one that can carry it', () => {
    const withThinking = [
      ...history,
      {
        role: 'assistant' as const,
        content: [
          { type: 'text', text: 'hm' },
          { type: 'thinking', thinking: 'x' },
        ],
      },
    ];
    expect(withCacheBreakpoints(withThinking).map(message => message.cache)).toEqual([
      true,
      undefined,
      undefined,
      true,
      undefined,
    ]);
    const redacted = [...history, { role: 'assistant' as const, content: [{ type: 'redacted_thinking', data: 'x' }] }];
    expect(withCacheBreakpoints(redacted).at(-1)?.cache).toBeUndefined();
  });

  it('marks the last text block case: a thinking block earlier in the last message is fine', () => {
    const mixed = [
      ...history,
      {
        role: 'assistant' as const,
        content: [
          { type: 'thinking', thinking: 'x' },
          { type: 'text', text: 'hi' },
        ],
      },
    ];
    expect(withCacheBreakpoints(mixed).at(-1)?.cache).toBe(true);
  });

  it('sends the flag on the wire and nothing for a message without it', async () => {
    const stream = new PassThrough();
    const { instance, post } = fakeAxios(stream);
    const done = streamCompletion(instance, '/c', { model: 'm', messages: withCacheBreakpoints(history) }, () => {});
    stream.write(frame('[DONE]'));
    await done;
    const body = post.mock.calls[0][1] as { messages: { cache?: boolean }[] };
    expect(body.messages.map(message => message.cache)).toEqual([true, undefined, undefined, true]);
  });
});

describe('supportsPromptCache', () => {
  const models = [
    { id: 'a', name: 'A', backend: 'anthropic' },
    { id: 'b', name: 'B', backend: 'bedrock' },
    { id: 'c', name: 'C' },
  ];

  it('is true only for a model the catalog says is served by direct Anthropic', () => {
    expect(supportsPromptCache(models, 'a')).toBe(true);
    expect(supportsPromptCache(models, 'b')).toBe(false);
    expect(supportsPromptCache(models, 'c')).toBe(false);
    expect(supportsPromptCache(models, 'missing')).toBe(false);
    expect(supportsPromptCache([], 'a')).toBe(false);
  });
});
