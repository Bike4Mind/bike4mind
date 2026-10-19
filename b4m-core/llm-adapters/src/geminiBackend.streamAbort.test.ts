import { describe, it, expect } from 'vitest';
import type { GenerateContentResponse } from '@google/genai';
import { ChatModels, estimateStreamedOutputTokens, type ICompletionOptionTools } from '@bike4mind/common';
import { GeminiBackend } from './geminiBackend';
import type { CompletionInfo } from './backend';

type Usage = NonNullable<GenerateContentResponse['usageMetadata']>;
type CapturedRequest = { config?: { abortSignal?: AbortSignal } & Record<string, unknown> } & Record<string, unknown>;
// A chunk the stream yields, or a step that runs between chunks (abort the signal, or throw like the SDK).
type Step = unknown | (() => void);

const MODEL = ChatModels.GEMINI_2_5_FLASH_LITE;

const textChunk = (text: string, usage?: Usage) => ({
  candidates: [{ content: { parts: [{ text }] } }],
  usageMetadata: usage,
});
const toolCallChunk = (usage?: Usage) => ({
  candidates: [{ content: { parts: [{ functionCall: { name: 'lookup', args: { q: 'x' } } }] } }],
  usageMetadata: usage,
});

function buildBackend(streams: Step[][]) {
  const backend = new GeminiBackend('test-key');
  const requests: CapturedRequest[] = [];
  (backend as unknown as { _api: unknown })._api = {
    models: {
      generateContentStream: async (request: CapturedRequest) => {
        requests.push(request);
        // The SDK rejects up front on an already-aborted signal.
        if (request.config?.abortSignal?.aborted) throw new Error('The operation was aborted');
        const steps = streams[requests.length - 1] ?? [];
        return (async function* () {
          for (const step of steps) {
            if (typeof step === 'function') step();
            else yield step;
          }
        })();
      },
    },
  };
  return { backend, requests };
}

const tool: ICompletionOptionTools = {
  toolSchema: {
    name: 'lookup',
    description: 'Look something up',
    parameters: { type: 'object', properties: { q: { type: 'string' } }, required: ['q'] },
  },
  toolFn: async () => 'result',
};

async function run(
  streams: Step[][],
  controller: AbortController,
  options: { tools?: ICompletionOptionTools[] } = {}
): Promise<{ infos: CompletionInfo[]; error: unknown; requests: CapturedRequest[] }> {
  const { backend, requests } = buildBackend(streams);
  const infos: CompletionInfo[] = [];
  let error: unknown;
  try {
    await backend.complete(
      MODEL,
      [{ role: 'user', content: 'hi' }],
      { stream: true, abortSignal: controller.signal, ...options },
      async (_text, info) => {
        if (info) infos.push(info);
      }
    );
  } catch (e) {
    error = e;
  }
  return { infos, error, requests };
}

