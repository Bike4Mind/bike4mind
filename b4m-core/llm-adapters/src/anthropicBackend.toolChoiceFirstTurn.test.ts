/**
 * Anthropic mirror of openaiBackend.toolChoiceFirstTurn.test.ts.
 *
 * AnthropicBackend has the same post-tool-execution recursion that re-spread `...options`,
 * so a caller-supplied `tool_choice` would persist on every turn. The fix overrides
 * `tool_choice: 'auto'` on the recursive `complete()` calls. Anthropic converts the
 * OpenAI-shaped `tool_choice` to its own wire format:
 *   - `'auto'`     -> `{ type: 'auto' }`
 *   - `'required'` -> `{ type: 'any' }`
 *   - `{ type: 'function', function: {...} }` -> `{ type: 'tool', name: ... }`
 *
 * These cases assert the CONVERTED `tool_choice` the backend sends to the Anthropic
 * client: the caller's forced choice on turn 1, then `{ type: 'auto' }` after the tool
 * executes. The tool is `_isMcpTool: true` so tools (and thus `tool_choice`) survive the
 * recursion - the path that previously re-forced the tool.
 */

import { describe, it, expect } from 'vitest';
import { ChatModels } from '@bike4mind/common';
import { AnthropicBackend } from './anthropicBackend';
import type { ICompletionOptions, ICompletionOptionTools } from './backend';

const SENTINEL = new Error('captured-params-sentinel');

type CapturedParams = Record<string, unknown>;

/**
 * Mock Anthropic client:
 *  - turn 1: returns a `tool_use` content block so the backend executes the tool and recurses
 *  - turn 2: throws a non-retryable sentinel so recursion stops once params are captured
 * Every request's apiParams are recorded in order.
 */
function buildBackend() {
  const backend = new AnthropicBackend('test-key');
  const captured: CapturedParams[] = [];
  (backend as unknown as { _api: unknown })._api = {
    messages: {
      create: async (apiParams: Record<string, unknown>) => {
        captured.push(apiParams);
        if (captured.length === 1) {
          // Turn 1: model calls the tool -> backend executes it and recurses.
          return {
            content: [{ type: 'tool_use', id: 'call_1', name: 'get_weather', input: { city: 'NYC' } }],
            usage: { input_tokens: 10, output_tokens: 5 },
          };
        }
        // Turn 2 (post-tool recursion): stop here, params already captured.
        throw SENTINEL;
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

async function runComplete(backend: AnthropicBackend, options: Partial<ICompletionOptions>): Promise<void> {
  try {
    await backend.complete(
      ChatModels.CLAUDE_4_8_OPUS,
      [{ role: 'user', content: 'hi' }],
      options,
      async () => undefined
    );
  } catch (err) {
    if (err !== SENTINEL) throw err;
  }
}

describe('AnthropicBackend tool_choice is first-turn-only (#9367)', () => {
  it('forces a named tool on turn 1 ({type:tool}) and reverts to {type:auto} on post-tool recursion', async () => {
    const { backend, getCaptured } = buildBackend();

    await runComplete(backend, {
      stream: false,
      tools: [mcpTool],
      tool_choice: { type: 'function', function: { name: 'get_weather' } },
    });

    const calls = getCaptured();
    expect(calls.length).toBe(2);
    // Turn 1 carries the caller's forced function, converted to Anthropic's wire format.
    expect(calls[0].tool_choice).toEqual({ type: 'tool', name: 'get_weather' });
    // Turn 2 reverts to auto - the model is free to synthesize, not re-forced.
    expect(calls[1].tool_choice).toEqual({ type: 'auto' });
  });

  it("converts 'required' to {type:any} on turn 1 and reverts to {type:auto} on recursion", async () => {
    const { backend, getCaptured } = buildBackend();

    await runComplete(backend, {
      stream: false,
      tools: [mcpTool],
      tool_choice: 'required',
    });

    const calls = getCaptured();
    expect(calls.length).toBe(2);
    expect(calls[0].tool_choice).toEqual({ type: 'any' });
    expect(calls[1].tool_choice).toEqual({ type: 'auto' });
  });
});
