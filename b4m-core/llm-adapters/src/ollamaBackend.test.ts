import { describe, it, expect, vi } from 'vitest';
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
});
