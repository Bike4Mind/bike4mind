/**
 * Regression test for #13: DeepSeek's raw Bedrock Invoke API never returns token usage at all
 * (confirmed against AWS's documented response shape: `{ choices: [{ text, stop_reason }] }`),
 * so streaming completions always reported 0 input tokens. This backend now talks to Bedrock's
 * Converse API instead, which does report usage.
 */

import { describe, it, expect } from 'vitest';
import type { CompletionInfo } from '@bike4mind/common';
import { ChatModels } from '@bike4mind/common';
import DeepSeekBedrockBackend from './deepseek';
import type { ICompletionOptions } from '../backend';

class TestDeepSeekBackend extends DeepSeekBedrockBackend {
  protected override updateClientForModel(): void {
    // Skip the real client rebuild so the mock injected below survives.
  }
}

function asConverseStream(events: unknown[]) {
  return {
    [Symbol.asyncIterator]: async function* () {
      for (const event of events) {
        yield event;
      }
    },
  };
}

type ConverseInput = {
  messages: Array<{ role: string; content: Array<{ text: string }> }>;
  system?: Array<{ text: string }>;
};

describe('DeepSeekBedrockBackend streaming token reporting', () => {
  it('reports non-zero input/output tokens from the Converse stream metadata event', async () => {
    const backend = new TestDeepSeekBackend();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (backend as unknown as { _bedrockRuntime: any })._bedrockRuntime = {
      send: async () => ({
        stream: asConverseStream([
          { messageStart: { role: 'assistant' } },
          { contentBlockDelta: { delta: { reasoningContent: { text: 'thinking it through' } }, contentBlockIndex: 0 } },
          { contentBlockStop: { contentBlockIndex: 0 } },
          { contentBlockDelta: { delta: { text: 'Final answer.' }, contentBlockIndex: 1 } },
          { contentBlockStop: { contentBlockIndex: 1 } },
          { metadata: { usage: { inputTokens: 80, outputTokens: 12, totalTokens: 92 } } },
          { messageStop: { stopReason: 'end_turn' } },
        ]),
      }),
    };

    const calls: { text: (string | null | undefined)[]; info?: CompletionInfo }[] = [];
    await backend.complete(
      ChatModels.DEEPSEEK_R1_BEDROCK,
      [{ role: 'user', content: 'hi' }],
      { stream: true, tools: [] } as Partial<ICompletionOptions>,
      async (text, info) => {
        calls.push({ text, info });
      }
    );

    const finalInfo = calls[calls.length - 1]?.info;
    expect(finalInfo).toBeDefined();
    expect(finalInfo!.inputTokens).toBe(80);
    expect(finalInfo!.outputTokens).toBe(12);

    const combinedText = calls
      .flatMap(c => c.text)
      .filter(Boolean)
      .join('');
    expect(combinedText).toBe('<think>thinking it through</think>Final answer.');
  });

  it('merges consecutive same-role messages so Converse gets a strictly alternating list', async () => {
    const backend = new TestDeepSeekBackend();
    let captured: ConverseInput | undefined;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (backend as unknown as { _bedrockRuntime: any })._bedrockRuntime = {
      send: async (command: { input: ConverseInput }) => {
        captured = command.input;
        return {
          stream: asConverseStream([
            { contentBlockDelta: { delta: { text: 'ok' }, contentBlockIndex: 0 } },
            { messageStop: { stopReason: 'end_turn' } },
          ]),
        };
      },
    };

    await backend.complete(
      ChatModels.DEEPSEEK_R1_BEDROCK,
      [
        { role: 'system', content: 'You are helpful.' },
        { role: 'user', content: 'first' },
        { role: 'user', content: 'second' },
        { role: 'assistant', content: 'ack' },
        { role: 'user', content: 'third' },
      ],
      { stream: true, tools: [] } as Partial<ICompletionOptions>,
      async () => {}
    );

    expect(captured).toBeDefined();
    expect(captured!.system?.[0].text).toBe('You are helpful.');
    // The two leading user turns collapse into one; roles then alternate user/assistant/user.
    expect(captured!.messages.map(m => m.role)).toEqual(['user', 'assistant', 'user']);
    expect(captured!.messages[0].content[0].text).toBe('first\n\nsecond');
  });

  it('demotes a system-only payload to a single user turn (Converse requires >=1 message)', async () => {
    const backend = new TestDeepSeekBackend();
    let captured: ConverseInput | undefined;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (backend as unknown as { _bedrockRuntime: any })._bedrockRuntime = {
      send: async (command: { input: ConverseInput }) => {
        captured = command.input;
        return {
          stream: asConverseStream([
            { contentBlockDelta: { delta: { text: 'title' }, contentBlockIndex: 0 } },
            { messageStop: { stopReason: 'end_turn' } },
          ]),
        };
      },
    };

    await backend.complete(
      ChatModels.DEEPSEEK_R1_BEDROCK,
      [{ role: 'system', content: 'Give a title to this session.' }],
      { stream: true, tools: [] } as Partial<ICompletionOptions>,
      async () => {}
    );

    expect(captured).toBeDefined();
    expect(captured!.messages).toEqual([{ role: 'user', content: [{ text: 'Give a title to this session.' }] }]);
    // System text became the user turn, so no redundant system field.
    expect(captured!.system).toBeUndefined();
  });
});
