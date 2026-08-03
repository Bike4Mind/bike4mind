import { afterEach, describe, it, expect, vi } from 'vitest';
import { OllamaBackend } from './ollamaBackend';
import type { ICompletionOptionTools } from './backend';

const silentLogger = { debug() {}, info() {}, warn() {}, error() {} } as any;

// Build a backend with a stubbed Ollama client whose chat() returns the queued
// responses in order (one per model round / recursion).
function makeBackend(chatResponses: unknown[]) {
  const backend = new OllamaBackend('http://localhost:11434', silentLogger);
  const chat = vi.fn();
  chatResponses.forEach(r => chat.mockResolvedValueOnce(r));
  (backend as any)._api = { chat };
  return { backend, chat };
}

const mathTool = (toolFn: ICompletionOptionTools['toolFn']): ICompletionOptionTools => ({
  toolFn,
  toolSchema: {
    name: 'math_evaluate',
    description: 'Evaluate math',
    parameters: { type: 'object', properties: { expression: { type: 'string' } }, required: ['expression'] },
  },
});

// Run a completion, returning the visible text plus the last tool list the
// backend surfaced via completionInfo (consumers assign functionCalls from this).
async function run(
  backend: OllamaBackend,
  options: Record<string, unknown>
): Promise<{ text: string; toolsUsed: Array<{ name: string }> }> {
  const out: string[] = [];
  let toolsUsed: Array<{ name: string }> = [];
  await backend.complete(
    'qwen2.5-coder:3b',
    [{ role: 'user', content: 'go' } as any],
    { stream: false, ...options } as any,
    async (texts, info) => {
      texts.forEach(t => {
        if (t) out.push(t);
      });
      if (info?.toolsUsed) toolsUsed = info.toolsUsed as Array<{ name: string }>;
    }
  );
  return { text: out.join(''), toolsUsed };
}

