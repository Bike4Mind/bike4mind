/**
 * Locks in the first-turn-only tool_choice behavior.
 *
 * Before the fix, OpenAIBackend re-spread `...options` on its post-tool-execution
 * recursion, so a caller-supplied `tool_choice` (a forced function or `required`)
 * persisted on every turn. Forcing a function therefore made the model call it
 * repeatedly up to the tool-call cap and never synthesize.
 *
 * After the fix, a caller-supplied `tool_choice` applies to the FIRST model turn
 * only; once a tool has executed, recursion uses `tool_choice: 'auto'` so the model
 * reads the tool result and synthesizes.
 *
 * The tool used here is flagged `_isMcpTool: true` so that tools (and therefore the
 * `tool_choice` parameter) survive onto the recursive request - that is the path
 * that previously re-forced the function and is exactly what we want to assert.
 *
 * Model note: these exercise the /v1/chat/completions path, so they use a non-routed
 * model (GPT-4o). The base GPT-5 family now routes tool turns to /v1/responses
 * - its equivalent first-turn-only tool_choice behavior is covered in
 * openaiBackend.responsesRouting.test.ts.
 */

import { describe, it, expect } from 'vitest';
import { Stream } from 'openai/streaming';
import { ChatModels } from '@bike4mind/common';
import { OpenAIBackend } from './openaiBackend';
import { DEFAULT_MAX_TOOL_CALLS, type ICompletionOptions, type ICompletionOptionTools } from './backend';

const SENTINEL = new Error('captured-params-sentinel');

type CapturedParams = Record<string, unknown>;

/**
 * Builds a backend whose mock OpenAI client:
 *  - turn 1: returns a tool_calls response so the backend executes the tool and recurses
 *  - turn 2: throws a non-retryable sentinel so recursion stops once we've captured params
 * Every request's params are recorded in order.
 */
function buildBackend() {
  const backend = new OpenAIBackend('test-key');
  const captured: CapturedParams[] = [];
  (backend as unknown as { _api: unknown })._api = {
    chat: {
      completions: {
        create: async (params: Record<string, unknown>) => {
          captured.push(params);
          if (captured.length === 1) {
            // Turn 1: force a tool call so the adapter executes it and recurses.
            return {
              choices: [
                {
                  index: 0,
                  message: {
                    role: 'assistant',
                    content: null,
                    tool_calls: [
                      {
                        id: 'call_1',
                        type: 'function',
                        function: { name: 'get_weather', arguments: '{"city":"NYC"}' },
                      },
                    ],
                  },
                  finish_reason: 'tool_calls',
                },
              ],
              usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
            };
          }
          // Turn 2 (post-tool recursion): stop here, but params are already captured.
          throw SENTINEL;
        },
      },
    },
  };
  return { backend, getCaptured: () => captured };
}

const mcpTool: ICompletionOptionTools = {
  toolSchema: {
    name: 'get_weather',
    description: 'Get the current weather for a city.',
    parameters: {
      type: 'object',
      properties: { city: { type: 'string', description: 'City name' } },
      required: ['city'],
    },
  },
  toolFn: async () => 'sunny',
  // MCP flag keeps tools (and thus tool_choice) alive on recursion - the path under test.
  _isMcpTool: true,
};

async function runComplete(backend: OpenAIBackend, options: Partial<ICompletionOptions>): Promise<void> {
  try {
    await backend.complete(ChatModels.GPT4o, [{ role: 'user', content: 'hi' }], options, async () => undefined);
  } catch (err) {
    if (err !== SENTINEL) throw err;
  }
}

describe('OpenAIBackend tool_choice is first-turn-only (#9367)', () => {
  it('honors a forced function on turn 1 and reverts to auto on post-tool recursion', async () => {
    const { backend, getCaptured } = buildBackend();

    await runComplete(backend, {
      stream: false,
      tools: [mcpTool],
      tool_choice: { type: 'function', function: { name: 'get_weather' } },
    });

    const calls = getCaptured();
    // Two requests: the forced first turn, then the post-tool recursion.
    expect(calls.length).toBe(2);
    // Turn 1 carries the caller's forced function.
    expect(calls[0].tool_choice).toEqual({ type: 'function', function: { name: 'get_weather' } });
    // Turn 2 reverts to auto - the model is free to synthesize, not re-forced.
    expect(calls[1].tool_choice).toBe('auto');
  });

  it("treats tool_choice: 'required' as first-turn-only too", async () => {
    const { backend, getCaptured } = buildBackend();

    await runComplete(backend, {
      stream: false,
      tools: [mcpTool],
      tool_choice: 'required',
    });

    const calls = getCaptured();
    expect(calls.length).toBe(2);
    expect(calls[0].tool_choice).toBe('required');
    expect(calls[1].tool_choice).toBe('auto');
  });

  it('does not force any tool on turn 1 when the caller supplies no tool_choice', async () => {
    const { backend, getCaptured } = buildBackend();

    await runComplete(backend, {
      stream: false,
      tools: [mcpTool],
    });

    const calls = getCaptured();
    expect(calls.length).toBe(2);
    // No caller tool_choice -> turn 1 leaves it unset (OpenAI defaults to auto).
    expect(calls[0].tool_choice).toBeUndefined();
    // Recursion still uses auto, which is the API default - no behavioral change.
    expect(calls[1].tool_choice).toBe('auto');
  });
});

