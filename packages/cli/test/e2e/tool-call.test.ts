/**
 * E2E test: tool-call flow.
 *
 * The agent loop's most regression-prone surface during the Q1 decomposition.
 * If a refactor breaks tool dispatch, argument forwarding, result threading,
 * or the LLM-call sequence, this test catches it.
 *
 * Flow under test:
 *   1. User prompt -> LLM call #1
 *   2. LLM returns a tool_use -> agent executes the tool locally
 *   3. Agent feeds tool result back via pushToolMessages -> LLM call #2
 *   4. LLM returns final answer -> agent settles
 */

import { describe, it, expect, vi } from 'vitest';
import type { ICompletionOptionTools } from '@bike4mind/llm-adapters';
import { runAgent } from './harness.js';

function createEchoTool(name = 'echo'): ICompletionOptionTools & { calls: unknown[] } {
  const calls: unknown[] = [];
  const tool = {
    toolFn: vi.fn(async (params?: unknown) => {
      calls.push(params);
      const input = (params as { message?: string })?.message ?? '';
      return `echoed:${input}`;
    }),
    toolSchema: {
      name,
      description: `Echo tool that returns its input prefixed with "echoed:"`,
      parameters: {
        type: 'object' as const,
        properties: {
          message: {
            type: 'string',
            description: 'The string to echo back.',
          },
        },
        required: ['message'],
      },
    },
    calls,
  };
  return tool;
}

describe('e2e — tool-call flow', () => {
  it('executes a single tool call and feeds the result back to the LLM', async () => {
    const echo = createEchoTool();

    const result = await runAgent({
      prompt: 'Echo "hello"',
      tools: [echo],
      script: {
        turns: [
          // Turn 1: LLM asks to call the echo tool.
          {
            text: 'Calling echo.',
            toolsUsed: [{ name: 'echo', arguments: '{"message":"hello"}', id: 'call_1' }],
          },
          // Turn 2: LLM produces final answer using the tool result.
          { text: 'The tool returned echoed:hello' },
        ],
      },
      maxIterations: 5,
    });

    // Tool was actually invoked with the right args.
    expect(echo.toolFn).toHaveBeenCalledTimes(1);
    expect(echo.calls[0]).toEqual({ message: 'hello' });

    // The agent settled on the second-turn final answer.
    expect(result.finalAnswer).toBe('The tool returned echoed:hello');
    expect(result.toolCalls).toBe(1);

    // Two LLM calls (request + post-tool follow-up).
    expect(result.faux.callCount).toBe(2);

    // The agent emitted action + observation events for the tool.
    const actionEvents = result.events.filter(e => e.type === 'action');
    const observationEvents = result.events.filter(e => e.type === 'observation');
    expect(actionEvents).toHaveLength(1);
    expect(observationEvents).toHaveLength(1);
    expect(actionEvents[0].step?.metadata?.toolName).toBe('echo');
  });

  it('threads multiple sequential tool calls through the agent loop', async () => {
    const echo = createEchoTool('echo');

    const result = await runAgent({
      prompt: 'Echo "first" then "second"',
      tools: [echo],
      script: {
        turns: [
          {
            text: 'First call.',
            toolsUsed: [{ name: 'echo', arguments: '{"message":"first"}', id: 'call_1' }],
          },
          {
            text: 'Second call.',
            toolsUsed: [{ name: 'echo', arguments: '{"message":"second"}', id: 'call_2' }],
          },
          { text: 'Both done.' },
        ],
      },
      maxIterations: 5,
    });

    expect(echo.toolFn).toHaveBeenCalledTimes(2);
    expect(echo.calls).toEqual([{ message: 'first' }, { message: 'second' }]);
    expect(result.toolCalls).toBe(2);
    expect(result.finalAnswer).toBe('Both done.');
    expect(result.faux.callCount).toBe(3);
  });

  it('surfaces a tool failure as an observation and lets the LLM recover', async () => {
    const failing: ICompletionOptionTools = {
      toolFn: vi.fn(async () => {
        throw new Error('disk full');
      }),
      toolSchema: {
        name: 'flaky',
        description: 'Always throws.',
        parameters: { type: 'object', properties: {}, required: [] },
      },
    };

    const result = await runAgent({
      prompt: 'Try the flaky tool',
      tools: [failing],
      script: {
        turns: [
          {
            text: 'Trying flaky.',
            toolsUsed: [{ name: 'flaky', arguments: '{}', id: 'call_1' }],
          },
          // The agent feeds the failure back as an observation; LLM recovers.
          { text: 'Tool failed, here is the answer anyway.' },
        ],
      },
      maxIterations: 5,
    });

    expect(failing.toolFn).toHaveBeenCalledTimes(1);
    expect(result.finalAnswer).toBe('Tool failed, here is the answer anyway.');

    // The observation event for the failed tool exists and carries error context.
    const observation = result.events.find(e => e.type === 'observation');
    expect(observation).toBeDefined();
    expect(observation?.step?.content).toMatch(/disk full|error/i);
  });
});