describe('OllamaBackend.complete tool loop', () => {
  it('executes a native tool call then returns the final answer, surfacing the call', async () => {
    const toolFn = vi.fn(async () => '4');
    const { backend, chat } = makeBackend([
      {
        message: {
          content: '',
          tool_calls: [{ function: { name: 'math_evaluate', arguments: { expression: '2+2' } } }],
        },
        prompt_eval_count: 5,
        eval_count: 1,
      },
      { message: { content: 'The answer is 4.', tool_calls: [] }, prompt_eval_count: 6, eval_count: 3 },
    ]);

    const { text, toolsUsed } = await run(backend, { executeTools: true, tools: [mathTool(toolFn)] });

    expect(toolFn).toHaveBeenCalledWith({ expression: '2+2' });
    expect(chat).toHaveBeenCalledTimes(2);
    expect(text).toContain('The answer is 4.');
    // The raw tool call must not leak into the visible reply...
    expect(text).not.toContain('math_evaluate');
    // ...but the terminal callback must still surface it (else functionCalls is lost).
    expect(toolsUsed.map(t => t.name)).toEqual(['math_evaluate']);
  });

  it('recovers a tool call emitted as fenced JSON content (no native tool_calls)', async () => {
    const toolFn = vi.fn(async () => '1554453600');
    const { backend, chat } = makeBackend([
      {
        message: {
          content: '```json\n{"name":"math_evaluate","arguments":{"expression":"34525*45024"}}\n```',
          tool_calls: [],
        },
        prompt_eval_count: 5,
        eval_count: 10,
      },
      { message: { content: 'Result: 1554453600', tool_calls: [] }, prompt_eval_count: 6, eval_count: 4 },
    ]);

    const { text, toolsUsed } = await run(backend, { executeTools: true, tools: [mathTool(toolFn)] });

    expect(toolFn).toHaveBeenCalledWith({ expression: '34525*45024' });
    expect(chat).toHaveBeenCalledTimes(2);
    expect(text).toContain('Result: 1554453600');
    // The fenced JSON must not be shown to the user.
    expect(text).not.toContain('```');
    expect(text).not.toContain('math_evaluate');
    expect(toolsUsed.map(t => t.name)).toEqual(['math_evaluate']);
  });

  it('recovers a fenced tool call preceded by preamble prose', async () => {
    const toolFn = vi.fn(async () => '4');
    const { backend, chat } = makeBackend([
      {
        // A real, offered tool wrapped in a fence after explanatory prose - the
        // old startsWith guard dropped this because it did not start with { or ```.
        message: {
          content:
            'Let me use the calculator:\n```json\n{"name":"math_evaluate","arguments":{"expression":"2+2"}}\n```',
          tool_calls: [],
        },
        prompt_eval_count: 5,
        eval_count: 10,
      },
      { message: { content: 'The answer is 4.', tool_calls: [] }, prompt_eval_count: 6, eval_count: 4 },
    ]);

    const { text, toolsUsed } = await run(backend, { executeTools: true, tools: [mathTool(toolFn)] });

    expect(toolFn).toHaveBeenCalledWith({ expression: '2+2' });
    expect(chat).toHaveBeenCalledTimes(2);
    expect(text).toContain('The answer is 4.');
    expect(toolsUsed.map(t => t.name)).toEqual(['math_evaluate']);
  });

  it('recovers a leading bare tool call even when the reply also contains an unrelated fence', async () => {
    const toolFn = vi.fn(async () => '4');
    const { backend, chat } = makeBackend([
      {
        // Bare call first, then a fenced example block. The fence must not become
        // the ONLY search source, or the real leading call would be dropped.
        message: {
          content: '{"name":"math_evaluate","arguments":{"expression":"2+2"}}\n```\nexample output\n```',
          tool_calls: [],
        },
        prompt_eval_count: 5,
        eval_count: 10,
      },
      { message: { content: 'The answer is 4.', tool_calls: [] }, prompt_eval_count: 6, eval_count: 4 },
    ]);

    const { text, toolsUsed } = await run(backend, { executeTools: true, tools: [mathTool(toolFn)] });

    expect(toolFn).toHaveBeenCalledWith({ expression: '2+2' });
    expect(chat).toHaveBeenCalledTimes(2);
    expect(text).toContain('The answer is 4.');
    expect(toolsUsed.map(t => t.name)).toEqual(['math_evaluate']);
  });

  it('recovers multiple content tool calls run together and skips unknown tools', async () => {
    const toolFn = vi.fn(async () => '1554453600');
    const { backend, chat } = makeBackend([
      {
        // Two objects, space-separated, no fence - exactly how a small model
        // emitted parallel calls. Only math_evaluate is a registered tool.
        message: {
          content:
            '{"name": "math_evaluate", "arguments": {"expression": "34525 * 45024"}} ' +
            '{"name": "web_fetch", "arguments": {"query": "turtles"}}',
          tool_calls: [],
        },
        prompt_eval_count: 5,
        eval_count: 20,
      },
      { message: { content: 'The product is 1554453600.', tool_calls: [] }, prompt_eval_count: 6, eval_count: 5 },
    ]);

    const { text } = await run(backend, { executeTools: true, tools: [mathTool(toolFn)] });

    expect(toolFn).toHaveBeenCalledTimes(1);
    expect(toolFn).toHaveBeenCalledWith({ expression: '34525 * 45024' });
    expect(chat).toHaveBeenCalledTimes(2);
    expect(text).toContain('The product is 1554453600.');
    expect(text).not.toContain('web_fetch');
    expect(text).not.toContain('math_evaluate');
  });

  it.each([
    ['function-as-name', '{"function": "math_evaluate", "arguments": {"expression": "2+2"}}'],
    ['nested function', '{"function": {"name": "math_evaluate", "arguments": {"expression": "2+2"}}}'],
    ['parameters alias', '{"name": "math_evaluate", "parameters": {"expression": "2+2"}}'],
  ])('recovers a content tool call shaped as %s', async (_label, content) => {
    const toolFn = vi.fn(async () => '4');
    const { backend } = makeBackend([
      { message: { content, tool_calls: [] }, prompt_eval_count: 5, eval_count: 8 },
      { message: { content: 'It is 4.', tool_calls: [] }, prompt_eval_count: 6, eval_count: 3 },
    ]);

    const { text } = await run(backend, { executeTools: true, tools: [mathTool(toolFn)] });

    expect(toolFn).toHaveBeenCalledWith({ expression: '2+2' });
    expect(text).toContain('It is 4.');
    expect(text).not.toContain('math_evaluate');
  });

  it('passes a plain answer through unchanged when no tool is called', async () => {
    const { backend, chat } = makeBackend([
      { message: { content: 'hello world', tool_calls: [] }, prompt_eval_count: 3, eval_count: 2 },
    ]);

    const { text } = await run(backend, { tools: [] });

    expect(chat).toHaveBeenCalledTimes(1);
    expect(text).toBe('hello world');
  });

  it('accumulates tool calls across rounds and stops once the round cap is reached', async () => {
    const toolFn = vi.fn(async () => 'x');
    const toolResp = {
      message: { content: '', tool_calls: [{ function: { name: 'math_evaluate', arguments: { expression: '1' } } }] },
      prompt_eval_count: 1,
      eval_count: 1,
    };
    const answerResp = { message: { content: 'done', tool_calls: [] }, prompt_eval_count: 1, eval_count: 1 };
    // maxToolCalls=2: round0 (tools) -> round1 (tools) -> round2 (tools stripped, must answer).
    const { backend, chat } = makeBackend([toolResp, toolResp, answerResp]);

    const { text, toolsUsed } = await run(backend, {
      executeTools: true,
      tools: [mathTool(toolFn)],
      _internal: { maxToolCalls: 2 },
    });

    expect(chat).toHaveBeenCalledTimes(3);
    expect(toolFn).toHaveBeenCalledTimes(2);
    expect(text).toContain('done');
    // Both tool rounds must be reflected in the surfaced list.
    expect(toolsUsed.map(t => t.name)).toEqual(['math_evaluate', 'math_evaluate']);
  });

  it('surfaces tool calls without executing them when executeTools is false', async () => {
    const toolFn = vi.fn(async () => 'should-not-run');
    const { backend, chat } = makeBackend([
      {
        message: {
          content: '',
          tool_calls: [{ function: { name: 'math_evaluate', arguments: { expression: '2+2' } } }],
        },
        prompt_eval_count: 5,
        eval_count: 2,
      },
    ]);

    const { text, toolsUsed } = await run(backend, { executeTools: false, tools: [mathTool(toolFn)] });

    // The tool is NOT run (the caller executes it), but the call IS surfaced,
    // and there is no recursion (a single model round).
    expect(toolFn).not.toHaveBeenCalled();
    expect(chat).toHaveBeenCalledTimes(1);
    expect(toolsUsed.map(t => t.name)).toEqual(['math_evaluate']);
    expect(text).not.toContain('math_evaluate');
  });

  it('does not loop on a native call to an unregistered tool; feeds back an error and answers', async () => {
    const toolFn = vi.fn(async () => 'should-not-run');
    const { backend, chat } = makeBackend([
      {
        // Model hallucinates a tool name that isn't registered.
        message: { content: '', tool_calls: [{ function: { name: 'nonexistent_tool', arguments: {} } }] },
        prompt_eval_count: 5,
        eval_count: 2,
      },
      { message: { content: 'Sorry, I will just answer: 42.', tool_calls: [] }, prompt_eval_count: 6, eval_count: 4 },
    ]);

    const { text, toolsUsed } = await run(backend, { executeTools: true, tools: [mathTool(toolFn)] });

    // One recursion at most (error fed back, then answer) - not maxToolCalls rounds.
    expect(chat).toHaveBeenCalledTimes(2);
    expect(toolFn).not.toHaveBeenCalled();
    expect(text).toContain('42');
    // The phantom call must not be reported as used.
    expect(toolsUsed.map(t => t.name)).not.toContain('nonexistent_tool');
  });

  it('ignores a tool-call-shaped object inside a <think> block (not a real call)', async () => {
    const toolFn = vi.fn(async () => 'nope');
    const { backend, chat } = makeBackend([
      {
        message: {
          content: '<think>{"name":"math_evaluate","arguments":{"expression":"2+2"}}</think>The answer is 4.',
          tool_calls: [],
        },
        prompt_eval_count: 5,
        eval_count: 6,
      },
    ]);

    const { text } = await run(backend, { executeTools: true, tools: [mathTool(toolFn)] });

    // The think-block JSON must not be executed as a tool call. (The <think> text
    // itself is passed through for the consumer to render, as before.)
    expect(toolFn).not.toHaveBeenCalled();
    expect(chat).toHaveBeenCalledTimes(1);
    expect(text).toContain('The answer is 4.');
  });

  it('ignores a tool call merely quoted inside prose (does not start the content)', async () => {
    const toolFn = vi.fn(async () => 'nope');
    const { backend, chat } = makeBackend([
      {
        message: {
          content: 'The math_evaluate tool takes {"name":"math_evaluate","arguments":{"expression":"2+2"}} as input.',
          tool_calls: [],
        },
        prompt_eval_count: 5,
        eval_count: 6,
      },
    ]);

    const { text } = await run(backend, { executeTools: true, tools: [mathTool(toolFn)] });

    expect(toolFn).not.toHaveBeenCalled();
    expect(chat).toHaveBeenCalledTimes(1);
    expect(text).toContain('The math_evaluate tool takes');
  });
});

