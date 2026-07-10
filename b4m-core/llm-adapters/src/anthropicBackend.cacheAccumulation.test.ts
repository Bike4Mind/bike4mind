/**
 * Anthropic bills cache read/write per API call, so a multi-turn tool loop
 * must SUM cache counts across turns like input/output tokens. Previously only
 * the final turn's cache counts reached the callback, under-reporting COGS for
 * every tool session with caching enabled. These tests drive complete()
 * through a real 2-turn tool recursion with a mocked client and assert the
 * terminal CompletionInfo carries the summed counts.
 */

import { describe, it, expect } from 'vitest';
import { ChatModels } from '@bike4mind/common';
import { AnthropicBackend } from './anthropicBackend';
import type { CompletionInfo, ICompletionOptionTools } from './backend';

type Usage = Record<string, number>;

function buildBackend(turnUsages: Usage[]) {
  const backend = new AnthropicBackend('test-key');
  let turn = 0;
  (backend as unknown as { _api: unknown })._api = {
    messages: {
      create: async () => {
        const usage = turnUsages[turn];
        turn += 1;
        if (turn < turnUsages.length) {
          // Non-terminal turn: model calls the tool -> backend executes and recurses.
          return {
            content: [{ type: 'tool_use', id: `call_${turn}`, name: 'get_weather', input: { city: 'NYC' } }],
            usage,
          };
        }
        // Terminal turn: plain text ends the loop.
        return {
          content: [{ type: 'text', text: 'sunny in NYC' }],
          usage,
        };
      },
    },
  };
  return backend;
}

const weatherTool: ICompletionOptionTools = {
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
  _isMcpTool: true,
};

async function completeAndCapture(backend: AnthropicBackend): Promise<CompletionInfo | undefined> {
  let lastInfo: CompletionInfo | undefined;
  await backend.complete(
    ChatModels.CLAUDE_4_8_OPUS,
    [{ role: 'user', content: 'weather?' }],
    { stream: false, tools: [weatherTool] },
    async (_text, info) => {
      if (info) lastInfo = info;
    }
  );
  return lastInfo;
}

describe('AnthropicBackend multi-turn cache accumulation', () => {
  it('sums cache read/write tokens across a 2-turn tool loop', async () => {
    const backend = buildBackend([
      { input_tokens: 10, output_tokens: 5, cache_read_input_tokens: 100, cache_creation_input_tokens: 200 },
      { input_tokens: 20, output_tokens: 8, cache_read_input_tokens: 50, cache_creation_input_tokens: 25 },
    ]);

    const info = await completeAndCapture(backend);

    expect(info).toBeDefined();
    expect(info!.inputTokens).toBe(30);
    expect(info!.outputTokens).toBe(13);
    expect(info!.cacheReadInputTokens).toBe(150);
    expect(info!.cacheCreationInputTokens).toBe(225);
  });

  it('sums when only the first turn had cache activity (terminal turn all-fresh)', async () => {
    const backend = buildBackend([
      { input_tokens: 10, output_tokens: 5, cache_read_input_tokens: 300, cache_creation_input_tokens: 40 },
      { input_tokens: 20, output_tokens: 8 },
    ]);

    const info = await completeAndCapture(backend);

    expect(info!.cacheReadInputTokens).toBe(300);
    expect(info!.cacheCreationInputTokens).toBe(40);
  });

  it('omits cache fields entirely when no turn used the cache (preserves the pre-cache callback shape)', async () => {
    const backend = buildBackend([
      { input_tokens: 10, output_tokens: 5 },
      { input_tokens: 20, output_tokens: 8 },
    ]);

    const info = await completeAndCapture(backend);

    expect(info!.cacheReadInputTokens).toBeUndefined();
    expect(info!.cacheCreationInputTokens).toBeUndefined();
  });
});