describe('GeminiBackend - aborted stream', () => {
  it('passes the abort signal on the stream request config', async () => {
    const controller = new AbortController();
    const { requests } = await run([[textChunk('ok', { promptTokenCount: 1, candidatesTokenCount: 1 })]], controller);

    expect(requests[0].config?.abortSignal).toBe(controller.signal);
  });

  it('emits the usage seen so far with stopReason aborted, then throws Request aborted', async () => {
    const controller = new AbortController();
    const usage = { promptTokenCount: 100, candidatesTokenCount: 7, thoughtsTokenCount: 3 };
    const { infos, error } = await run(
      [[textChunk('partial', usage), () => controller.abort(), textChunk('never seen')]],
      controller
    );

    expect((error as Error).message).toBe('Request aborted');
    const aborted = infos.filter(info => info.stopReason === 'aborted');
    expect(aborted).toHaveLength(1);
    expect(infos.at(-1)).toBe(aborted[0]);
    expect(aborted[0].inputTokens).toBe(100);
    expect(aborted[0].outputTokens).toBe(10);
    expect(aborted[0].reasoningTokens).toBe(3);
    expect(aborted[0].turnUsage).toEqual([{ inputTokens: 100, outputTokens: 10 }]);
  });

  it('keeps the last usageMetadata seen when a later chunk carries none', async () => {
    const controller = new AbortController();
    const { infos } = await run(
      [
        [
          textChunk('a', { promptTokenCount: 40, candidatesTokenCount: 2 }),
          textChunk('b'),
          () => controller.abort(),
          textChunk('never seen'),
        ],
      ],
      controller
    );

    expect(infos.at(-1)).toMatchObject({ inputTokens: 40, outputTokens: 2, stopReason: 'aborted' });
  });

  it('emits when the SDK throws its own abort error mid-stream', async () => {
    const controller = new AbortController();
    const { infos, error } = await run(
      [
        [
          textChunk('partial', { promptTokenCount: 30, candidatesTokenCount: 4 }),
          () => {
            controller.abort();
            throw new Error('The operation was aborted');
          },
        ],
      ],
      controller
    );

    expect((error as Error).message).toBe('Request aborted');
    expect(infos.at(-1)).toMatchObject({ inputTokens: 30, outputTokens: 4, stopReason: 'aborted' });
  });

  it('emits nothing when the abort lands before any chunk', async () => {
    const controller = new AbortController();
    const { infos, error } = await run([[() => controller.abort(), textChunk('never seen')]], controller);

    expect((error as Error).message).toBe('Request aborted');
    expect(infos).toEqual([]);
  });

  it('still throws Request aborted when the final callback itself throws', async () => {
    const controller = new AbortController();
    const { backend } = buildBackend([
      [
        textChunk('partial', { promptTokenCount: 5, candidatesTokenCount: 1 }),
        () => controller.abort(),
        textChunk('x'),
      ],
    ]);

    await expect(
      backend.complete(
        MODEL,
        [{ role: 'user', content: 'hi' }],
        { stream: true, abortSignal: controller.signal },
        async (_text, info) => {
          if (info?.stopReason === 'aborted') throw new Error('socket closed');
        }
      )
    ).rejects.toThrow('Request aborted');
  });

  it('estimates the output of a later tool-loop call from what it streamed when no usage arrived', async () => {
    const controller = new AbortController();
    const streamed = 'x'.repeat(400);
    const { infos, error } = await run(
      [
        [toolCallChunk({ promptTokenCount: 50, candidatesTokenCount: 5 })],
        [textChunk(streamed), () => controller.abort(), textChunk('never seen')],
      ],
      controller,
      { tools: [tool] }
    );

    const estimated = estimateStreamedOutputTokens(streamed.length, MODEL);
    expect(estimated).toBeGreaterThan(0);
    expect((error as Error).message).toBe('Request aborted');
    expect(infos.at(-1)).toMatchObject({ inputTokens: 50, outputTokens: 5 + estimated, stopReason: 'aborted' });
    expect(infos.at(-1)?.turnUsage).toEqual([
      { inputTokens: 50, outputTokens: 5 },
      { inputTokens: 0, outputTokens: estimated },
    ]);
  });

  it('counts streamed function-call args toward the estimate on a later call', async () => {
    const controller = new AbortController();
    const { infos } = await run(
      [
        [toolCallChunk({ promptTokenCount: 50, candidatesTokenCount: 5 })],
        [
          {
            candidates: [{ content: { parts: [{ functionCall: { name: 'lookup', args: { q: 'y'.repeat(300) } } }] } }],
          },
          () => controller.abort(),
          textChunk('never seen'),
        ],
      ],
      controller,
      { tools: [tool] }
    );

    const argChars = JSON.stringify({ q: 'y'.repeat(300) }).length;
    expect(infos.at(-1)).toMatchObject({
      outputTokens: 5 + estimateStreamedOutputTokens(argChars, MODEL),
      stopReason: 'aborted',
    });
  });

  it('emits no usage on a first call that streamed text but saw no usageMetadata', async () => {
    const controller = new AbortController();
    const { infos, error } = await run(
      [[textChunk('x'.repeat(400)), () => controller.abort(), textChunk('x')]],
      controller
    );

    expect((error as Error).message).toBe('Request aborted');
    expect(infos.filter(info => info.stopReason === 'aborted')).toEqual([]);
  });

  it('adds this call usage once to the accumulated totals on a later call', async () => {
    const controller = new AbortController();
    const { infos, error } = await run(
      [
        [toolCallChunk({ promptTokenCount: 50, candidatesTokenCount: 5 })],
        [
          textChunk('x'.repeat(400), { promptTokenCount: 80, candidatesTokenCount: 7 }),
          () => controller.abort(),
          textChunk('never seen'),
        ],
      ],
      controller,
      { tools: [tool] }
    );

    expect((error as Error).message).toBe('Request aborted');
    const aborted = infos.filter(info => info.stopReason === 'aborted');
    expect(aborted).toHaveLength(1);
    expect(aborted[0]).toMatchObject({ inputTokens: 130, outputTokens: 12 });
    expect(aborted[0].turnUsage).toEqual([
      { inputTokens: 50, outputTokens: 5 },
      { inputTokens: 80, outputTokens: 7 },
    ]);
  });

  it('splits cached tokens out of the input on the aborted usage', async () => {
    const controller = new AbortController();
    const { infos } = await run(
      [
        [
          textChunk('partial', { promptTokenCount: 100, cachedContentTokenCount: 60, candidatesTokenCount: 7 }),
          () => controller.abort(),
          textChunk('never seen'),
        ],
      ],
      controller
    );

    expect(infos.at(-1)).toMatchObject({
      inputTokens: 40,
      cacheReadInputTokens: 60,
      outputTokens: 7,
      stopReason: 'aborted',
    });
    expect(infos.at(-1)?.turnUsage).toEqual([{ inputTokens: 40, cacheReadInputTokens: 60, outputTokens: 7 }]);
  });

  it('emits no aborted usage when the iterator throws an aborted-looking error and the signal is not aborted', async () => {
    const controller = new AbortController();
    const { infos, error } = await run(
      [
        [
          textChunk('partial', { promptTokenCount: 30, candidatesTokenCount: 4 }),
          () => {
            throw new Error('upstream connection aborted');
          },
        ],
      ],
      controller
    );

    expect((error as Error).message).toBe('Request aborted');
    expect(infos.filter(info => info.stopReason === 'aborted')).toEqual([]);
  });

  it('does not re-emit aborted when the abort lands during tool execution after the stream finished', async () => {
    const controller = new AbortController();
    const abortingTool: ICompletionOptionTools = {
      ...tool,
      toolFn: async () => {
        controller.abort();
        return 'result';
      },
    };
    const { infos, error } = await run(
      [[toolCallChunk({ promptTokenCount: 50, candidatesTokenCount: 5 })]],
      controller,
      { tools: [abortingTool] }
    );

    expect((error as Error).message).toBe('Request aborted');
    expect(infos.filter(info => info.stopReason === 'aborted')).toEqual([]);
    expect(infos.filter(info => info.inputTokens === 50)).toHaveLength(1);
  });

  it('counts usage carried by a chunk that arrives after the abort', async () => {
    const controller = new AbortController();
    const { infos, error } = await run(
      [[() => controller.abort(), textChunk('last', { promptTokenCount: 120, candidatesTokenCount: 9 })]],
      controller
    );

    expect((error as Error).message).toBe('Request aborted');
    expect(infos.at(-1)).toMatchObject({ inputTokens: 120, outputTokens: 9, stopReason: 'aborted' });
  });
});