// getModelInfo derives each model's flags from Ollama's own /api/show
// capabilities rather than a hardcoded list, so a thinking-capable model
// (e.g. qwen3.5) must surface can_think and drive the Thinking toggle.
describe('OllamaBackend.getModelInfo capability mapping', () => {
  function backendWithCapabilities(capabilities: string[]) {
    const backend = new OllamaBackend('http://localhost:11434', silentLogger);
    (backend as any)._api = {
      list: vi.fn(async () => ({ models: [{ name: 'qwen3.5:2b-q4_K_M' }] })),
      show: vi.fn(async () => ({ capabilities, model_info: { 'qwen35.context_length': 262144 } })),
    };
    return backend;
  }

  it('sets can_think, supportsVision and supportsTools from reported capabilities', async () => {
    const [info] = await backendWithCapabilities(['completion', 'vision', 'tools', 'thinking']).getModelInfo();
    expect(info.can_think).toBe(true);
    expect(info.supportsVision).toBe(true);
    expect(info.supportsTools).toBe(true);
    // Advertised as the window we will actually allocate (see effectiveContextWindow),
    // not the 262144 the model reports, so callers size history to what fits.
    expect(info.contextWindow).toBe(32768);
    expect(info.max_tokens).toBe(32768);
  });

  it('advertises a small model window verbatim', async () => {
    const backend = new OllamaBackend('http://localhost:11434', silentLogger);
    (backend as any)._api = {
      list: vi.fn(async () => ({ models: [{ name: 'qwen2.5-coder:3b' }] })),
      show: vi.fn(async () => ({ capabilities: ['tools'], model_info: { 'qwen2.context_length': 32768 } })),
    };
    const [info] = await backend.getModelInfo();
    expect(info.contextWindow).toBe(32768);
  });

  it('leaves can_think false when the model does not report thinking', async () => {
    const [info] = await backendWithCapabilities(['completion', 'tools']).getModelInfo();
    expect(info.can_think).toBe(false);
    expect(info.supportsTools).toBe(true);
    expect(info.supportsVision).toBe(false);
  });
});

