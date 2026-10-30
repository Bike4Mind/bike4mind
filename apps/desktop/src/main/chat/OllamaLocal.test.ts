import { afterEach, describe, expect, it, vi } from 'vitest';
import type { HardwareProfile, ModelArch } from '@bike4mind/common';
import { AUTO_LOCAL_CONTEXT, type LocalContextSetting } from '@shared/localContextSetting';
import type { CompletionMessage } from './completions';
import type { CompletionStreamEvent } from './streamEvents';
import { cpuMachine, discreteMachine, GIB, lowConfidenceMachine, stubArch, unifiedMachine } from './fitStub.testHelper';
import type { LocalModelFootprint } from './localContext';
import { HardwareProbe, localContextSizing } from './localContextSizing';
import { forgetLocalContexts, OllamaLocal, type LocalContextSizing } from './OllamaLocal';
import { createThinkFilter } from './thinkFilter';
import { ServerCredentialsError } from '../modelServers/errors';

vi.mock('@bike4mind/common', async importOriginal => ({
  ...(await importOriginal<typeof import('@bike4mind/common')>()),
  estimateFit: (await import('./fitStub.testHelper')).stubEstimateFit,
}));

describe('OllamaLocal', () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
    forgetLocalContexts();
  });

  it.each(['gpt-4', 'local:lmstudio:x', 'local:', 'local:ollama', 'local:ollama:', 'local::x'])(
    'rejects unsupported or malformed model id %s before network I/O',
    async model => {
      const fetchMock = vi.fn();
      vi.stubGlobal('fetch', fetchMock);

      await expect(new OllamaLocal().stream({ model, messages: [] }, () => undefined)).rejects.toThrow(
        'Invalid local model id.'
      );
      expect(fetchMock).not.toHaveBeenCalled();
    }
  );

  it('discovers localhost models with namespaced ids and reported capabilities', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: unknown) => {
        const url = String(input);
        return new Response(
          JSON.stringify(
            url.endsWith('/api/tags')
              ? { models: [{ name: 'qwen3:8b' }] }
              : { capabilities: ['completion', 'tools', 'thinking'], model_info: { 'qwen.context_length': 32768 } }
          ),
          { status: 200, headers: { 'content-type': 'application/json' } }
        );
      })
    );
    const models = await new OllamaLocal().models();
    expect(models).toEqual([
      expect.objectContaining({
        id: 'local:ollama:qwen3:8b',
        supportsTools: true,
        thinkingToggle: true,
        contextWindow: 16384,
      }),
    ]);
    expect(vi.mocked(fetch).mock.calls.every(([input]) => String(input).startsWith('http://127.0.0.1:11434/'))).toBe(
      true
    );
  });

  it.each([
    { info: {}, parameters: undefined, expected: 16384 },
    { info: { 'llama.context_length': 32768 }, parameters: undefined, expected: 16384 },
    { info: { 'llama.context_length': 2048 }, parameters: undefined, expected: 2048 },
    { info: { 'llama.context_length': -1 }, parameters: undefined, expected: 16384 },
    { info: { 'llama.context_length': '32768' }, parameters: undefined, expected: 16384 },
    { info: { 'llama.context_length': 32768 }, parameters: 'num_ctx 8192', expected: 16384 },
    // Without a memory estimate a larger Modelfile num_ctx cannot be shown to fit, so Auto keeps 16K.
    { info: { 'llama.context_length': 131072 }, parameters: 'num_ctx 32768', expected: 16384 },
    { info: { 'llama.context_length': 2048 }, parameters: 'num_ctx 8192', expected: 2048 },
    { info: {}, parameters: 'temperature 0.7\nnum_ctx 65536\n', expected: 16384 },
    ...['0', '-1', 'Infinity', 'NaN', '1.5', 'invalid'].map(value => ({
      info: {},
      parameters: `num_ctx ${value}`,
      expected: 16384,
    })),
  ])('uses the same effective context for discovery and inference: %j', async ({ info, parameters, expected }) => {
    const fetchMock = vi.fn(async (input: unknown, _init?: RequestInit) => {
      if (String(input).endsWith('/api/tags')) return Response.json({ models: [{ name: 'llama' }] });
      if (String(input).endsWith('/api/show'))
        return Response.json({ capabilities: ['completion'], model_info: info, parameters });
      return new Response(`${JSON.stringify({ done: true })}\n`);
    });
    vi.stubGlobal('fetch', fetchMock);
    const local = new OllamaLocal();
    expect((await local.models())[0].contextWindow).toBe(expected);
    await local.stream({ model: 'local:ollama:llama', messages: [] }, () => undefined);
    const sent = JSON.parse(String(fetchMock.mock.calls.at(-1)?.[1]?.body)) as { options: { num_ctx: number } };
    expect(sent.options.num_ctx).toBe(expected);
  });

  it('hides the provider when discovery times out or is unavailable', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(
        (_input: unknown, init?: RequestInit) =>
          new Promise((_resolve, reject) => {
            init?.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')));
          })
      )
    );
    vi.useFakeTimers();
    const pending = new OllamaLocal().models();
    await vi.advanceTimersByTimeAsync(1_001);
    await expect(pending).resolves.toEqual([]);
  });

  it.each([true, false])('omits thinking %s when the fresh inspection reports a plain model', async thinking => {
    const fetchMock = vi.fn(async (input: unknown, _init?: RequestInit) =>
      String(input).endsWith('/api/show')
        ? Response.json({ capabilities: ['completion'] })
        : new Response(`${JSON.stringify({ done: true })}\n`)
    );
    vi.stubGlobal('fetch', fetchMock);
    await new OllamaLocal().stream(
      { model: 'local:ollama:llama3.2', messages: [{ role: 'user', content: 'hi' }], thinking },
      () => undefined
    );
    const sent = JSON.parse(String(fetchMock.mock.calls[1][1]?.body)) as Record<string, unknown>;
    expect(sent).not.toHaveProperty('think');
  });

  it('streams a plain offline answer', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: unknown) =>
        String(input).endsWith('/api/show')
          ? Response.json({ capabilities: ['completion'] })
          : new Response(
              `${JSON.stringify({ message: { content: 'hello' }, done: false })}\n${JSON.stringify({ message: {}, done: true, done_reason: 'stop' })}\n`,
              { status: 200 }
            )
      )
    );
    const events: unknown[] = [];
    await new OllamaLocal().stream(
      { model: 'local:ollama:llama', messages: [{ role: 'user', content: 'hi' }] },
      event => events.push(event)
    );
    expect(events).toEqual([
      { type: 'content', text: 'hello' },
      { type: 'content', stopReason: 'stop' },
    ]);
  });

  it("sends every call for a saved server through that server's fetch, keyed by its runtime id", async () => {
    const globalFetch = vi.fn();
    vi.stubGlobal('fetch', globalFetch);
    const chatFetch = vi.fn();
    const serverFetch = (contextLength: number) =>
      vi.fn(async (input: string, _init?: RequestInit) => {
        if (input.endsWith('/api/tags')) return Response.json({ models: [{ name: 'qwen3:8b' }] });
        if (input.endsWith('/api/show'))
          return Response.json({
            capabilities: ['completion', 'tools'],
            model_info: { 'qwen3.context_length': contextLength },
          });
        return new Response(
          `${JSON.stringify({ message: { content: 'remote hi' }, done: true, done_reason: 'stop' })}\n`
        );
      });
    const oneFetch = serverFetch(2048);
    const twoFetch = serverFetch(4096);
    const remote = (runtimeId: string, baseUrl: string, fetch: ReturnType<typeof serverFetch>) =>
      new OllamaLocal(chatFetch, undefined, {
        runtimeId,
        baseUrl,
        label: runtimeId,
        fetch,
        hasCredentials: () => false,
        redact: text => text,
      });
    const one = remote('srv-aaa111', 'https://one.example.test', oneFetch);
    const two = remote('srv-bbb222', 'http://127.0.0.2:11434', twoFetch);

    const [oneModel] = await one.models();
    const [twoModel] = await two.models();
    expect(oneModel).toMatchObject({ id: 'local:srv-aaa111:qwen3:8b', contextWindow: 2048 });
    expect(twoModel).toMatchObject({ id: 'local:srv-bbb222:qwen3:8b', contextWindow: 4096 });

    const events: unknown[] = [];
    await one.stream({ model: oneModel.id, messages: [{ role: 'user', content: 'hi' }] }, event => events.push(event));
    expect(events).toContainEqual({ type: 'content', text: 'remote hi' });
    expect(oneFetch.mock.calls.map(([url]) => url)).toContain('https://one.example.test/api/chat');
    expect(oneFetch.mock.calls.every(([url]) => url.startsWith('https://one.example.test/'))).toBe(true);
    expect(globalFetch).not.toHaveBeenCalled();
    expect(chatFetch).not.toHaveBeenCalled();

    await expect(one.stream({ model: twoModel.id, messages: [] }, () => undefined)).rejects.toThrow(
      'Invalid local model id.'
    );
    await expect(one.stream({ model: 'local:ollama:qwen3:8b', messages: [] }, () => undefined)).rejects.toThrow(
      'Invalid local model id.'
    );
  });

  it('asks for new credentials when a saved server answers 401', async () => {
    const fetch = vi.fn(async () => new Response('{"error":"unauthorized"}', { status: 401 }));
    const server = new OllamaLocal(undefined, undefined, {
      runtimeId: 'srv-aaa111',
      baseUrl: 'https://one.example.test',
      label: 'gpu box',
      fetch,
      hasCredentials: () => true,
      redact: text => text,
    });
    const error = await server.listModels().catch((err: unknown) => err);
    expect(error).toBeInstanceOf(ServerCredentialsError);
    expect((error as Error).message).toContain('gpu box');
  });

  it('streams chat through the fetch it is given and keeps the short calls on global fetch', async () => {
    const globalFetch = vi.fn(async (input: unknown, _init?: RequestInit) =>
      String(input).endsWith('/api/tags')
        ? Response.json({ models: [{ name: 'llama' }] })
        : Response.json({ capabilities: ['completion'] })
    );
    vi.stubGlobal('fetch', globalFetch);
    const given = vi.fn(
      async (_url: string, _init: RequestInit) =>
        new Response(`${JSON.stringify({ message: { content: 'hi' }, done: true })}\n`)
    );
    const local = new OllamaLocal(given);
    await local.models();
    await local.stream({ model: 'local:ollama:llama', messages: [{ role: 'user', content: 'hi' }] }, () => undefined);
    expect(given.mock.calls.map(([url]) => url)).toEqual(['http://127.0.0.1:11434/api/chat']);
    expect(globalFetch.mock.calls.map(([url]) => String(url))).toEqual([
      'http://127.0.0.1:11434/api/tags',
      'http://127.0.0.1:11434/api/show',
      'http://127.0.0.1:11434/api/show',
    ]);
  });

  const streamWith = async (
    body: string,
    request: Partial<Parameters<OllamaLocal['stream']>[0]> = {},
    show: Record<string, unknown> = {}
  ) => {
    const fetchMock = vi.fn(async (input: unknown, _init?: RequestInit) =>
      String(input).endsWith('/api/show')
        ? Response.json({ capabilities: ['completion', 'thinking'], ...show })
        : new Response(body, { status: 200 })
    );
    vi.stubGlobal('fetch', fetchMock);
    const events: unknown[] = [];
    await new OllamaLocal().stream(
      { model: 'local:ollama:llama', messages: [{ role: 'user', content: 'hi' }], ...request },
      event => events.push(event)
    );
    return {
      events,
      sent: JSON.parse(
        String(
          (fetchMock.mock.calls[1] as unknown[][])[1] &&
            ((fetchMock.mock.calls[1] as unknown[][])[1] as RequestInit).body
        )
      ),
    };
  };

  it('sends tool calls, tool results and screenshots in the Ollama chat format', async () => {
    const { sent } = await streamWith(`${JSON.stringify({ done: true })}\n`, {
      thinking: true,
      maxTokens: 256,
      messages: [
        { role: 'user', content: 'look' },
        {
          role: 'assistant',
          content: [{ type: 'tool_use', id: 't1', name: 'browser_screenshot', input: { full: true } }],
        },
        {
          role: 'user',
          content: [
            { type: 'tool_result', tool_use_id: 't1', content: 'ok' },
            { type: 'image', source: { type: 'base64', data: 'AAAA' } },
          ],
        },
      ],
    });
    expect(sent.model).toBe('llama');
    expect(sent.think).toBe(true);
    expect(sent.options).toEqual({ num_ctx: 16384, num_predict: 256 });
    expect(sent.truncate).toBe(false);
    expect(sent.shift).toBe(false);
    expect(sent.messages).toEqual([
      { role: 'user', content: 'look' },
      {
        role: 'assistant',
        content: '',
        tool_calls: [{ function: { name: 'browser_screenshot', arguments: { full: true } } }],
      },
      { role: 'tool', content: 'ok', tool_name: 'browser_screenshot' },
      { role: 'user', content: '', images: ['AAAA'] },
    ]);
  });

  it('rejects malformed and truncated streams instead of persisting partial success', async () => {
    await expect(streamWith('not-json\n')).rejects.toThrow('malformed stream');
    await expect(streamWith(`${JSON.stringify({ message: { content: 'partial' } })}\n`)).rejects.toThrow(
      'before the reply finished'
    );
  });

  it('sends an explicit disabled thinking preference', async () => {
    const { sent } = await streamWith(`${JSON.stringify({ done: true })}\n`, { thinking: false });
    expect(sent.think).toBe(false);
  });

  describe('thinking off for a template that always thinks', () => {
    const done = `${JSON.stringify({ done: true })}\n`;
    const alwaysThinks = { thinking: { values: [true], default: true } };
    const qwen3 = { ...alwaysThinks, model_info: { 'general.architecture': 'qwen3' } };
    const conversation: CompletionMessage[] = [
      { role: 'user', content: 'first' },
      { role: 'assistant', content: 'reply' },
      { role: 'user', content: 'weather?' },
      { role: 'assistant', content: [{ type: 'tool_use', id: 't1', name: 'weather', input: {} }] },
      {
        role: 'user',
        content: [
          { type: 'tool_result', tool_use_id: 't1', content: 'sunny' },
          { type: 'text', text: 'note on the result' },
        ],
      },
    ];
    const legacyQwen3Template = '{{- if and (ne .Role "assistant") $last }}<|im_start|>assistant\n<think>\n{{ end }}';
    const r1JinjaTemplate = "{% if add_generation_prompt and not ns.is_tool %}{{'<Assistant><think>\\n'}}{% endif %}";
    const libraryQwen3Template =
      '{{- if and (ne .Role "assistant") $last }}<|im_start|>assistant\n{{ if and $.IsThinkSet (not $.Think) -}}\n<think>\n\n</think>\n\n{{ end -}}\n{{ end }}';

    it('sends think:false when Ollama lists false among the values', async () => {
      const { sent } = await streamWith(
        done,
        { thinking: false },
        { thinking: { values: [false, true], default: true }, model_info: { 'general.architecture': 'qwen3' } }
      );
      expect(sent.think).toBe(false);
      expect(sent.messages).toEqual([{ role: 'user', content: 'hi' }]);
    });

    it('leaves think out and puts the Qwen3 switch on the last prompt only, never on a tool result', async () => {
      const { sent } = await streamWith(done, { thinking: false, messages: conversation }, qwen3);
      expect(sent).not.toHaveProperty('think');
      expect(sent.messages).toEqual([
        { role: 'user', content: 'first' },
        { role: 'assistant', content: 'reply' },
        { role: 'user', content: 'weather? /no_think' },
        { role: 'assistant', content: '', tool_calls: [{ function: { name: 'weather', arguments: {} } }] },
        { role: 'tool', content: 'sunny', tool_name: 'weather' },
        { role: 'user', content: 'note on the result' },
      ]);
      expect(conversation[2]).toEqual({ role: 'user', content: 'weather?' });
    });

    it('sends the switch alone on an image-only prompt', async () => {
      const { sent } = await streamWith(
        done,
        {
          thinking: false,
          messages: [{ role: 'user', content: [{ type: 'image', source: { type: 'base64', data: 'AAAA' } }] }],
        },
        qwen3
      );
      expect(sent.messages).toEqual([{ role: 'user', content: '/no_think', images: ['AAAA'] }]);
    });

    it('adds no switch for a qwen3 model whose template Ollama does not list as the hybrid one', async () => {
      const { sent } = await streamWith(
        done,
        { thinking: false },
        { model_info: { 'general.architecture': 'qwen3' }, template: legacyQwen3Template }
      );
      expect(sent).not.toHaveProperty('think');
      expect(sent.messages).toEqual([{ role: 'user', content: 'hi' }]);
    });

    it.each([
      ['a Go', legacyQwen3Template],
      ['a Jinja', r1JinjaTemplate],
      ['a trimmed Go', '{{ "<think>\\n" -}}{{ end }}'],
      ['a trimmed Jinja', "{{- '<|im_start|>assistant\\n<think>\\n' -}}{%- endif %}"],
    ])('leaves think out for %s template that hard-codes the opener', async (_kind, template) => {
      const { sent } = await streamWith(done, { thinking: false }, { template });
      expect(sent).not.toHaveProperty('think');
    });

    it('still sends think:false for a template with a thinking-off branch', async () => {
      const { sent } = await streamWith(done, { thinking: false }, { template: libraryQwen3Template });
      expect(sent.think).toBe(false);
    });

    it('rejects a prefilled stream that ends mid-reasoning', async () => {
      await expect(
        streamWith(
          `${JSON.stringify({ message: { content: 'plan</th' } })}\n`,
          { thinking: false },
          { capabilities: ['completion'], template: legacyQwen3Template }
        )
      ).rejects.toThrow('before the reply finished');
    });

    it('splits prefilled reasoning out of the raw reply of a model Ollama runs no parser for', async () => {
      const { sent, events } = await streamWith(
        [
          { message: { content: 'Okay, the user asks.' } },
          { message: { content: '\n</thi' } },
          { message: { content: 'nk>\n\nPar' } },
          { message: { content: 'is' }, done: true, done_reason: 'stop' },
        ]
          .map(frame => `${JSON.stringify(frame)}\n`)
          .join(''),
        { thinking: false },
        { capabilities: ['completion'], template: legacyQwen3Template }
      );
      expect(sent).not.toHaveProperty('think');
      expect(events).toEqual([
        { type: 'content', text: '<think>Okay, the user asks.</think>' },
        { type: 'content', text: '<think>\n</think>' },
        { type: 'content', text: 'Par' },
        { type: 'content', text: 'is' },
        { type: 'content', stopReason: 'stop' },
      ]);
    });

    it('drops a literal opener from prefilled reasoning so it cannot hide the reply downstream', async () => {
      const { events } = await streamWith(
        `${JSON.stringify({ message: { content: '<think>plan</think>Paris' }, done: true })}\n`,
        {},
        { capabilities: ['completion'], template: legacyQwen3Template }
      );
      const filter = createThinkFilter();
      const visible = events.map(event => filter.push((event as { text?: string }).text ?? '').text).join('');
      expect(visible + filter.flush().text).toBe('Paris');
    });

    it.each([
      ['always thinks', { thinking: false }, alwaysThinks, 64 + 2048],
      ['takes only effort levels', { thinking: false }, { thinking: { values: ['low', 'medium', 'high'] } }, 64 + 2048],
      [
        'prefills the opener with no parser',
        {},
        { capabilities: ['completion'], template: legacyQwen3Template },
        64 + 2048,
      ],
      ['takes the Qwen3 switch', { thinking: false }, qwen3, 64],
      ['honors think:false', { thinking: false }, {}, 64],
      ['was asked to think', { thinking: true }, alwaysThinks, 64],
    ])(
      'gives the reasoning its own budget only when a model that %s reasons anyway',
      async (_case, request, show, expected) => {
        const { sent } = await streamWith(done, { ...request, maxTokens: 64 }, show);
        expect(sent.options.num_predict).toBe(expected);
      }
    );

    it('returns only the text after the reasoning to an auxiliary caller on a model that always thinks', async () => {
      const { sent, events } = await streamWith(
        [{ message: { thinking: 'They want a title.' } }, { message: { content: 'Capital of France' }, done: true }]
          .map(frame => `${JSON.stringify(frame)}\n`)
          .join(''),
        { thinking: false, maxTokens: 64 },
        alwaysThinks
      );
      expect(sent).not.toHaveProperty('think');
      expect(sent.options.num_predict).toBe(64 + 2048);
      const filter = createThinkFilter();
      const title = events.map(event => filter.push((event as { text?: string }).text ?? '').text).join('');
      expect(title + filter.flush().text).toBe('Capital of France');
    });

    it('leaves the raw reply alone when the template does not prefill the opener', async () => {
      const { events } = await streamWith(
        `${JSON.stringify({ message: { content: 'a </think> b' }, done: true })}\n`,
        {},
        { capabilities: ['completion'], template: libraryQwen3Template }
      );
      expect(events[0]).toEqual({ type: 'content', text: 'a </think> b' });
    });

    it('treats the qwen3moe architecture as Qwen3', async () => {
      const { sent } = await streamWith(
        done,
        { thinking: false },
        { ...alwaysThinks, model_info: { 'general.architecture': 'qwen3moe' } }
      );
      expect(sent.messages).toEqual([{ role: 'user', content: 'hi /no_think' }]);
    });

    it('leaves think out but adds no switch for another architecture', async () => {
      const { sent } = await streamWith(
        done,
        { thinking: false },
        { ...alwaysThinks, model_info: { 'general.architecture': 'llama' } }
      );
      expect(sent).not.toHaveProperty('think');
      expect(sent.messages).toEqual([{ role: 'user', content: 'hi' }]);
    });

    it('sends the lowest effort for effort-level-only values', async () => {
      const { sent } = await streamWith(
        done,
        { thinking: false },
        { thinking: { values: ['low', 'medium', 'high'], default: 'medium' } }
      );
      expect(sent.think).toBe('low');
    });

    it('keeps thinking on unchanged', async () => {
      const { sent } = await streamWith(done, { thinking: true }, qwen3);
      expect(sent.think).toBe(true);
      expect(sent.messages).toEqual([{ role: 'user', content: 'hi' }]);
    });

    it('sends the reasoning Ollama splits out as thinking, not as the reply', async () => {
      const { events } = await streamWith(
        `${JSON.stringify({ message: { thinking: 'hmm' } })}\n${JSON.stringify({ message: { content: 'Paris' }, done: true })}\n`,
        { thinking: false },
        qwen3
      );
      expect(events.slice(0, 2)).toEqual([
        { type: 'content', text: '<think>hmm</think>' },
        { type: 'content', text: 'Paris' },
      ]);
    });

    it('ignores a malformed thinking descriptor', async () => {
      const { sent } = await streamWith(done, { thinking: false }, { thinking: 'yes' });
      expect(sent.think).toBe(false);
    });

    const catalogWith = async (show: Record<string, unknown>) => {
      vi.stubGlobal(
        'fetch',
        vi.fn(async (input: unknown) =>
          String(input).endsWith('/api/tags')
            ? Response.json({ models: [{ name: 'm' }] })
            : Response.json({ capabilities: ['completion', 'thinking'], ...show })
        )
      );
      return new OllamaLocal().models();
    };

    it.each([
      ['the legacy hybrid Qwen3', qwen3, false],
      ['values with false', { thinking: { values: [false, true] } }, false],
      ['effort-only values', { thinking: { values: ['low', 'medium', 'high'] } }, false],
      ['no values and no opener', {}, false],
      ['values of [true] on another architecture', alwaysThinks, true],
      ['no values and a hard-coded opener', { template: r1JinjaTemplate }, true],
    ])('marks Off unavailable in the catalog only when it cannot take effect: %s', async (_case, show, alwaysOn) => {
      const [model] = await catalogWith(show);
      expect(model.thinkingToggle).toBe(true);
      expect(model.thinkingAlwaysOn === true).toBe(alwaysOn);
    });

    it.each([{ thinking: 'yes' }, { thinking: { values: 'x' } }, { thinking: null }, { template: 7 }])(
      'keeps a model whose show response carries a malformed field %j',
      async show => {
        const [model] = await catalogWith(show);
        expect(model).toMatchObject({ id: 'local:ollama:m', thinkingToggle: true });
        expect(model.thinkingAlwaysOn).toBeUndefined();
      }
    );
  });

  it.each([
    ['length', 'max_tokens'],
    ['stop', 'stop'],
    [undefined, 'end_turn'],
    ['custom', 'custom'],
  ])('normalizes Ollama stop reason %s to %s', async (reason, expected) => {
    const { events } = await streamWith(
      `${JSON.stringify({ message: { content: 'ok' }, done: true, done_reason: reason })}\n`
    );
    expect(events).toEqual([
      { type: 'content', text: 'ok' },
      { type: 'content', stopReason: expected },
    ]);
  });

  it.each([
    {
      replies: ['', 'pong'],
      events: [
        { type: 'content', text: 'pong' },
        { type: 'content', stopReason: 'stop' },
      ],
    },
    { replies: ['', ''], error: 'llama ended its reply without writing anything' },
  ])('asks once more when the model stops without a word: $replies', async ({ replies, events, error }) => {
    const bodies = replies.map(
      text =>
        `${text ? `${JSON.stringify({ message: { content: text }, done: false })}\n` : ''}${JSON.stringify({ message: { content: '' }, done: true, done_reason: 'stop' })}\n`
    );
    const fetchMock = vi.fn(async (input: unknown, _init?: RequestInit) =>
      String(input).endsWith('/api/show')
        ? Response.json({ capabilities: ['completion'] })
        : new Response(bodies.shift() ?? '', { status: 200 })
    );
    vi.stubGlobal('fetch', fetchMock);
    const seen: unknown[] = [];
    const turn = new OllamaLocal().stream(
      { model: 'local:ollama:llama', messages: [{ role: 'user', content: 'hi' }] },
      e => seen.push(e)
    );
    if (error) await expect(turn).rejects.toThrow(error);
    else await turn;
    expect(seen).toEqual(events ?? []);
    expect(fetchMock.mock.calls.filter(([url]) => String(url).endsWith('/api/chat'))).toHaveLength(2);
  });

  it.each([
    { capabilities: ['completion', 'tools'], sendsTools: true },
    { capabilities: ['completion'], sendsTools: false },
  ])('sends tools only to a model that reports the capability: $capabilities', async ({ capabilities, sendsTools }) => {
    const fetchMock = vi.fn(async (input: unknown, _init?: RequestInit) =>
      String(input).endsWith('/api/show')
        ? Response.json({ capabilities })
        : new Response(`${JSON.stringify({ done: true })}\n`)
    );
    vi.stubGlobal('fetch', fetchMock);
    await new OllamaLocal().stream(
      {
        model: 'local:ollama:gemma3:270m',
        messages: [{ role: 'user', content: 'hi' }],
        tools: [{ toolSchema: { name: 'read_file', parameters: {} } }],
      },
      () => undefined
    );
    const sent = JSON.parse(String(fetchMock.mock.calls[1][1]?.body)) as Record<string, unknown>;
    expect('tools' in sent).toBe(sendsTools);
  });

  it('excludes embedding-only models and models whose capabilities could not be inspected', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: unknown, init?: RequestInit) => {
        if (String(input).endsWith('/api/tags'))
          return Response.json({ models: [{ name: 'embed' }, { name: 'broken' }, { name: 'chat' }] });
        const { name } = JSON.parse(String(init?.body)) as { name: string };
        if (name === 'broken') return new Response('', { status: 500 });
        return Response.json({ capabilities: name === 'embed' ? ['embedding'] : ['completion'] });
      })
    );
    expect((await new OllamaLocal().models()).map(model => model.id)).toEqual(['local:ollama:chat']);
  });

  it('keeps a model and its tools listed when /api/show times out, and asks again after a backoff', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    let slow = new Set(['fresh']);
    const shows: string[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: unknown, init?: RequestInit) => {
        if (String(input).endsWith('/api/tags'))
          return Response.json({ models: [{ name: 'qwen3:8b' }, { name: 'fresh' }] });
        const { name } = JSON.parse(String(init?.body)) as { name: string };
        shows.push(name);
        if (slow.has(name)) throw new DOMException('timed out', 'TimeoutError');
        return Response.json({ capabilities: ['completion', 'tools', 'thinking'] });
      })
    );
    const local = new OllamaLocal();

    const first = await local.models();
    expect(first).toEqual([
      expect.objectContaining({ id: 'local:ollama:qwen3:8b', supportsTools: true, thinkingToggle: true }),
      expect.objectContaining({ id: 'local:ollama:fresh', contextWindow: 16384 }),
    ]);
    // Absent is unknown, which chat treats as tools on; only an explicit false turns them off.
    expect(first[1]).not.toHaveProperty('supportsTools');

    slow = new Set(['qwen3:8b', 'fresh']);
    shows.length = 0;
    expect(await local.models()).toEqual(first);
    expect(shows).toEqual(['qwen3:8b']);

    shows.length = 0;
    expect(await local.models()).toEqual(first);
    expect(shows).toEqual([]);

    vi.setSystemTime(Date.now() + 5_001);
    slow = new Set();
    shows.length = 0;
    const later = await local.models();
    expect(shows.sort()).toEqual(['fresh', 'qwen3:8b']);
    expect(later[1]).toEqual(expect.objectContaining({ supportsTools: true, thinkingToggle: true }));
  });

  it('gives the inspection before a turn longer than the 1 s list calls', async () => {
    vi.useFakeTimers();
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: unknown, init?: RequestInit) => {
        if (String(input).endsWith('/api/show'))
          return new Promise<Response>((resolve, reject) => {
            const timer = setTimeout(() => resolve(Response.json({ capabilities: ['completion'] })), 3_000);
            init?.signal?.addEventListener('abort', () => {
              clearTimeout(timer);
              reject(new DOMException('timed out', 'TimeoutError'));
            });
          });
        return new Response(`${JSON.stringify({ message: { content: 'ok' }, done: true })}\n`);
      })
    );
    const events: CompletionStreamEvent[] = [];
    const turn = new OllamaLocal().stream(
      { model: 'local:ollama:qwen3:8b', messages: [{ role: 'user', content: 'hi' }] },
      event => events.push(event)
    );
    await vi.advanceTimersByTimeAsync(3_001);
    await turn;
    expect(events).toContainEqual({ type: 'content', text: 'ok' });
  });

  it('translates thinking and tool-call frames', async () => {
    const { events } = await streamWith(
      `${JSON.stringify({
        message: {
          thinking: 'reason',
          tool_calls: [{ id: 'call-1', function: { name: 'read_file', arguments: { path: 'README.md' } } }],
        },
        done: true,
      })}\n`
    );
    expect(events).toEqual([
      { type: 'content', text: '<think>reason</think>' },
      { type: 'tool_use', tools: [{ id: 'call-1', name: 'read_file', arguments: '{"path":"README.md"}' }] },
      { type: 'content', stopReason: 'end_turn' },
    ]);
  });

  it('passes cancellation through and releases the stream after a frame error', async () => {
    const cancel = vi.fn();
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode('bad-json\n'));
      },
      cancel,
    });
    const fetchMock = vi.fn(async (input: unknown, _init?: RequestInit) =>
      String(input).endsWith('/api/show') ? Response.json({ capabilities: ['completion'] }) : new Response(body)
    );
    vi.stubGlobal('fetch', fetchMock);
    const controller = new AbortController();
    await expect(
      new OllamaLocal().stream({ model: 'local:ollama:llama', messages: [] }, () => undefined, controller.signal)
    ).rejects.toThrow('malformed stream');
    expect(fetchMock.mock.calls[1][1]?.signal).toBe(controller.signal);
    expect(cancel).toHaveBeenCalledOnce();
    expect(body.locked).toBe(false);
  });

  it.each([
    { prompt_eval_count: 3000, eval_count: 12, usage: { inputTokens: 3000, outputTokens: 12 } },
    { prompt_eval_count: 0, eval_count: 0, usage: { inputTokens: 0, outputTokens: 0 } },
    { prompt_eval_count: 3000, usage: { inputTokens: 3000 } },
    { eval_count: 12, usage: { outputTokens: 12 } },
    { prompt_eval_count: -1, eval_count: '12', usage: undefined },
    { prompt_eval_count: 1.5, eval_count: null, usage: undefined },
  ])('preserves only reported valid token counts: %j', async ({ usage, ...counts }) => {
    const { events } = await streamWith(`${JSON.stringify({ done: true, ...counts })}\n`);
    expect(events).toEqual([{ type: 'content', stopReason: 'end_turn', ...(usage ? { usage } : {}) }]);
  });

  it('ignores token counts on partial frames until the final measurement arrives', async () => {
    const { events } = await streamWith(
      `${JSON.stringify({ message: { content: 'answer' }, prompt_eval_count: 20 })}\n${JSON.stringify({ done: true, prompt_eval_count: 30, eval_count: 4 })}\n`
    );
    expect(events).toEqual([
      { type: 'content', text: 'answer' },
      { type: 'content', stopReason: 'end_turn', usage: { inputTokens: 30, outputTokens: 4 } },
    ]);
  });

  it('fails the turn on an error frame', async () => {
    await expect(streamWith(`${JSON.stringify({ error: 'model requires more memory' })}\n`)).rejects.toThrow(
      'model requires more memory'
    );
  });

  describe('context overflow', () => {
    const overflow = (tokens: number) =>
      Response.json(
        { error: `request (${tokens} tokens) exceeds the available context size (2048 tokens), try increasing it` },
        { status: 400 }
      );
    const chatWith = (...replies: (() => Response)[]) => {
      const fetchMock = vi.fn(async (input: unknown, _init?: RequestInit) =>
        String(input).endsWith('/api/show')
          ? Response.json({ capabilities: ['completion'], model_info: { 'llama.context_length': 2048 } })
          : (replies.shift() ?? (() => new Response(`${JSON.stringify({ done: true })}\n`)))()
      );
      vi.stubGlobal('fetch', fetchMock);
      const sent = () =>
        fetchMock.mock.calls
          .filter(([input]) => String(input).endsWith('/api/chat'))
          .map(([, init]) => (JSON.parse(String(init?.body)) as { messages: { content: string }[] }).messages);
      return { sent };
    };
    const conversation = (oldChars: number) => [
      { role: 'system' as const, content: 'instructions' },
      { role: 'user' as const, content: 'x'.repeat(oldChars) },
      { role: 'assistant' as const, content: 'old answer' },
      { role: 'user' as const, content: 'latest' },
    ];

    it('sends a conversation the estimate says is too long whole while Ollama accepts it', async () => {
      const { sent } = chatWith();
      const onTrimmed = vi.fn();
      const messages: CompletionMessage[] = [{ role: 'system', content: 'instructions' }];
      for (let turn = 0; turn < 30; turn++)
        messages.push(
          { role: 'user', content: `u${turn}${'x'.repeat(300)}` },
          { role: 'assistant', content: `a${turn}${'x'.repeat(300)}` }
        );
      await new OllamaLocal().stream({ model: 'local:ollama:llama', messages }, () => undefined, undefined, onTrimmed);
      expect(sent()).toHaveLength(1);
      expect(sent()[0]).toHaveLength(61);
      expect(onTrimmed).not.toHaveBeenCalled();
    });

    it('drops the oldest turns and retries once when Ollama measures the prompt as too long', async () => {
      const { sent } = chatWith(
        () => overflow(3000),
        () => new Response(`${JSON.stringify({ done: true, prompt_eval_count: 1500, eval_count: 5 })}\n`)
      );
      const onTrimmed = vi.fn();
      const events: CompletionStreamEvent[] = [];
      await new OllamaLocal().stream(
        { model: 'local:ollama:llama', messages: conversation(4_000) },
        event => events.push(event),
        undefined,
        onTrimmed
      );
      expect(sent().map(messages => messages.map(message => message.content.slice(0, 12)))).toEqual([
        ['instructions', 'xxxxxxxxxxxx', 'old answer', 'latest'],
        ['instructions', 'latest'],
      ]);
      expect(onTrimmed).toHaveBeenCalledWith(2);
      // The whole conversation's size, which is what the next turn's auto-compaction reads.
      expect(events.at(-1)).toMatchObject({ usage: { inputTokens: 3000, outputTokens: 5 } });
    });

    it('records the whole size as soon as the trimmed retry is accepted, before any reply arrives', async () => {
      chatWith(
        () => overflow(3000),
        () => new Response(`${JSON.stringify({ message: { content: 'Partial' } })}\n`)
      );
      const events: CompletionStreamEvent[] = [];
      await expect(
        new OllamaLocal().stream({ model: 'local:ollama:llama', messages: conversation(4_000) }, event =>
          events.push(event)
        )
      ).rejects.toThrow('before the reply finished');
      expect(events[0]).toEqual({ type: 'content', usage: { inputTokens: 3000 } });
    });

    it('fails with the measured size when the latest turn alone does not fit', async () => {
      const { sent } = chatWith(() => overflow(6000));
      const onTrimmed = vi.fn();
      await expect(
        new OllamaLocal().stream(
          {
            model: 'local:ollama:llama',
            messages: [
              { role: 'system', content: 'instructions' },
              { role: 'user', content: 'x'.repeat(20_000) },
            ],
          },
          () => undefined,
          undefined,
          onTrimmed
        )
      ).rejects.toThrow('take 6000 tokens, more than the 2048');
      expect(sent()).toHaveLength(1);
      expect(onTrimmed).not.toHaveBeenCalled();
    });

    it('fails with the measured size when the trimmed prompt still does not fit', async () => {
      const { sent } = chatWith(
        () => overflow(3000),
        () => overflow(2100)
      );
      await expect(
        new OllamaLocal().stream({ model: 'local:ollama:llama', messages: conversation(4_000) }, () => undefined)
      ).rejects.toThrow('take 2100 tokens, more than the 2048');
      expect(sent()).toHaveLength(2);
    });

    const turns = (count: number, chars: number): CompletionMessage[] => [
      { role: 'system', content: 'instructions' },
      ...Array.from({ length: count }, (_, turn): CompletionMessage[] => [
        { role: 'user', content: `u${turn}${'x'.repeat(chars)}` },
        { role: 'assistant', content: `a${turn}${'y'.repeat(chars / 5)}` },
      ]).flat(),
      { role: 'user', content: 'latest' },
    ];

    it('rescales from each refusal and retries until the prompt fits', async () => {
      const { sent } = chatWith(
        () => overflow(1900),
        () => overflow(2000)
      );
      const onTrimmed = vi.fn();
      await new OllamaLocal().stream(
        { model: 'local:ollama:llama', messages: turns(3, 2000) },
        () => undefined,
        undefined,
        onTrimmed
      );
      expect(sent().map(messages => messages.length)).toEqual([8, 6, 4]);
      expect(sent()[2].map(message => message.content.slice(0, 2))).toEqual(['in', 'u2', 'a2', 'la']);
      // Two prompts and their two replies, reported once the reply is under way.
      expect(onTrimmed).toHaveBeenCalledTimes(1);
      expect(onTrimmed).toHaveBeenCalledWith(4);
    });

    it('stops after a few retries even while older turns remain', async () => {
      const { sent } = chatWith(...Array.from({ length: 6 }, () => () => overflow(2049)));
      const onTrimmed = vi.fn();
      await expect(
        new OllamaLocal().stream(
          { model: 'local:ollama:llama', messages: turns(20, 320) },
          () => undefined,
          undefined,
          onTrimmed
        )
      ).rejects.toThrow('after leaving out its');
      expect(sent()).toHaveLength(4);
      expect(onTrimmed).not.toHaveBeenCalled();
    });

    it('sends screenshots without the marker that keeps them in their turn', async () => {
      const { sent } = chatWith();
      await new OllamaLocal().stream(
        {
          model: 'local:ollama:llama',
          messages: [
            { role: 'user', content: 'look' },
            { role: 'assistant', content: [{ type: 'tool_use', id: 't1', name: 'shot', input: {} }] },
            { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', content: 'ok' }] },
            {
              role: 'user',
              content: [
                { type: 'text', text: 'Image from the shot call above.' },
                { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'AAAA' } },
              ],
              continuesTurn: true,
            },
          ],
        },
        () => undefined
      );
      expect(JSON.stringify(sent())).not.toContain('continuesTurn');
      expect(sent()[0].at(-1)).toEqual({ role: 'user', content: 'Image from the shot call above.', images: ['AAAA'] });
    });

    it("reports Ollama's error text for other refusals", async () => {
      chatWith(() => Response.json({ error: 'model is busy' }, { status: 400 }));
      await expect(
        new OllamaLocal().stream({ model: 'local:ollama:llama', messages: conversation(10) }, () => undefined)
      ).rejects.toThrow('Ollama returned HTTP 400: model is busy');
    });
  });

  it('fails on an HTTP error or an invalid model id', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('', { status: 500 }))
    );
    const local = new OllamaLocal();
    await expect(local.stream({ model: 'local:ollama:llama', messages: [] }, () => undefined)).rejects.toThrow(
      'HTTP 500'
    );
    await expect(local.stream({ model: 'gpt-4', messages: [] }, () => undefined)).rejects.toThrow('Invalid local');
  });

  it('says plainly when the model was removed from Ollama', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => Response.json({ error: "model 'hf.co/a/b:Q4_K_M' not found" }, { status: 404 }))
    );
    await expect(
      new OllamaLocal().stream({ model: 'local:ollama:hf.co/a/b:Q4_K_M', messages: [] }, () => undefined)
    ).rejects.toThrow('This model was removed from Ollama. Pick another model.');
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('404 page not found', { status: 404 }))
    );
    await expect(
      new OllamaLocal().stream({ model: 'local:ollama:llama', messages: [] }, () => undefined)
    ).rejects.toThrow('Ollama returned HTTP 404.');
  });
});

