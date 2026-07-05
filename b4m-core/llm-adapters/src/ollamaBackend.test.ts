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
});