// Ollama returns reasoning in a separate message.thinking field (not inline
// <think> tags); the backend must wrap it so the consumer renders it, and drive
// Ollama's think flag from the Thinking toggle.
describe('OllamaBackend thinking field', () => {
  it('wraps the separate thinking field in <think> tags ahead of the answer', async () => {
    const { backend } = makeBackend([
      { message: { content: '42', thinking: 'let me add', tool_calls: [] }, prompt_eval_count: 3, eval_count: 2 },
    ]);
    const { text } = await run(backend, { tools: [] });
    expect(text).toBe('<think>let me add</think>42');
  });

  it('passes think:true to Ollama when the thinking toggle is enabled', async () => {
    const { backend, chat } = makeBackend([
      { message: { content: 'ok', thinking: 'hmm', tool_calls: [] }, prompt_eval_count: 3, eval_count: 2 },
    ]);
    await run(backend, { tools: [], thinking: { enabled: true, budget_tokens: 16000 } });
    expect((chat.mock.calls[0][0] as { think?: boolean }).think).toBe(true);
  });

  it('omits think entirely when no thinking option is provided', async () => {
    const { backend, chat } = makeBackend([
      { message: { content: 'ok', tool_calls: [] }, prompt_eval_count: 3, eval_count: 2 },
    ]);
    await run(backend, { tools: [] });
    expect((chat.mock.calls[0][0] as { think?: boolean }).think).toBeUndefined();
  });
});