describe('OllamaLocal context sizing', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    forgetLocalContexts();
  });

  // Sizes follow the stub estimator: a 4 GiB model plus 2 GiB per 16K of context. A bare number is a
  // unified machine of that many GiB, which Auto sizes by memory alone.
  const cpu = cpuMachine;
  const discrete = discreteMachine;
  const unified = unifiedMachine;
  const lowConfidence = lowConfidenceMachine;
  type Machine = HardwareProfile | number | null;
  const footprintOn = (machine: Machine, arch = stubArch()): LocalModelFootprint =>
    machine === null
      ? { arch: null, weightsBytes: null, hardware: null }
      : { arch, weightsBytes: 4 * GIB, hardware: typeof machine === 'number' ? unified(machine) : machine };
  const sizing = (setting: LocalContextSetting, machine: Machine, arch?: ModelArch) => {
    let footprint = footprintOn(machine, arch);
    return {
      setting: async () => setting,
      footprint: vi.fn(async () => footprint),
      cachedFootprint: vi.fn(() => footprint),
      /** The machine the next sizing sees, as if the model or the hardware had changed. */
      become(next: Machine) {
        footprint = footprintOn(next, arch);
      },
    } satisfies LocalContextSizing & { become(next: Machine): void };
  };
  const overflow = (tokens: number) =>
    Response.json(
      { error: `request (${tokens} tokens) exceeds the available context size (4096 tokens), try increasing it` },
      { status: 400 }
    );
  const done = () => new Response(`${JSON.stringify({ done: true })}\n`);
  const ollama = (show: Record<string, unknown>, ...replies: (() => Response)[]) => {
    let digest = 'one';
    const fetchMock = vi.fn(async (input: unknown, _init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith('/api/tags')) return Response.json({ models: [{ name: 'llama', size: 1, digest }] });
      if (url.endsWith('/api/show')) return Response.json({ capabilities: ['completion'], ...show });
      return (replies.shift() ?? done)();
    });
    vi.stubGlobal('fetch', fetchMock);
    return Object.assign(
      () =>
        fetchMock.mock.calls
          .filter(([input]) => String(input).endsWith('/api/chat'))
          .map(([, init]) => (JSON.parse(String(init?.body)) as { options: { num_ctx: number } }).options.num_ctx),
      {
        tagsCalls: () => fetchMock.mock.calls.filter(([input]) => String(input).endsWith('/api/tags')).length,
        repull: (next: string) => {
          digest = next;
        },
      }
    );
  };
  const longTurn = {
    model: 'local:ollama:llama',
    messages: [
      { role: 'system' as const, content: 'instructions' },
      { role: 'user' as const, content: 'x'.repeat(200) },
    ],
  };
  const trainedFor = (tokens: number) => ({ model_info: { 'llama.context_length': tokens } });

  it.each([
    { setting: AUTO_LOCAL_CONTEXT, machine: 13, show: trainedFor(131072), expected: 65536 },
    { setting: AUTO_LOCAL_CONTEXT, machine: 9, show: trainedFor(131072), expected: 32768 },
    { setting: AUTO_LOCAL_CONTEXT, machine: 7, show: trainedFor(131072), expected: 16384 },
    { setting: AUTO_LOCAL_CONTEXT, machine: null, show: trainedFor(131072), expected: 16384 },
    { setting: AUTO_LOCAL_CONTEXT, machine: 32, show: trainedFor(8192), expected: 8192 },
    { setting: AUTO_LOCAL_CONTEXT, machine: discrete(7, 32), show: trainedFor(131072), expected: 16384 },
    { setting: AUTO_LOCAL_CONTEXT, machine: discrete(9, 32), show: trainedFor(131072), expected: 32768 },
    { setting: AUTO_LOCAL_CONTEXT, machine: unified(7), show: trainedFor(131072), expected: 16384 },
    { setting: AUTO_LOCAL_CONTEXT, machine: unified(13), show: trainedFor(131072), expected: 65536 },
    { setting: AUTO_LOCAL_CONTEXT, machine: lowConfidence(64), show: trainedFor(131072), expected: 16384 },
    { setting: AUTO_LOCAL_CONTEXT, machine: cpu(64), show: trainedFor(262144), expected: 32768 },
    { setting: AUTO_LOCAL_CONTEXT, machine: cpu(7), show: trainedFor(262144), expected: 16384 },
    {
      setting: { mode: 'fixed', tokens: 131072 } as const,
      machine: cpu(64),
      show: trainedFor(262144),
      expected: 131072,
    },
    {
      setting: AUTO_LOCAL_CONTEXT,
      machine: 13,
      show: { ...trainedFor(262144), parameters: 'num_ctx 262144' },
      expected: 65536,
    },
    {
      setting: AUTO_LOCAL_CONTEXT,
      machine: 17,
      show: { ...trainedFor(131072), parameters: 'num_ctx 98304' },
      expected: 98304,
    },
    {
      setting: AUTO_LOCAL_CONTEXT,
      machine: 9,
      show: { ...trainedFor(131072), parameters: 'num_ctx 4096' },
      expected: 32768,
    },
    {
      setting: AUTO_LOCAL_CONTEXT,
      machine: 4,
      show: { ...trainedFor(262144), parameters: 'num_ctx 262144' },
      expected: 16384,
    },
    { setting: { mode: 'fixed', tokens: 32768 } as const, machine: 64, show: trainedFor(131072), expected: 32768 },
    { setting: { mode: 'fixed', tokens: 262144 } as const, machine: 64, show: trainedFor(32768), expected: 32768 },
    {
      setting: { mode: 'fixed', tokens: 16384 } as const,
      machine: 64,
      show: { ...trainedFor(131072), parameters: 'num_ctx 65536' },
      expected: 16384,
    },
  ])(
    'advertises and sends one context: $setting.mode, $machine -> $expected',
    async ({ setting, machine, show, expected }) => {
      const sent = ollama(show);
      const local = new OllamaLocal(undefined, sizing(setting, machine));
      expect((await local.models())[0].contextWindow).toBe(expected);
      await local.stream(longTurn, () => undefined);
      await local.stream(longTurn, () => undefined);
      expect(sent()).toEqual([expected, expected]);
      expect(await new OllamaLocal(undefined, sizing(setting, machine)).contextTokens('local:ollama:llama')).toBe(
        expected
      );
    }
  );

  it('grows Auto once to the largest resident context and keeps it afterwards', async () => {
    const sent = ollama(trainedFor(131072), () => overflow(70_000));
    const local = new OllamaLocal(undefined, sizing(AUTO_LOCAL_CONTEXT, 13));
    const onTrimmed = vi.fn();
    const onNotice = vi.fn();
    await local.stream(longTurn, () => undefined, undefined, onTrimmed, onNotice);
    await local.stream(longTurn, () => undefined);
    // 13 GiB leaves 9 GiB for the cache: 72K tokens.
    expect(sent()).toEqual([65536, 73728, 73728]);
    expect(onTrimmed).not.toHaveBeenCalled();
    expect(onNotice).not.toHaveBeenCalled();
    expect(await local.contextTokens('local:ollama:llama')).toBe(73728);

    forgetLocalContexts();
    await local.stream(longTurn, () => undefined);
    expect(sent().at(-1)).toBe(65536);
  });

  it('starts a model at 32K without a GPU and grows it one Settings size, not to its trained length', async () => {
    const sent = ollama(trainedFor(262144), () => overflow(40_000));
    const local = new OllamaLocal(undefined, sizing(AUTO_LOCAL_CONTEXT, cpu(64)));
    expect((await local.models())[0].contextWindow).toBe(32768);
    await local.stream(longTurn, () => undefined);
    expect(sent()).toEqual([32768, 65536]);
  });

  it('changes num_ctx at most once in a tool loop whose prompt grows every round', async () => {
    const sent: number[] = [];
    let refused = 0;
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: unknown, init?: RequestInit) => {
        const url = String(input);
        if (url.endsWith('/api/tags')) return Response.json({ models: [{ name: 'llama', size: 1, digest: 'one' }] });
        if (url.endsWith('/api/show')) return Response.json({ capabilities: ['completion'], ...trainedFor(131072) });
        const body = JSON.parse(String(init?.body)) as {
          options: { num_ctx: number };
          messages: { content: string }[];
        };
        sent.push(body.options.num_ctx);
        // Four characters a token here.
        const tokens = Math.ceil(body.messages.reduce((n, m) => n + m.content.length, 0) / 4);
        if (tokens <= body.options.num_ctx) return done();
        refused++;
        return overflow(tokens);
      })
    );
    // 11 GiB: 32K up front, and room for 56K once the prompt outgrows it.
    const local = new OllamaLocal(undefined, sizing(AUTO_LOCAL_CONTEXT, 11));
    for (let round = 0; round < 10; round++)
      await local.stream(
        {
          model: 'local:ollama:llama',
          messages: [{ role: 'user', content: 'x'.repeat((31_000 + round * 2_500) * 4) }],
        },
        () => undefined
      );
    const changes = sent.filter((tokens, index) => index > 0 && tokens !== sent[index - 1]).length;
    expect(changes).toBe(1);
    expect(refused).toBe(1);
    expect(new Set(sent)).toEqual(new Set([32768, 57344]));
  });

  it('keeps the larger context when two conversations grow the same model at once', async () => {
    let releaseSmaller: () => void = () => undefined;
    const held = new Promise<void>(resolve => {
      releaseSmaller = resolve;
    });
    const sent: number[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: unknown, init?: RequestInit) => {
        const url = String(input);
        if (url.endsWith('/api/tags')) return Response.json({ models: [{ name: 'llama', size: 1, digest: 'one' }] });
        if (url.endsWith('/api/show')) return Response.json({ capabilities: ['completion'], ...trainedFor(131072) });
        const body = JSON.parse(String(init?.body)) as {
          options: { num_ctx: number };
          messages: { content: string }[];
        };
        sent.push(body.options.num_ctx);
        const tokens = Math.ceil(body.messages.reduce((n, m) => n + m.content.length, 0) / 4);
        if (tokens < 18_000 && body.options.num_ctx === 16384) await held;
        return tokens > body.options.num_ctx ? overflow(tokens) : done();
      })
    );
    // Growth goes by Settings sizes here, so the two conversations alone would want 32K and 64K.
    const local = new OllamaLocal(undefined, sizing(AUTO_LOCAL_CONTEXT, lowConfidence(64)));
    const turn = (tokens: number) => ({
      model: 'local:ollama:llama',
      messages: [{ role: 'user' as const, content: 'x'.repeat(tokens * 4) }],
    });
    const smaller = local.stream(turn(17_000), () => undefined);
    await vi.waitFor(() => expect(sent).toHaveLength(1));
    await local.stream(turn(40_000), () => undefined);
    releaseSmaller();
    await smaller;
    await local.stream(turn(17_000), () => undefined);
    expect(sent).toEqual([16384, 16384, 65536, 65536, 65536]);
    expect(await local.contextTokens('local:ollama:llama')).toBe(65536);
  });

  it('grows by Settings sizes, from 16K, on a probe that could not measure the GPU', async () => {
    const sent = ollama(trainedFor(131072), () => overflow(20_000));
    await new OllamaLocal(undefined, sizing(AUTO_LOCAL_CONTEXT, lowConfidence(64))).stream(longTurn, () => undefined);
    expect(sent()).toEqual([16384, 32768]);
  });

  it('grows past what fits on the GPU when nothing resident holds the prompt, and says replies will be slower', async () => {
    const sent = ollama(trainedFor(262144), () => overflow(25_000));
    const onNotice = vi.fn();
    const local = new OllamaLocal(undefined, sizing(AUTO_LOCAL_CONTEXT, discrete(7, 32)));
    await local.stream(longTurn, () => undefined, undefined, undefined, onNotice);
    expect(sent()).toEqual([16384, 32768]);
    expect(onNotice).toHaveBeenCalledWith(expect.stringContaining('replies will be slower'));
  });

  it('drops Auto to 16K and retries once when the model fails to load at a larger context', async () => {
    const outOfMemory = () => Response.json({ error: 'model requires more system memory' }, { status: 500 });
    const sent = ollama(trainedFor(131072), outOfMemory, done, () => overflow(20_000));
    const onNotice = vi.fn();
    const local = new OllamaLocal(undefined, sizing(AUTO_LOCAL_CONTEXT, 13));
    await local.stream(longTurn, () => undefined, undefined, undefined, onNotice);
    expect(sent()).toEqual([65536, 16384]);
    expect(onNotice).toHaveBeenCalledWith(expect.stringContaining('could not load with a 64K-token context'));
    expect((await local.models())[0].contextWindow).toBe(16384);
    // It does not grow back into the size that failed.
    await expect(local.stream(longTurn, () => undefined)).rejects.toThrow("would not fit this computer's memory");
    expect(sent()).toEqual([65536, 16384, 16384]);
  });

  it('falls back to the size that last loaded, not 16K, when a larger context fails to load', async () => {
    const outOfMemory = () => Response.json({ error: 'model requires more system memory' }, { status: 500 });
    const sent = ollama(trainedFor(131072), done, () => overflow(70_000), outOfMemory, done);
    const local = new OllamaLocal(undefined, sizing(AUTO_LOCAL_CONTEXT, 13));
    await local.stream(longTurn, () => undefined);
    await local.stream(longTurn, () => undefined);
    expect(sent()).toEqual([65536, 65536, 73728, 65536]);
    expect((await local.models())[0].contextWindow).toBe(65536);
  });

  it('leaves a Fixed size alone when it fails to load', async () => {
    const outOfMemory = () => Response.json({ error: 'model requires more system memory' }, { status: 500 });
    const sent = ollama(trainedFor(131072), outOfMemory);
    await expect(
      new OllamaLocal(undefined, sizing({ mode: 'fixed', tokens: 65536 }, 32)).stream(longTurn, () => undefined)
    ).rejects.toThrow('model requires more system memory');
    expect(sent()).toEqual([65536]);
  });

  it.each([
    {
      setting: AUTO_LOCAL_CONTEXT,
      machine: 10,
      show: trainedFor(131072),
      measured: 70_000,
      hint: "would not fit this computer's memory",
    },
    {
      setting: AUTO_LOCAL_CONTEXT,
      machine: 64,
      show: trainedFor(32768),
      measured: 31_000,
      hint: 'the most this model supports',
    },
    {
      setting: { mode: 'fixed', tokens: 16384 } as const,
      machine: 64,
      show: trainedFor(131072),
      measured: 20_000,
      hint: 'Settings can give local models a larger context',
    },
    {
      setting: AUTO_LOCAL_CONTEXT,
      machine: null,
      show: trainedFor(131072),
      measured: 20_000,
      hint: "could not measure this model's memory use",
    },
  ])(
    'says why a prompt that does not fit was not given more room: $hint',
    async ({ setting, machine, show, measured, hint }) => {
      const sent = ollama(show, () => overflow(measured));
      await expect(
        new OllamaLocal(undefined, sizing(setting, machine)).stream(longTurn, () => undefined)
      ).rejects.toThrow(hint);
      expect(sent()).toHaveLength(1);
    }
  );

  it('offers no larger Settings size when the largest is already in use', async () => {
    ollama(trainedFor(1_048_576), () => overflow(300_000));
    await expect(
      new OllamaLocal(undefined, sizing({ mode: 'fixed', tokens: 262144 }, 64, stubArch(1_048_576))).stream(
        longTurn,
        () => undefined
      )
    ).rejects.toThrow(/more than the 262144 this model is run with\.$/);
  });

  it('lists models without waiting for the hardware probe, with one /api/tags per refresh', async () => {
    let finishProbe: (profile: HardwareProfile) => void = () => undefined;
    const hardware = new HardwareProbe(
      () =>
        new Promise<HardwareProfile>(resolve => {
          finishProbe = resolve;
        })
    );
    const qwen = {
      model_info: {
        'general.architecture': 'qwen2',
        'qwen2.block_count': 24,
        'qwen2.context_length': 32768,
        'qwen2.attention.head_count': 14,
        'qwen2.attention.head_count_kv': 2,
        'qwen2.embedding_length': 896,
      },
    };
    const sent = ollama(qwen);
    const local = new OllamaLocal(undefined, localContextSizing({ setting: async () => AUTO_LOCAL_CONTEXT, hardware }));
    expect((await local.models())[0].contextWindow).toBe(16384);
    expect(sent.tagsCalls()).toBe(1);

    const streamed = local.stream(longTurn, () => undefined);
    finishProbe(cpu(64));
    await streamed;
    expect(sent()).toEqual([32768]);
    expect((await local.models())[0].contextWindow).toBe(32768);
    expect(sent.tagsCalls()).toBe(2);
  });

  it('sizes a model again once its tag points at a new digest', async () => {
    const sent = ollama(trainedFor(131072));
    const sized = sizing(AUTO_LOCAL_CONTEXT, 13);
    const local = new OllamaLocal(undefined, sized);
    await local.models();
    await local.stream(longTurn, () => undefined);
    sized.become(9);
    expect((await local.models())[0].contextWindow).toBe(65536);
    sent.repull('two');
    expect((await local.models())[0].contextWindow).toBe(32768);
  });

  it('lists the local models each Settings size may not fit', async () => {
    ollama(trainedFor(131072));
    const fit = await new OllamaLocal(undefined, sizing(AUTO_LOCAL_CONTEXT, 16)).contextFit();
    expect(fit[16384]).toBeUndefined();
    expect(fit[131072]).toEqual(['llama']);
    expect(fit[262144]).toEqual(['llama']);
  });

  const qwenInfo = {
    'general.architecture': 'qwen2',
    'qwen2.block_count': 24,
    'qwen2.context_length': 32768,
    'qwen2.attention.head_count': 14,
    'qwen2.attention.head_count_kv': 2,
    'qwen2.embedding_length': 896,
  };
  /** Ollama serving one 4 GiB qwen2 model, with `/api/tags` and `/api/show` failing while told to. */
  const flakyOllama = () => {
    const state = { showFails: false, tagsFails: false, stopped: false, sent: [] as number[] };
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: unknown, init?: RequestInit) => {
        const url = String(input);
        if (url.endsWith('/api/tags')) {
          if (state.stopped)
            throw new TypeError('fetch failed', {
              cause: Object.assign(new Error('connect'), { code: 'ECONNREFUSED' }),
            });
          if (state.tagsFails) return new Response('', { status: 500 });
          return Response.json({ models: [{ name: 'qwen', size: 4 * GIB, digest: 'one' }] });
        }
        if (url.endsWith('/api/show')) {
          if (state.showFails) throw new DOMException('timed out', 'TimeoutError');
          return Response.json({ capabilities: ['completion'], model_info: qwenInfo });
        }
        state.sent.push((JSON.parse(String(init?.body)) as { options: { num_ctx: number } }).options.num_ctx);
        return done();
      })
    );
    return state;
  };
  const realSizing = () =>
    localContextSizing({ setting: async () => AUTO_LOCAL_CONTEXT, hardware: new HardwareProbe(async () => cpu(13)) });
  const qwenTurn = { model: 'local:ollama:qwen', messages: [{ role: 'user' as const, content: 'hi' }] };

  it('sizes a model listed while /api/show was too slow once a turn brings its shape', async () => {
    const ollamaState = flakyOllama();
    const local = new OllamaLocal(undefined, realSizing());
    ollamaState.showFails = true;
    expect((await local.models())[0].contextWindow).toBe(16384);
    ollamaState.showFails = false;
    await local.stream(qwenTurn, () => undefined);
    expect(ollamaState.sent).toEqual([32768]);
  });

  it('sizes a model again on its next turn when /api/tags failed on the first', async () => {
    const ollamaState = flakyOllama();
    const local = new OllamaLocal(undefined, realSizing());
    ollamaState.tagsFails = true;
    await local.stream(qwenTurn, () => undefined);
    ollamaState.tagsFails = false;
    await local.stream(qwenTurn, () => undefined);
    await local.stream(qwenTurn, () => undefined);
    expect(ollamaState.sent).toEqual([16384, 32768, 32768]);
  });

  it('keeps the last model list while /api/tags fails, and lists none once Ollama is not running', async () => {
    const ollamaState = flakyOllama();
    const local = new OllamaLocal();
    expect((await local.models()).map(model => model.name)).toEqual(['qwen']);
    ollamaState.tagsFails = true;
    expect((await local.models()).map(model => model.name)).toEqual(['qwen']);
    ollamaState.stopped = true;
    expect(await local.models()).toEqual([]);
  });

  it('lets a Settings change made while a model is being sized win', async () => {
    let setting: LocalContextSetting = AUTO_LOCAL_CONTEXT;
    let release: () => void = () => undefined;
    const held = new Promise<void>(resolve => {
      release = resolve;
    });
    const sent = ollama(trainedFor(131072));
    const measured = footprintOn(13);
    const footprint = vi.fn(async () => {
      await held;
      return measured;
    });
    const local = new OllamaLocal(undefined, {
      setting: async () => setting,
      footprint,
      cachedFootprint: () => measured,
    });
    const turn = local.stream(longTurn, () => undefined);
    await vi.waitFor(() => expect(footprint).toHaveBeenCalled());
    setting = { mode: 'fixed', tokens: 16384 };
    forgetLocalContexts();
    release();
    await turn;
    expect(sent()).toEqual([16384]);
    expect(await local.contextTokens('local:ollama:llama')).toBe(16384);
  });

  it('does not let a growth measured before a Settings change override it', async () => {
    let setting: LocalContextSetting = AUTO_LOCAL_CONTEXT;
    let release: () => void = () => undefined;
    const held = new Promise<void>(resolve => {
      release = resolve;
    });
    const sent = ollama(trainedFor(131072), () => overflow(70_000));
    const measured = footprintOn(13);
    let calls = 0;
    const footprint = vi.fn(async () => {
      if (++calls === 2) await held;
      return measured;
    });
    const local = new OllamaLocal(undefined, {
      setting: async () => setting,
      footprint,
      cachedFootprint: () => measured,
    });
    const turn = local.stream(longTurn, () => undefined);
    await vi.waitFor(() => expect(footprint).toHaveBeenCalledTimes(2));
    setting = { mode: 'fixed', tokens: 16384 };
    forgetLocalContexts();
    release();
    await expect(turn).rejects.toThrow('more than the 16384');
    expect(sent()).toEqual([65536]);
    expect(await local.contextTokens('local:ollama:llama')).toBe(16384);
  });

  it.each([
    { status: 503, error: 'server busy, please try again.  maximum pending requests exceeded' },
    { status: 500, error: 'unexpected EOF' },
  ])('keeps the Auto size after a $status that is not a failed load', async ({ status, error }) => {
    const sent = ollama(trainedFor(131072), () => Response.json({ error }, { status }));
    const local = new OllamaLocal(undefined, sizing(AUTO_LOCAL_CONTEXT, 13));
    await expect(local.stream(longTurn, () => undefined)).rejects.toThrow(`HTTP ${status}`);
    await local.stream(longTurn, () => undefined);
    expect(sent()).toEqual([65536, 65536]);
  });

  it("sends every request with the model's context as it is at send time", async () => {
    let releaseB: () => void = () => undefined;
    const heldB = new Promise<void>(resolve => {
      releaseB = resolve;
    });
    const sent: string[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: unknown, init?: RequestInit) => {
        const url = String(input);
        if (url.endsWith('/api/tags')) return Response.json({ models: [{ name: 'llama', size: 1, digest: 'one' }] });
        if (url.endsWith('/api/show')) return Response.json({ capabilities: ['completion'], ...trainedFor(131072) });
        const body = JSON.parse(String(init?.body)) as {
          options: { num_ctx: number };
          messages: { content: string }[];
        };
        const who = body.messages.at(-1)?.content ?? '';
        sent.push(`${who}:${body.options.num_ctx}`);
        if (who === 'b' && body.messages.length > 1) {
          await heldB;
          return overflow(30_000);
        }
        if (who === 'a' && sent.filter(entry => entry.startsWith('a:')).length === 1)
          return Response.json({ error: 'model requires more system memory' }, { status: 500 });
        return done();
      })
    );
    const local = new OllamaLocal(undefined, sizing(AUTO_LOCAL_CONTEXT, 13));
    const b = local.stream(
      {
        model: 'local:ollama:llama',
        messages: [
          { role: 'user', content: 'x'.repeat(40_000) },
          { role: 'assistant', content: 'ok' },
          { role: 'user', content: 'b' },
        ],
      },
      () => undefined
    );
    await vi.waitFor(() => expect(sent).toEqual(['b:65536']));
    await local.stream({ model: 'local:ollama:llama', messages: [{ role: 'user', content: 'a' }] }, () => undefined);
    releaseB();
    await b;
    expect(sent).toEqual(['b:65536', 'a:65536', 'a:16384', 'b:16384']);
  });

  it('grows Auto ahead of compaction, and not under a Fixed size', async () => {
    ollama(trainedFor(131072));
    expect(
      await new OllamaLocal(undefined, sizing(AUTO_LOCAL_CONTEXT, lowConfidence(64))).growFor(
        'local:ollama:llama',
        20_000
      )
    ).toBe(32768);
    forgetLocalContexts();
    expect(await new OllamaLocal(undefined, sizing(AUTO_LOCAL_CONTEXT, 13)).growFor('local:ollama:llama', 70_000)).toBe(
      73728
    );
    forgetLocalContexts();
    expect(
      await new OllamaLocal(undefined, sizing({ mode: 'fixed', tokens: 16384 }, 64)).growFor(
        'local:ollama:llama',
        20_000
      )
    ).toBeUndefined();
  });
});

