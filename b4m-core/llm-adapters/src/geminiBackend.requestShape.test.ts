import { describe, it, expect } from 'vitest';
import type { GenerateContentResponse } from '@google/genai';
import { ChatModels, type ICompletionOptionTools, type IMessage } from '@bike4mind/common';
import { GeminiBackend } from './geminiBackend';

type Usage = NonNullable<GenerateContentResponse['usageMetadata']>;
type CapturedRequest = { model: string; contents: unknown; config?: Record<string, unknown> } & Record<string, unknown>;
type CallbackInfo = { inputTokens?: number; outputTokens?: number };

const textResponse = (usage?: Usage) => ({
  candidates: [{ content: { parts: [{ text: 'ok' }] } }],
  usageMetadata: usage,
});
const toolCallResponse = (usage?: Usage) => ({
  candidates: [{ content: { parts: [{ functionCall: { name: 'lookup', args: { q: 'x' } } }] } }],
  usageMetadata: usage,
});

// Serves one canned response per SDK call, repeating the last one if the backend calls more often.
function backendWithCapture(responses: unknown[]) {
  const backend = new GeminiBackend('test-key');
  const requests: CapturedRequest[] = [];
  const next = (request: CapturedRequest) => {
    requests.push(request);
    return responses[Math.min(requests.length, responses.length) - 1];
  };
  (backend as unknown as { _api: unknown })._api = {
    models: {
      generateContentStream: async (request: CapturedRequest) => {
        const response = next(request);
        return (async function* () {
          yield response;
        })();
      },
      generateContent: async (request: CapturedRequest) => next(request),
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

const messages: IMessage[] = [
  { role: 'system', content: 'You are terse.' },
  { role: 'system', content: 'Answer in French.' },
  { role: 'user', content: 'hi' },
];

// A catalog row without can_think and one with it.
const NON_THINKING_MODEL = ChatModels.GEMINI_2_5_FLASH_LITE;
const THINKING_MODEL = ChatModels.GEMINI_3_5_FLASH;

describe.each([
  { label: 'streaming', stream: true },
  { label: 'non-streaming', stream: false },
])('GeminiBackend request shape ($label)', ({ stream }) => {
  const run = async ({
    msgs = messages,
    options = {},
    model = NON_THINKING_MODEL,
    responses = [textResponse({ promptTokenCount: 1, candidatesTokenCount: 1 })],
  }: {
    msgs?: IMessage[];
    options?: Record<string, unknown>;
    model?: ChatModels;
    responses?: unknown[];
  } = {}): Promise<{ requests: CapturedRequest[]; infos: CallbackInfo[] }> => {
    const { backend, requests } = backendWithCapture(responses);
    const infos: CallbackInfo[] = [];
    await backend.complete(model, msgs, { stream, ...options }, async (_text, info) => {
      if (info) infos.push(info as CallbackInfo);
    });
    return { requests, infos };
  };

  it('sends only model, contents and config at the top level', async () => {
    const { requests } = await run();
    expect(Object.keys(requests[0]).sort()).toEqual(['config', 'contents', 'model']);
  });

  it('puts the joined system messages in config.systemInstruction', async () => {
    const { requests } = await run();
    expect(requests[0].config?.systemInstruction).toBe('You are terse.\nAnswer in French.');
  });

  it('leaves systemInstruction unset when there are no system messages', async () => {
    const { requests } = await run({ msgs: [{ role: 'user', content: 'hi' }] });
    expect(requests[0].config?.systemInstruction).toBeUndefined();
  });

  it('applies maxTokens as config.maxOutputTokens on a non-thinking model', async () => {
    const { requests } = await run({ options: { maxTokens: 1234 } });
    expect(requests[0].config?.maxOutputTokens).toBe(1234);
  });

  it('omits maxOutputTokens on a thinking model so thinking cannot starve the reply', async () => {
    const { requests } = await run({ model: THINKING_MODEL, options: { maxTokens: 600 } });
    expect(requests[0].config).not.toHaveProperty('maxOutputTokens');
  });

  it.each([{ temperature: 0.3 }, { temperature: 0 }])(
    'sends temperature $temperature as given',
    async ({ temperature }) => {
      const { requests } = await run({ options: { temperature } });
      expect(requests[0].config?.temperature).toBe(temperature);
    }
  );

  it('omits temperature when none is given', async () => {
    const { requests } = await run();
    expect(requests[0].config).not.toHaveProperty('temperature');
  });

  it('passes tools in config.tools when supplied', async () => {
    const { requests } = await run({ options: { tools: [tool], executeTools: false } });
    expect(requests[0].config?.tools).toMatchObject([{ functionDeclarations: [{ name: 'lookup' }] }]);
  });

  it.each<[Usage | undefined, number]>([
    [{ candidatesTokenCount: 5, thoughtsTokenCount: 40 }, 45],
    [{ candidatesTokenCount: 5 }, 5],
    [{ thoughtsTokenCount: 40 }, 40],
    [undefined, 0],
  ])('bills output tokens for usageMetadata %j as %i', async (usage, expectedOutputTokens) => {
    const { infos } = await run({ responses: [textResponse(usage)] });
    expect(infos[infos.length - 1]?.outputTokens).toBe(expectedOutputTokens);
  });

  it('keeps the request shape and sums thinking tokens across a tool round', async () => {
    const { requests, infos } = await run({
      model: THINKING_MODEL,
      options: { tools: [tool], executeTools: true },
      responses: [
        toolCallResponse({ promptTokenCount: 10, candidatesTokenCount: 5, thoughtsTokenCount: 20 }),
        textResponse({ promptTokenCount: 30, candidatesTokenCount: 3, thoughtsTokenCount: 10 }),
      ],
    });

    expect(requests).toHaveLength(2);
    expect(Object.keys(requests[1]).sort()).toEqual(['config', 'contents', 'model']);
    expect(requests[1].config?.systemInstruction).toBe('You are terse.\nAnswer in French.');
    expect(infos[infos.length - 1]).toMatchObject({ inputTokens: 40, outputTokens: 38 });
  });
});