// Vision-capable local models receive images via Ollama's images[] field (raw
// base64), not the multimodal content-block array other providers use.
describe('OllamaBackend.buildMessages image handling', () => {
  const answer = [{ message: { content: 'ok', tool_calls: [] }, prompt_eval_count: 3, eval_count: 2 }];

  // Drive a plain completion and return the message the api chat call received.
  async function sentMessage(content: unknown) {
    const { backend, chat } = makeBackend(answer);
    await backend.complete('moondream', [{ role: 'user', content } as any], { stream: false } as any, async () => {});
    return (chat.mock.calls[0][0] as { messages: Array<{ content: string; images?: string[] }> }).messages[0];
  }

  it('maps an inline base64 image block to images[] and keeps text in content', async () => {
    const msg = await sentMessage([
      { type: 'text', text: 'What is this?' },
      { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'AAA' } },
    ]);
    expect(msg.content).toBe('What is this?');
    expect(msg.images).toEqual(['AAA']);
  });

  it('strips the data: URL prefix from an image_url block', async () => {
    const msg = await sentMessage([
      { type: 'text', text: 'describe' },
      { type: 'image_url', image_url: { url: 'data:image/jpeg;base64,BBB' } },
    ]);
    expect(msg.content).toBe('describe');
    expect(msg.images).toEqual(['BBB']);
  });

  it('drops a non-data image_url since Ollama needs inline base64', async () => {
    const msg = await sentMessage([
      { type: 'text', text: 'hi' },
      { type: 'image_url', image_url: { url: 'https://example.com/cat.png' } },
    ]);
    expect(msg.content).toBe('hi');
    expect(msg.images).toBeUndefined();
  });

  it('strips the prefix from a parameterized data: URL (e.g. charset)', async () => {
    const msg = await sentMessage([
      { type: 'text', text: 'x' },
      { type: 'image_url', image_url: { url: 'data:image/png;charset=utf-8;base64,CCC' } },
    ]);
    expect(msg.images).toEqual(['CCC']);
  });
});

// Ollama applies its own 4096-token default when a request carries no `options`
// object, truncating the prompt from the front - which drops the tool block out
// of the chat template and makes a tool-capable model answer that it has no
// tools. The backend must size num_ctx from the model's own window, and the
// same object is what carries temperature / maxTokens.
describe('OllamaBackend model options', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  // Backend whose /api/show reports `contextWindow`; returns the options object
  // the chat request was built with.
  async function sentOptions(
    contextWindow: number,
    completionOptions: Record<string, unknown> = {}
  ): Promise<Record<string, number> | undefined> {
    const backend = new OllamaBackend('http://localhost:11434', silentLogger);
    const chat = vi.fn(async () => ({
      message: { content: 'ok', tool_calls: [] },
      prompt_eval_count: 1,
      eval_count: 1,
    }));
    (backend as any)._api = {
      chat,
      show: vi.fn(async () => ({ capabilities: ['tools'], model_info: { 'qwen35.context_length': contextWindow } })),
    };
    await run(backend, { tools: [], ...completionOptions });
    return (chat.mock.calls[0][0] as { options?: Record<string, number> }).options;
  }

  it('caps num_ctx at the default ceiling for a huge advertised window', async () => {
    expect((await sentOptions(262144))?.num_ctx).toBe(32768);
  });

  it('uses the model window verbatim when it is under the ceiling', async () => {
    expect((await sentOptions(8192))?.num_ctx).toBe(8192);
  });

  it('honours an OLLAMA_MAX_NUM_CTX override', async () => {
    vi.stubEnv('OLLAMA_MAX_NUM_CTX', '16384');
    expect((await sentOptions(262144))?.num_ctx).toBe(16384);
  });

  it('ignores a non-positive OLLAMA_MAX_NUM_CTX and falls back to the default ceiling', async () => {
    vi.stubEnv('OLLAMA_MAX_NUM_CTX', '0');
    expect((await sentOptions(262144))?.num_ctx).toBe(32768);
  });

  it('forwards temperature and maxTokens (as num_predict)', async () => {
    const options = await sentOptions(8192, { temperature: 0.2, maxTokens: 512 });
    expect(options?.temperature).toBe(0.2);
    expect(options?.num_predict).toBe(512);
  });

  it('clamps num_predict to num_ctx (the catalogue reports max_tokens as the whole window)', async () => {
    expect((await sentOptions(262144, { maxTokens: 262144 }))?.num_predict).toBe(32768);
  });

  it('omits temperature and num_predict when the caller sets neither', async () => {
    const options = await sentOptions(8192);
    expect(options).toEqual({ num_ctx: 8192 });
  });

  it('still sends a num_ctx when /api/show is unavailable', async () => {
    const backend = new OllamaBackend('http://localhost:11434', silentLogger);
    const chat = vi.fn(async () => ({
      message: { content: 'ok', tool_calls: [] },
      prompt_eval_count: 1,
      eval_count: 1,
    }));
    (backend as any)._api = {
      chat,
      show: vi.fn(async () => {
        throw new Error('connection refused');
      }),
    };
    await run(backend, { tools: [] });
    expect((chat.mock.calls[0][0] as { options?: Record<string, number> }).options?.num_ctx).toBe(8192);
  });

  it('shows once across a multi-round tool loop', async () => {
    const backend = new OllamaBackend('http://localhost:11434', silentLogger);
    const chat = vi
      .fn()
      .mockResolvedValueOnce({
        message: {
          content: '',
          tool_calls: [{ function: { name: 'math_evaluate', arguments: { expression: '2+2' } } }],
        },
        prompt_eval_count: 5,
        eval_count: 1,
      })
      .mockResolvedValueOnce({ message: { content: '4', tool_calls: [] }, prompt_eval_count: 6, eval_count: 1 });
    const show = vi.fn(async () => ({ capabilities: ['tools'], model_info: { 'qwen35.context_length': 8192 } }));
    (backend as any)._api = { chat, show };
    await run(backend, { tools: [mathTool(async () => '4')] });
    expect(chat).toHaveBeenCalledTimes(2);
    expect(show).toHaveBeenCalledTimes(1);
  });
});

