/**
 * Regression test: bare JSON.parse crash on truncated tool parameter streams.
 *
 * When the Anthropic stream is interrupted mid-tool-call, toolsUsed[i].arguments carries the
 * raw partial JSON string. The streaming callback in ChatCompletionProcess was calling
 * JSON.parse(tool.arguments) inside a bare .map(), crashing the Lambda. This pins that
 * complete() resolves instead of throwing when tool parameter JSON is truncated.
 */

import { describe, it, expect } from 'vitest';
import { AnthropicBackend } from '../anthropicBackend';
import { ChatModels } from '@bike4mind/common';

function asyncIterable(events: unknown[]) {
  return {
    [Symbol.asyncIterator]: async function* () {
      for (const e of events) yield e;
    },
    controller: { abort: () => {} },
  };
}

function buildBackend() {
  const backend = new AnthropicBackend('test-key');
  const responseQueue: unknown[][] = [];
  type AnthropicApiMock = { messages: { create: (...args: unknown[]) => unknown } };
  (backend as unknown as { _api: AnthropicApiMock })._api = {
    messages: { create: async () => asyncIterable(responseQueue.shift() ?? []) },
  };
  return {
    backend,
    enqueue: (...turns: unknown[][]) => turns.forEach(t => responseQueue.push(t)),
  };
}

// Reproduces the exact stream seen in production: tool param JSON truncated at byte 55,
// missing the closing `}`.
function truncatedToolCallTurn(): unknown[] {
  return [
    { type: 'message_start', message: { usage: { input_tokens: 10, output_tokens: 0 } } },
    {
      type: 'content_block_start',
      index: 0,
      content_block: { type: 'tool_use', id: 'tool_01', name: 'excel_generation', input: {} },
    },
    {
      type: 'content_block_delta',
      index: 0,
      delta: { type: 'input_json_delta', partial_json: '{"filename": "Hookworm_Tourism_Therapy_Business_Launch"' },
    },
    { type: 'content_block_stop', index: 0 },
    { type: 'message_delta', delta: { stop_reason: 'tool_use' }, usage: { input_tokens: 10, output_tokens: 5 } },
    { type: 'message_stop' },
  ];
}

function textTurn(text: string): unknown[] {
  return [
    { type: 'message_start', message: { usage: { input_tokens: 5, output_tokens: 0 } } },
    { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
    { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text } },
    { type: 'content_block_stop', index: 0 },
    { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { input_tokens: 5, output_tokens: 3 } },
    { type: 'message_stop' },
  ];
}

describe('AnthropicBackend — truncated tool parameter stream (#9328)', () => {
  it('resolves without throwing when tool parameter JSON is truncated mid-stream', async () => {
    const { backend, enqueue } = buildBackend();
    enqueue(truncatedToolCallTurn(), textTurn('Recovered after stream interruption.'));

    await expect(
      backend.complete(
        ChatModels.CLAUDE_4_8_OPUS,
        [{ role: 'user', content: 'generate an excel file' }],
        {
          stream: true,
          tools: [
            {
              toolSchema: {
                name: 'excel_generation',
                description: 'Generate an Excel file',
                parameters: { type: 'object', properties: {}, required: [] },
              },
              toolFn: async () => 'excel content',
            },
          ],
        },
        async (_, info) => {
          info?.toolsUsed?.map(t => JSON.parse(t.arguments || '{}'));
        }
      )
    ).resolves.not.toThrow();
  });
});