describe('Ollama local-only inference', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });
  it.each([{ remote_host: 'https://ollama.com' }, { remote_model: 'private-cloud-alias' }])(
    'excludes remote metadata %j and refuses to send private prompts',
    async remote => {
      const fetchMock = vi.fn(async (input: unknown) =>
        String(input).endsWith('/api/tags')
          ? Response.json({ models: [{ name: 'alias' }] })
          : Response.json({ capabilities: ['completion'], ...remote })
      );
      vi.stubGlobal('fetch', fetchMock);
      const local = new OllamaLocal();
      expect(await local.models()).toEqual([]);
      await expect(
        local.stream({ model: 'local:ollama:alias', messages: [{ role: 'user', content: 'private' }] }, () => {})
      ).rejects.toThrow('Cloud-backed');
      expect(fetchMock.mock.calls.some(([input]) => String(input).endsWith('/api/chat'))).toBe(false);
    }
  );

  it('excludes remote tags before inspection and accepts empty remote fields for installed models', async () => {
    const fetchMock = vi.fn(async (input: unknown) =>
      String(input).endsWith('/api/tags')
        ? Response.json({
            models: [
              { name: 'remote', remote_host: 'https://ollama.com' },
              { name: 'local', remote_host: '', remote_model: '' },
            ],
          })
        : Response.json({ capabilities: ['completion'], remote_host: '', remote_model: '' })
    );
    vi.stubGlobal('fetch', fetchMock);
    expect((await new OllamaLocal().models()).map(model => model.id)).toEqual(['local:ollama:local']);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});
