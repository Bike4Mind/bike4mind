/**
 * Confirms CompletionInfo.stopReason is populated end-to-end through complete()
 * for every non-Anthropic backend, both for a clean finish and a truncated
 * (max_tokens-equivalent) one. Complements stopReason.test.ts, which covers the
 * normalization mapping in isolation.
 */
import { describe, it, expect } from 'vitest';
import { Stream } from 'openai/streaming';
import { ChatModels } from '@bike4mind/common';
import { OpenAIBackend } from './openaiBackend';
import { XAIBackend } from './xaiBackend';
import { GeminiBackend } from './geminiBackend';
import { OllamaBackend } from './ollamaBackend';

async function runAndCaptureStopReason(
  backend: { complete: (...args: unknown[]) => Promise<void> },
  model: string,
  options: Record<string, unknown>
): Promise<string | undefined> {
  let stopReason: string | undefined;
  await backend.complete(
    model,
    [{ role: 'user', content: 'hi' }],
    options,
    async (_texts: unknown, info?: { stopReason?: string }) => {
      if (info?.stopReason) stopReason = info.stopReason;
    }
  );
  return stopReason;
}

function openAIStream(finishReason: string) {
  const stream = Object.create(Stream.prototype) as Stream<unknown>;
  (stream as unknown as { [Symbol.asyncIterator]: () => AsyncGenerator<unknown> })[Symbol.asyncIterator] =
    async function* () {
      yield { choices: [{ index: 0, delta: { content: 'hi' }, finish_reason: null }] };
      yield { choices: [{ index: 0, delta: {}, finish_reason: finishReason }] };
    };
  return stream;
}

describe('OpenAIBackend surfaces stopReason', () => {
  it('maps a truncated non-streaming completion to max_tokens', async () => {
    const backend = new OpenAIBackend('test-key');
    (backend as unknown as { _api: unknown })._api = {
      chat: {
        completions: {
          create: async () => ({
            choices: [{ index: 0, message: { role: 'assistant', content: 'partial' }, finish_reason: 'length' }],
            usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
          }),
        },
      },
    };
    const stopReason = await runAndCaptureStopReason(backend, ChatModels.GPT4o, { stream: false });
    expect(stopReason).toBe('max_tokens');
  });

  it('maps a clean non-streaming completion to stop', async () => {
    const backend = new OpenAIBackend('test-key');
    (backend as unknown as { _api: unknown })._api = {
      chat: {
        completions: {
          create: async () => ({
            choices: [{ index: 0, message: { role: 'assistant', content: 'done' }, finish_reason: 'stop' }],
            usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
          }),
        },
      },
    };
    const stopReason = await runAndCaptureStopReason(backend, ChatModels.GPT4o, { stream: false });
    expect(stopReason).toBe('stop');
  });

  it('maps a truncated streaming completion to max_tokens', async () => {
    const backend = new OpenAIBackend('test-key');
    (backend as unknown as { _api: unknown })._api = {
      chat: { completions: { create: async () => openAIStream('length') } },
    };
    const stopReason = await runAndCaptureStopReason(backend, ChatModels.GPT4o, { stream: true });
    expect(stopReason).toBe('max_tokens');
  });
});

describe('XAIBackend surfaces stopReason', () => {
  it('maps a truncated non-streaming completion to max_tokens', async () => {
    const backend = new XAIBackend('test-key');
    (backend as unknown as { _api: unknown })._api = {
      chat: {
        completions: {
          create: async () => ({
            choices: [{ index: 0, message: { role: 'assistant', content: 'partial' }, finish_reason: 'length' }],
            usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
          }),
        },
      },
    };
    const stopReason = await runAndCaptureStopReason(backend, ChatModels.GROK_2, { stream: false });
    expect(stopReason).toBe('max_tokens');
  });

  it('maps a truncated streaming completion to max_tokens', async () => {
    const backend = new XAIBackend('test-key');
    (backend as unknown as { _api: unknown })._api = {
      chat: { completions: { create: async () => openAIStream('length') } },
    };
    const stopReason = await runAndCaptureStopReason(backend, ChatModels.GROK_2, { stream: true });
    expect(stopReason).toBe('max_tokens');
  });
});

describe('GeminiBackend surfaces stopReason', () => {
  it('maps a truncated non-streaming completion to max_tokens', async () => {
    const backend = new GeminiBackend('test-key');
    (backend as unknown as { _api: unknown })._api = {
      models: {
        generateContent: async () => ({
          candidates: [{ content: { parts: [{ text: 'partial' }] }, finishReason: 'MAX_TOKENS' }],
          usageMetadata: { promptTokenCount: 1, candidatesTokenCount: 1 },
        }),
      },
    };
    const stopReason = await runAndCaptureStopReason(backend, ChatModels.GEMINI_1_5_PRO, { stream: false });
    expect(stopReason).toBe('max_tokens');
  });

  it('maps a clean streaming completion to stop', async () => {
    const backend = new GeminiBackend('test-key');
    (backend as unknown as { _api: unknown })._api = {
      models: {
        generateContentStream: async () => ({
          [Symbol.asyncIterator]: async function* () {
            yield { candidates: [{ content: { parts: [{ text: 'hi' }] }, finishReason: undefined }] };
            yield {
              candidates: [{ content: { parts: [] }, finishReason: 'STOP' }],
              usageMetadata: { promptTokenCount: 1, candidatesTokenCount: 1 },
            };
          },
        }),
      },
    };
    const stopReason = await runAndCaptureStopReason(backend, ChatModels.GEMINI_1_5_PRO, { stream: true });
    expect(stopReason).toBe('stop');
  });
});

describe('OllamaBackend surfaces stopReason', () => {
  it('maps a truncated non-streaming completion to max_tokens', async () => {
    const backend = new OllamaBackend('http://localhost:11434');
    (backend as unknown as { _api: unknown })._api = {
      chat: async () => ({
        message: { content: 'partial', tool_calls: [] },
        prompt_eval_count: 1,
        eval_count: 1,
        done_reason: 'length',
      }),
    };
    const stopReason = await runAndCaptureStopReason(backend, 'qwen2.5-coder:3b', { stream: false });
    expect(stopReason).toBe('max_tokens');
  });

  it('maps a clean streaming completion to stop', async () => {
    const backend = new OllamaBackend('http://localhost:11434');
    (backend as unknown as { _api: unknown })._api = {
      chat: async () => ({
        [Symbol.asyncIterator]: async function* () {
          yield { message: { content: 'hi', tool_calls: [] }, done: false, prompt_eval_count: 1, eval_count: 1 };
          yield {
            message: { content: '', tool_calls: [] },
            done: true,
            done_reason: 'stop',
            prompt_eval_count: 1,
            eval_count: 2,
          };
        },
      }),
    };
    const stopReason = await runAndCaptureStopReason(backend, 'qwen2.5-coder:3b', { stream: true });
    expect(stopReason).toBe('stop');
  });
});
