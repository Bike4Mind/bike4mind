/**
 * A tool call's elapsed time used to be stashed on the thrown error itself via a Symbol
 * property write (`(error as Record<symbol, number>)[TOOL_DURATION_TAG] = durationMs`). A
 * frozen or otherwise non-extensible thrown error - `Object.freeze(new Error(...))`, which some
 * tools throw as immutable singletons - made that write throw a TypeError in strict mode
 * BEFORE the original error was re-thrown, so the batch outcome carried the unrelated
 * TypeError ("Cannot add property ..., object is not extensible") instead of the tool's real
 * error. That masked message is what got logged and pushed back to the model as the tool
 * result. The fix stores the duration in a module-private WeakMap keyed by the error object
 * instead of writing onto it, so a frozen error is read, not mutated.
 */
import { describe, it, expect } from 'vitest';
import { ChatModels } from '@bike4mind/common';
import { AnthropicBackend } from './anthropicBackend';
import type { ICompletionOptionTools } from './backend';

type CapturedParams = Record<string, unknown>;

const STOP_RECURSION = new Error('stop-recursion-sentinel');

/**
 * Mock Anthropic client:
 *  - turn 1: returns a `tool_use` content block so the backend executes the (throwing) tool
 *    and recurses with the tool result folded into the next turn's messages.
 *  - turn 2: throws a sentinel to stop recursion once the tool-result message is captured.
 */
function buildBackend(toolFn: () => Promise<never>) {
  const backend = new AnthropicBackend('test-key');
  const captured: CapturedParams[] = [];
  (backend as unknown as { _api: unknown })._api = {
    messages: {
      create: async (apiParams: Record<string, unknown>) => {
        captured.push(apiParams);
        if (captured.length === 1) {
          return {
            content: [{ type: 'tool_use', id: 'call_1', name: 'flaky_tool', input: {} }],
            usage: { input_tokens: 10, output_tokens: 5 },
          };
        }
        throw STOP_RECURSION;
      },
    },
  };

  const tool: ICompletionOptionTools = {
    toolSchema: {
      name: 'flaky_tool',
      description: 'A tool that always throws.',
      parameters: { type: 'object', properties: {} },
    },
    toolFn,
    _isMcpTool: true,
  };

  return { backend, tool, getCaptured: () => captured };
}

/** Pulls the tool_result text the backend pushed back for `toolUseId` out of a captured turn. */
function toolResultText(apiParams: CapturedParams, toolUseId: string): string | undefined {
  const messages = apiParams.messages as Array<{ role: string; content: unknown }>;
  for (const message of messages) {
    if (message.role !== 'user' || !Array.isArray(message.content)) continue;
    for (const block of message.content as Array<Record<string, unknown>>) {
      if (block.type === 'tool_result' && block.tool_use_id === toolUseId) {
        return typeof block.content === 'string' ? block.content : JSON.stringify(block.content);
      }
    }
  }
  return undefined;
}

async function runComplete(backend: AnthropicBackend, tool: ICompletionOptionTools): Promise<void> {
  try {
    await backend.complete(
      ChatModels.CLAUDE_4_8_OPUS,
      [{ role: 'user', content: 'hi' }],
      { stream: false, tools: [tool] },
      async () => undefined
    );
  } catch (err) {
    if (err !== STOP_RECURSION) throw err;
  }
}

describe('AnthropicBackend tool error integrity (frozen thrown errors)', () => {
  it('surfaces the real message of a frozen thrown error instead of a masking TypeError', async () => {
    const { backend, tool, getCaptured } = buildBackend(async () => {
      throw Object.freeze(new Error('x'));
    });

    await runComplete(backend, tool);

    const calls = getCaptured();
    expect(calls.length).toBe(2);
    const observation = toolResultText(calls[1], 'call_1');
    expect(observation).toContain('x');
    expect(observation).not.toContain('not extensible');
    expect(observation).not.toContain('Cannot add property');
  });

  it('still surfaces a non-frozen thrown error unchanged (no regression on the common case)', async () => {
    const { backend, tool, getCaptured } = buildBackend(async () => {
      throw new Error('boom');
    });

    await runComplete(backend, tool);

    const calls = getCaptured();
    const observation = toolResultText(calls[1], 'call_1');
    expect(observation).toContain('boom');
  });
});