/**
 * Streaming-path coverage. In production, stream-capable models take the streaming
 * branch, so the recursion that resets tool_choice runs at a different site than the
 * non-streaming tests above exercise. The mock returns a real `Stream`-prototyped
 * async-iterable on turn 1 (so `response instanceof Stream` is true and the backend
 * takes the streaming branch), emitting tool-call deltas; turn 2 throws the sentinel.
 */
function buildStreamingBackend() {
  const backend = new OpenAIBackend('test-key');
  const captured: CapturedParams[] = [];
  (backend as unknown as { _api: unknown })._api = {
    chat: {
      completions: {
        create: async (params: Record<string, unknown>) => {
          captured.push(params);
          if (captured.length === 1) {
            // Turn 1: a streamed tool call across two chunks, then a usage/finish chunk.
            const stream = Object.create(Stream.prototype) as Stream<unknown>;
            (stream as unknown as { [Symbol.asyncIterator]: () => AsyncGenerator<unknown> })[Symbol.asyncIterator] =
              async function* () {
                yield {
                  choices: [
                    {
                      index: 0,
                      delta: {
                        tool_calls: [
                          {
                            index: 0,
                            id: 'call_1',
                            type: 'function',
                            function: { name: 'get_weather', arguments: '{"city":"NYC"}' },
                          },
                        ],
                      },
                      finish_reason: null,
                    },
                  ],
                };
                yield {
                  choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }],
                  usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
                };
              };
            return stream;
          }
          // Turn 2 (post-tool recursion): stop here, params already captured.
          throw SENTINEL;
        },
      },
    },
  };
  return { backend, getCaptured: () => captured };
}

describe('OpenAIBackend tool_choice is first-turn-only — streaming path (#9367)', () => {
  it('honors a forced function on turn 1 and reverts to auto on the streaming recursion', async () => {
    const { backend, getCaptured } = buildStreamingBackend();

    await runComplete(backend, {
      stream: true,
      tools: [mcpTool],
      tool_choice: { type: 'function', function: { name: 'get_weather' } },
    });

    const calls = getCaptured();
    expect(calls.length).toBe(2);
    // Confirm we actually took the streaming branch (params.stream forwarded as true).
    expect(calls[0].stream).toBe(true);
    // Turn 1 carries the caller's forced function.
    expect(calls[0].tool_choice).toEqual({ type: 'function', function: { name: 'get_weather' } });
    // Turn 2 reverts to auto - the model is free to synthesize, not re-forced.
    expect(calls[1].tool_choice).toBe('auto');
  });

  it("treats tool_choice: 'required' as first-turn-only on the streaming path too", async () => {
    const { backend, getCaptured } = buildStreamingBackend();

    await runComplete(backend, {
      stream: true,
      tools: [mcpTool],
      tool_choice: 'required',
    });

    const calls = getCaptured();
    expect(calls.length).toBe(2);
    expect(calls[0].stream).toBe(true);
    expect(calls[0].tool_choice).toBe('required');
    expect(calls[1].tool_choice).toBe('auto');
  });
});

/**
 * Behavioral proof (not request-shape): instead of inspecting params, this drives the
 * actual recursion loop with a mock that behaves like a tool_choice-obedient model -
 * it returns a tool call whenever tool_choice forces one and a final answer when it is
 * 'auto'. With the fix, the tool is forced on turn 1, executes once, then turn 2 uses
 * 'auto' so the model synthesizes and the loop ends -> exactly ONE execution. Without the
 * fix, the forced choice persists every turn and the loop runs all the way to the
 * DEFAULT_MAX_TOOL_CALLS cap before tools are force-disabled - the exact "never
 * synthesize" symptom. So this asserts the consequence, and fails loudly if
 * the override regresses.
 */