// The ollama client takes no per-request AbortSignal, so the backend binds one
// into the transport for that request. Without it a non-streaming round is a
// single blocking request that cancellation cannot interrupt.
describe('OllamaBackend request cancellation', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  // Stub global fetch (the backend's client calls through to it) and return the
  // RequestInit the /api/chat POST was issued with.
  async function chatRequestInit(
    completionOptions: Record<string, unknown>,
    body: (url: string) => Response
  ): Promise<RequestInit> {
    let chatInit: RequestInit | undefined;
    vi.stubGlobal('fetch', async (input: unknown, init: RequestInit) => {
      const url = String(input);
      if (url.endsWith('/api/chat')) chatInit = init;
      return body(url);
    });
    const backend = new OllamaBackend('http://localhost:11434', silentLogger);
    await run(backend, completionOptions);
    if (!chatInit) throw new Error('no /api/chat request was issued');
    return chatInit;
  }

  const jsonBody = (url: string) =>
    new Response(
      url.endsWith('/api/show')
        ? JSON.stringify({ capabilities: ['tools'], model_info: { 'qwen35.context_length': 8192 } })
        : JSON.stringify({ message: { content: 'ok' }, prompt_eval_count: 1, eval_count: 1, done_reason: 'stop' }),
      { status: 200, headers: { 'content-type': 'application/json' } }
    );

  it('attaches the caller signal to a non-streaming request', async () => {
    const controller = new AbortController();
    const init = await chatRequestInit({ tools: [], abortSignal: controller.signal }, jsonBody);
    expect(init.signal).toBe(controller.signal);
  });

  it('sends no signal when the caller provides none', async () => {
    const init = await chatRequestInit({ tools: [] }, jsonBody);
    expect(init.signal).toBeUndefined();
  });

  it('combines the caller signal with the client stream controller, so either cancels', async () => {
    const controller = new AbortController();
    const streamBody = (url: string) =>
      url.endsWith('/api/show')
        ? jsonBody(url)
        : new Response(
            new ReadableStream<Uint8Array>({
              start(c) {
                c.enqueue(
                  new TextEncoder().encode(
                    `${JSON.stringify({ message: { content: 'ok' }, done: true, done_reason: 'stop' })}\n`
                  )
                );
                c.close();
              },
            }),
            { status: 200 }
          );
    const init = await chatRequestInit({ tools: [], stream: true, abortSignal: controller.signal }, streamBody);
    // Not the caller's signal itself: the client's own per-stream controller is
    // merged in, so aborting either one aborts the request.
    expect(init.signal).toBeDefined();
    expect(init.signal).not.toBe(controller.signal);
    expect(init.signal!.aborted).toBe(false);
    controller.abort();
    expect(init.signal!.aborted).toBe(true);
  });
});

