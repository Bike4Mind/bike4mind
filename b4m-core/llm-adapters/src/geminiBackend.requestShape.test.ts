import { describe, it, expect } from 'vitest';
import type { GenerateContentResponse } from '@google/genai';
import { ChatModels, type ICompletionOptionTools, type IMessage, type ModelInfo } from '@bike4mind/common';
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
function backendWithCapture(responses: unknown[], dispatchInfo?: ModelInfo) {
  const backend = new GeminiBackend('test-key');
  if (dispatchInfo) backend.setDispatchModel(dispatchInfo);
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
    dispatchInfo,
  }: {
    msgs?: IMessage[];
    options?: Record<string, unknown>;
    model?: ChatModels;
    responses?: unknown[];
    dispatchInfo?: ModelInfo;
  } = {}): Promise<{ requests: CapturedRequest[]; infos: CallbackInfo[] }> => {
    const { backend, requests } = backendWithCapture(responses, dispatchInfo);
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

  describe('thinking models', () => {
    const LOW = { thinkingLevel: 'LOW' };
    it.each<{ model: ChatModels; maxTokens?: number; maxOutputTokens: number; thinkingConfig?: object }>([
      { model: THINKING_MODEL, maxTokens: 50, maxOutputTokens: 16050, thinkingConfig: LOW },
      { model: THINKING_MODEL, maxTokens: undefined, maxOutputTokens: 24192, thinkingConfig: LOW },
      { model: THINKING_MODEL, maxTokens: 49535, maxOutputTokens: 65535, thinkingConfig: LOW },
      { model: THINKING_MODEL, maxTokens: 49536, maxOutputTokens: 65536 },
      { model: THINKING_MODEL, maxTokens: 65536, maxOutputTokens: 65536 },
    ])(
      '$model with cap $maxTokens sends maxOutputTokens $maxOutputTokens and thinkingConfig $thinkingConfig',
      async ({ model, maxTokens, maxOutputTokens, thinkingConfig }) => {
        const { requests } = await run({ model, options: { maxTokens, temperature: 0.9 } });
        const config = requests[0].config;
        expect(config?.maxOutputTokens).toBe(maxOutputTokens);
        if (thinkingConfig) expect(config?.thinkingConfig).toEqual(thinkingConfig);
        else expect(config).not.toHaveProperty('thinkingConfig');
        expect(config).not.toHaveProperty('temperature');
      }
    );
  });

  it.each([{ temperature: 0.3 }, { temperature: 0 }])(
    'sends temperature $temperature as given on a non-thinking model',
    async ({ temperature }) => {
      const { requests } = await run({ model: NON_THINKING_MODEL, options: { temperature } });
      expect(requests[0].config?.temperature).toBe(temperature);
    }
  );

  it('omits temperature on a thinking model even when the caller sets one', async () => {
    const { requests } = await run({ model: THINKING_MODEL, options: { temperature: 0.9 } });
    expect(requests[0].config).not.toHaveProperty('temperature');
  });

  it('sends no thinkingConfig on a non-thinking model', async () => {
    const { requests } = await run();
    expect(requests[0].config).not.toHaveProperty('thinkingConfig');
  });

  it('omits temperature when none is given', async () => {
    const { requests } = await run();
    expect(requests[0].config).not.toHaveProperty('temperature');
  });

  // A model absent from the built-in catalog reaches the backend through setDispatchModel, and
  // can_think is the only thing that decides whether it gets an output cap.
  describe('a model resolved from a dispatch record', () => {
    const DISCOVERED_MODEL = 'gemini-discovered-test' as ChatModels;
    const discoveredRecord = async (canThink: boolean | undefined): Promise<ModelInfo> => {
      const catalog = await new GeminiBackend('test-key').getModelInfo();
      const base = catalog.find(model => model.id === NON_THINKING_MODEL);
      if (!base) throw new Error('catalog row missing');
      return { ...base, id: DISCOVERED_MODEL, can_think: canThink };
    };

    it('caps output with the thinking reserve and omits temperature when the record says it thinks', async () => {
      const { requests } = await run({
        model: DISCOVERED_MODEL,
        dispatchInfo: await discoveredRecord(true),
        options: { maxTokens: 600, temperature: 0.5 },
      });
      expect(requests[0].config?.maxOutputTokens).toBe(16600);
      expect(requests[0].config).not.toHaveProperty('temperature');
    });

    it.each<{ name: string; overrides: Partial<ModelInfo>; thinkingConfig?: object }>([
      { name: '2.5 id', overrides: { id: 'gemini-2.5-x' as ChatModels } },
      { name: '3.x id', overrides: { id: 'gemini-3-x' as ChatModels }, thinkingConfig: { thinkingLevel: 'LOW' } },
      { name: 'unrecognised id', overrides: { id: 'gemini-flash-latest' as ChatModels } },
      {
        name: 'missing max_tokens (no ceiling, so thinking is bounded)',
        overrides: { id: 'gemini-3-x' as ChatModels, max_tokens: undefined as unknown as number },
        thinkingConfig: { thinkingLevel: 'LOW' },
      },
      {
        name: 'derived max_tokens stand-in (not a ceiling)',
        overrides: { id: 'gemini-3-x' as ChatModels, max_tokens: 4096, maxOutputTokensDerived: true },
        thinkingConfig: { thinkingLevel: 'LOW' },
      },
    ])('caps a thinking record with $name at cap + reserve', async ({ overrides, thinkingConfig }) => {
      const record = { ...(await discoveredRecord(true)), ...overrides };
      const { requests } = await run({
        model: record.id as ChatModels,
        dispatchInfo: record,
        options: { maxTokens: 600 },
      });
      expect(requests[0].config?.maxOutputTokens).toBe(16600);
      if (thinkingConfig) expect(requests[0].config?.thinkingConfig).toEqual(thinkingConfig);
      else expect(requests[0].config).not.toHaveProperty('thinkingConfig');
    });

    it('caps output when the record omits can_think', async () => {
      const { requests } = await run({ model: DISCOVERED_MODEL, dispatchInfo: await discoveredRecord(undefined) });
      expect(requests[0].config?.maxOutputTokens).toBe(8192);
    });
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