describe('OpenAIBackend forced tool_choice does not loop (#9367 behavioral)', () => {
  it('executes the forced tool exactly once, then synthesizes', async () => {
    let toolExecCount = 0;
    const tool: ICompletionOptionTools = {
      toolSchema: {
        name: 'get_weather',
        description: 'Get the current weather for a city.',
        parameters: {
          type: 'object',
          properties: { city: { type: 'string', description: 'City name' } },
          required: ['city'],
        },
      },
      toolFn: async () => {
        toolExecCount++;
        return 'sunny';
      },
      _isMcpTool: true,
    };

    const backend = new OpenAIBackend('test-key');
    let callId = 0;
    (backend as unknown as { _api: unknown })._api = {
      chat: {
        completions: {
          // Obedient model: emit a tool call while tool_choice forces one, else answer.
          create: async (params: Record<string, unknown>) => {
            const tc = params.tool_choice;
            const forced =
              tc === 'required' ||
              (typeof tc === 'object' && tc !== null && (tc as { type?: string }).type === 'function');
            if (forced) {
              callId++;
              return {
                choices: [
                  {
                    index: 0,
                    message: {
                      role: 'assistant',
                      content: null,
                      tool_calls: [
                        {
                          id: `call_${callId}`,
                          type: 'function',
                          function: { name: 'get_weather', arguments: '{"city":"NYC"}' },
                        },
                      ],
                    },
                    finish_reason: 'tool_calls',
                  },
                ],
                usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
              };
            }
            return {
              choices: [
                { index: 0, message: { role: 'assistant', content: 'It is sunny in NYC.' }, finish_reason: 'stop' },
              ],
              usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
            };
          },
        },
      },
    };

    const out: string[] = [];
    await backend.complete(
      ChatModels.GPT4o,
      [{ role: 'user', content: 'weather?' }],
      { stream: false, tools: [tool], tool_choice: { type: 'function', function: { name: 'get_weather' } } },
      async (results: (string | null)[]) => {
        for (const r of results) if (r) out.push(r);
      }
    );

    // Fix present -> forced once, then 'auto' lets the model synthesize and the loop ends.
    // Fix absent -> forced every turn -> loops to the DEFAULT_MAX_TOOL_CALLS cap.
    expect(toolExecCount).toBe(1);
    // And the model actually synthesized a final answer rather than looping forever.
    expect(out.join('')).toContain('sunny');
  });
});

/**
 * Common-path regression sweep.
 *
 * The fix edits the SHARED post-tool-execution recursion in complete(), which every
 * multi-round tool interaction runs through with the default `executeTools: true`. The
 * cases above prove the FORCED path; these prove the far more common UNFORCED `auto`/unset
 * path is unchanged across the scenarios real traffic exercises - single tool, chained
 * tools, parallel tools in one turn, and blowing past the tool-call cap. They pass on
 * pre- and post-fix code (the bug only manifests when a caller forces a tool), so they are
 * regression guards that lock the common behavior as the recursion path evolves.
 *
 * `create` is driven by call-count and whether the request still carries tools - a model
 * cannot call a tool it was not given, so once tools are stripped (cap hit / built-in
 * tools that don't chain) the mock synthesizes, exactly like a real model.
 */
type ChatResponse = Record<string, unknown>;
function toolCallResponse(calls: { id: string; name: string; args: string }[]): ChatResponse {
  return {
    choices: [
      {
        index: 0,
        message: {
          role: 'assistant',
          content: null,
          tool_calls: calls.map(c => ({ id: c.id, type: 'function', function: { name: c.name, arguments: c.args } })),
        },
        finish_reason: 'tool_calls',
      },
    ],
    usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
  };
}
function finalResponse(text: string): ChatResponse {
  return {
    choices: [{ index: 0, message: { role: 'assistant', content: text }, finish_reason: 'stop' }],
    usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
  };
}
function countingTool(name: string, result: string, counter: { n: number }, isMcp = true): ICompletionOptionTools {
  return {
    toolSchema: {
      name,
      description: `Test tool ${name}.`,
      parameters: { type: 'object', properties: { q: { type: 'string', description: 'query' } }, required: [] },
    },
    toolFn: async () => {
      counter.n++;
      return result;
    },
    _isMcpTool: isMcp,
  };
}