// Pressing Stop now aborts the transport, so an AbortError is the expected
// outcome of a cancelled request rather than a backend fault.
describe('OllamaBackend abort logging', () => {
  function backendThatAborts() {
    const logger = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() } as any;
    const backend = new OllamaBackend('http://localhost:11434', logger);
    const client = {
      show: vi.fn(async () => ({ capabilities: [], model_info: {} })),
      chat: vi.fn(async () => {
        const err = new Error('This operation was aborted');
        err.name = 'AbortError';
        throw err;
      }),
    };
    (backend as any)._api = client;
    // A request carrying an abortSignal builds its own signal-bound client, so
    // stubbing _api alone would let the call reach a real Ollama on this host.
    (backend as any).createClient = () => client;
    return { backend, logger };
  }

  it('does not log a user cancellation as an error, but still rethrows', async () => {
    const { backend, logger } = backendThatAborts();
    const controller = new AbortController();
    controller.abort();
    await expect(run(backend, { tools: [], abortSignal: controller.signal })).rejects.toThrow(
      'This operation was aborted'
    );
    expect(logger.error).not.toHaveBeenCalled();
    expect(logger.debug).toHaveBeenCalled();
  });

  it('still logs an abort with no cancellation behind it as an error', async () => {
    const { backend, logger } = backendThatAborts();
    const controller = new AbortController();
    await expect(run(backend, { tools: [], abortSignal: controller.signal })).rejects.toThrow(
      'This operation was aborted'
    );
    expect(logger.error).toHaveBeenCalled();
  });
});

// This backend is the odd one out among the strip sites: it withholds tools IN PLACE for the round
// rather than recursing with `tools: undefined`, so the strip has to track its own `offerTools` flag.
// That different shape is why it gets its own test rather than leaning on the Anthropic one.
describe('OllamaBackend drops tool-dependent prompts once it stops offering tools', () => {
  const IMAGE_PROMPT = 'When the user requests an image, you MUST use the image_generation tool to create it.';

  it('sends the prompt while tools are offered and withholds it on the tool-less round', async () => {
    const { backend, chat } = makeBackend([
      {
        message: {
          content: '',
          tool_calls: [{ function: { name: 'math_evaluate', arguments: { expression: '2+2' } } }],
        },
        prompt_eval_count: 5,
        eval_count: 1,
      },
      { message: { content: 'Done.', tool_calls: [] }, prompt_eval_count: 6, eval_count: 2 },
    ]);

    await backend.complete(
      'qwen2.5-coder:3b',
      [
        { role: 'system', content: IMAGE_PROMPT, requiresTool: 'image_generation' },
        { role: 'system', content: 'Format replies as markdown.' },
        { role: 'user', content: 'go' },
      ] as any,
      {
        stream: false,
        executeTools: true,
        tools: [mathTool(async () => '4')],
        // Round 0 is under the cap and offers tools; the post-tool round is at it and must not.
        _internal: { maxToolCalls: 1 },
      } as any,
      async () => undefined
    );

    expect(chat).toHaveBeenCalledTimes(2);
    const req = (n: number) => chat.mock.calls[n][0] as { messages: unknown; tools?: unknown[] };
    const round = (n: number) => JSON.stringify(req(n).messages);
    // Control: round 0 genuinely offers tools, so the instruction belongs there.
    expect(req(0).tools?.length ?? 0).toBeGreaterThan(0);
    expect(round(0)).toContain('MUST use the image_generation tool');
    // The round under test carries no tools at all - that is the state the strip tracks.
    expect(req(1).tools?.length ?? 0).toBe(0);

    // Tools are gone on this round, so the instruction ordering one must be gone with them - while
    // the system prompt that never depended on a tool survives.
    expect(round(1)).not.toContain('MUST use the image_generation tool');
    expect(round(1)).toContain('Format replies as markdown');
  });
});