describe('OpenAIBackend common tool path is unchanged (#9368 regression sweep)', () => {
  it('answers "what is the weather today" with one tool call, then synthesizes (default auto path)', async () => {
    const weather = { n: 0 };
    // weather_info is a built-in (non-MCP) tool in the app; built-ins don't chain, so tools
    // are dropped after the first turn and the model synthesizes on the next.
    const tool = countingTool('weather_info', 'Sunny, 72°F', weather, false);

    const backend = new OpenAIBackend('test-key');
    const captured: CapturedParams[] = [];
    let call = 0;
    (backend as unknown as { _api: unknown })._api = {
      chat: {
        completions: {
          create: async (params: Record<string, unknown>) => {
            captured.push(params);
            call++;
            if (call === 1) return toolCallResponse([{ id: 'c1', name: 'weather_info', args: '{}' }]);
            return finalResponse('It is sunny and 72°F today.');
          },
        },
      },
    };

    const out: string[] = [];
    await backend.complete(
      ChatModels.GPT4o,
      [{ role: 'user', content: 'what is the weather today' }],
      { stream: false, tools: [tool] },
      async (results: (string | null)[]) => {
        for (const r of results) if (r) out.push(r);
      }
    );

    expect(weather.n).toBe(1); // tool ran exactly once - no repeated-call loop
    expect(out.join('')).toContain('sunny'); // model synthesized a natural-language answer
    expect(captured.length).toBe(2); // one tool turn + one synthesis turn
    expect(captured[0].tool_choice).toBeUndefined(); // common path: nothing is forced on turn 1
  });

  it('chains two tools across turns, then synthesizes (auto path, multi-round)', async () => {
    const search = { n: 0 };
    const weather = { n: 0 };
    const tools = [
      countingTool('web_search', 'Acme raised guidance', search),
      countingTool('weather_info', 'Sunny', weather),
    ];

    const backend = new OpenAIBackend('test-key');
    const captured: CapturedParams[] = [];
    let call = 0;
    (backend as unknown as { _api: unknown })._api = {
      chat: {
        completions: {
          create: async (params: Record<string, unknown>) => {
            captured.push(params);
            call++;
            if (call === 1) return toolCallResponse([{ id: 'c1', name: 'web_search', args: '{}' }]);
            if (call === 2) return toolCallResponse([{ id: 'c2', name: 'weather_info', args: '{}' }]);
            return finalResponse('Here is the combined summary.');
          },
        },
      },
    };

    const out: string[] = [];
    await backend.complete(
      ChatModels.GPT4o,
      [{ role: 'user', content: 'search then check weather' }],
      { stream: false, tools },
      async (results: (string | null)[]) => {
        for (const r of results) if (r) out.push(r);
      }
    );

    expect(search.n).toBe(1);
    expect(weather.n).toBe(1);
    expect(out.join('')).toContain('summary');
    expect(captured.length).toBe(3);
    // Each recursive turn keeps tools available (MCP) and uses 'auto' - free to chain or stop.
    expect(captured[1].tool_choice).toBe('auto');
    expect(captured[2].tool_choice).toBe('auto');
  });

  it('runs two tools requested in a single turn (parallel), then synthesizes', async () => {
    const a = { n: 0 };
    const b = { n: 0 };
    const tools = [countingTool('weather_info', 'Sunny', a), countingTool('sunrise_sunset', '7:58pm', b)];

    const backend = new OpenAIBackend('test-key');
    let call = 0;
    (backend as unknown as { _api: unknown })._api = {
      chat: {
        completions: {
          create: async () => {
            call++;
            if (call === 1)
              return toolCallResponse([
                { id: 'c1', name: 'weather_info', args: '{}' },
                { id: 'c2', name: 'sunrise_sunset', args: '{}' },
              ]);
            return finalResponse('Sunny, and sunset is at 7:58pm.');
          },
        },
      },
    };

    const out: string[] = [];
    await backend.complete(
      ChatModels.GPT4o,
      [{ role: 'user', content: 'weather and sunset?' }],
      { stream: false, tools },
      async (results: (string | null)[]) => {
        for (const r of results) if (r) out.push(r);
      }
    );

    expect(a.n).toBe(1); // both tools in the single turn executed exactly once
    expect(b.n).toBe(1);
    expect(out.join('')).toContain('sunset');
  });

  it('respects the tool-call cap and still answers when tools are stripped (latent-bug-fix path)', async () => {
    const weather = { n: 0 };
    const tool = countingTool('weather_info', 'Sunny', weather); // MCP -> tools persist until the cap strips them

    const backend = new OpenAIBackend('test-key');
    let id = 0;
    (backend as unknown as { _api: unknown })._api = {
      chat: {
        completions: {
          // Obedient-but-greedy model: keeps calling the tool while it HAS tools; once the
          // backend strips tools at the cap, it can no longer call and must synthesize.
          create: async (params: Record<string, unknown>) => {
            const hasTools = Array.isArray(params.tools) && params.tools.length > 0;
            if (hasTools) {
              id++;
              return toolCallResponse([{ id: `c${id}`, name: 'weather_info', args: '{}' }]);
            }
            return finalResponse('Final answer after the cap.');
          },
        },
      },
    };

    const out: string[] = [];
    // Should NOT throw (pre-fix, the stripped-tools turn could carry a stale named tool_choice
    // with no tools, which OpenAI rejects). Should terminate at the cap with a normal answer.
    await backend.complete(
      ChatModels.GPT4o,
      [{ role: 'user', content: 'keep researching' }],
      { stream: false, tools: [tool] },
      async (results: (string | null)[]) => {
        for (const r of results) if (r) out.push(r);
      }
    );

    expect(weather.n).toBe(DEFAULT_MAX_TOOL_CALLS); // looped exactly to the cap, no further
    expect(out.join('')).toContain('Final answer'); // synthesized after tools were stripped
  });
});
