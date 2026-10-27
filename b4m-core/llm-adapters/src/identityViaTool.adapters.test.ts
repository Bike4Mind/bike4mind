import { describe, expect, it, vi } from 'vitest';
import { ChatModels, type IMessage } from '@bike4mind/common';
import type { ChatRequest } from 'ollama';
import type { ICompletionOptions, ICompletionOptionTools } from './backend';
import { XAIBackend } from './xaiBackend';
import { KimiBackend } from './kimiBackend';
import { DeepSeekBackend } from './deepseekBackend';
import { GeminiBackend } from './geminiBackend';
import { OllamaBackend } from './ollamaBackend';
import { ConverseBedrockBackend } from './bedrockBackend/converse';
import MoonshotBedrockBackend from './bedrockBackend/moonshot';
import { buildIdentityReminder } from './identityReminder';

type SentRequest = { systemText: string; tools: readonly unknown[] | undefined };
type Run = (options: Partial<ICompletionOptions>) => Promise<SentRequest>;
type MessageRequest = { messages: Array<{ role: string; content: unknown }>; tools?: unknown[] };

const messages: IMessage[] = [
  { role: 'system', content: 'You are terse.' },
  { role: 'user', content: 'Which model are you?' },
];
const identityTool: ICompletionOptionTools = {
  toolFn: async () => 'model details',
  toolSchema: {
    name: 'current_model_details',
    description: 'Return the current model identity',
    parameters: { type: 'object', properties: {} },
  },
};

function fromMessages(request: MessageRequest): SentRequest {
  return {
    systemText: request.messages
      .filter(message => message.role === 'system')
      .map(message => String(message.content))
      .join('\n'),
    tools: request.tools,
  };
}

function openAIRun(backend: XAIBackend | KimiBackend | DeepSeekBackend, model: string): Run {
  return async options => {
    const create = vi.fn(async (_request: MessageRequest) => ({
      choices: [{ index: 0, message: { content: 'ok' }, finish_reason: 'stop' }],
      usage: { prompt_tokens: 1, completion_tokens: 1 },
    }));
    (backend as unknown as { _api: unknown })._api = { chat: { completions: { create } } };
    await backend.complete(model, messages, { stream: false, ...options }, async () => {});
    expect(create).toHaveBeenCalledTimes(1);
    return fromMessages(create.mock.calls[0][0]);
  };
}

const geminiRun: Run = async options => {
  const backend = new GeminiBackend('test-key');
  type Request = { config?: { systemInstruction?: string; tools?: unknown[] } };
  const generateContent = vi.fn(async (_request: Request) => ({
    candidates: [{ content: { parts: [{ text: 'ok' }] } }],
  }));
  (backend as unknown as { _api: unknown })._api = { models: { generateContent } };
  await backend.complete(ChatModels.GEMINI_2_5_FLASH_LITE, messages, { stream: false, ...options }, async () => {});
  expect(generateContent).toHaveBeenCalledTimes(1);
  const request = generateContent.mock.calls[0][0];
  return { systemText: request.config?.systemInstruction ?? '', tools: request.config?.tools };
};

const ollamaRun: Run = async options => {
  const backend = new OllamaBackend('http://localhost:11434');
  const chat = vi.fn(async (_request: ChatRequest) => ({
    message: { content: 'ok', tool_calls: [] },
    prompt_eval_count: 1,
    eval_count: 1,
  }));
  (backend as unknown as { _api: unknown })._api = { chat };
  await backend.complete('qwen2.5-coder:3b', messages, { stream: false, ...options }, async () => {});
  expect(chat).toHaveBeenCalledTimes(1);
  return fromMessages(chat.mock.calls[0][0]);
};

const converseRun =
  (supportsTools: boolean): Run =>
  async options => {
    const backend = new ConverseBedrockBackend();
    backend.setDispatchModel({
      id: ChatModels.NOVA_PRO_BEDROCK,
      name: 'Amazon Nova Pro',
      type: 'text',
      supportsTools,
    });
    const body = JSON.parse(backend.getPayload(ChatModels.NOVA_PRO_BEDROCK, messages, options).body) as {
      system?: Array<{ text: string }>;
      toolConfig?: { tools: unknown[] };
    };
    return { systemText: body.system?.map(block => block.text).join('\n') ?? '', tools: body.toolConfig?.tools };
  };

const moonshotRun: Run = async options => {
  const backend = new MoonshotBedrockBackend();
  return fromMessages(JSON.parse(backend.getPayload(ChatModels.KIMI_K2_5_BEDROCK, messages, options).body));
};

const adapters: Array<{ name: string; model: string; run: Run; capsTools: boolean }> = [
  {
    name: 'xAI',
    model: ChatModels.GROK_4_5,
    run: openAIRun(new XAIBackend('test-key'), ChatModels.GROK_4_5),
    capsTools: true,
  },
  {
    name: 'Kimi',
    model: ChatModels.KIMI_K2_6,
    run: openAIRun(new KimiBackend('test-key'), ChatModels.KIMI_K2_6),
    capsTools: true,
  },
  {
    name: 'DeepSeek',
    model: ChatModels.DEEPSEEK_FLASH,
    run: openAIRun(new DeepSeekBackend('test-key'), ChatModels.DEEPSEEK_FLASH),
    capsTools: true,
  },
  { name: 'Gemini', model: ChatModels.GEMINI_2_5_FLASH_LITE, run: geminiRun, capsTools: true },
  { name: 'Ollama', model: 'qwen2.5-coder:3b', run: ollamaRun, capsTools: true },
  { name: 'Converse', model: ChatModels.NOVA_PRO_BEDROCK, run: converseRun(true), capsTools: false },
  { name: 'Moonshot Bedrock', model: ChatModels.KIMI_K2_5_BEDROCK, run: moonshotRun, capsTools: false },
];

describe.each(adapters)('$name identity via tool', ({ model, run, capsTools }) => {
  it('omits the reminder while the identity tool is actually offered', async () => {
    const request = await run({ identityViaTool: true, tools: [identityTool] });
    expect(request.tools?.length).toBeGreaterThan(0);
    expect(request.systemText).toBe('You are terse.');
  });

  it.each([undefined, []])('keeps the reminder when tools are %j', async tools => {
    const request = await run({ identityViaTool: true, tools });
    expect(request.tools?.length ?? 0).toBe(0);
    expect(request.systemText).toBe(`You are terse.\n\n${buildIdentityReminder(model)}`);
  });

  it('keeps the reminder when tools are present without identityViaTool', async () => {
    const request = await run({ tools: [identityTool] });
    expect(request.tools?.length).toBeGreaterThan(0);
    expect(request.systemText).toBe(`You are terse.\n\n${buildIdentityReminder(model)}`);
  });

  it('honors the explicit opt-out even when the identity tool is absent', async () => {
    const request = await run({ identityViaTool: true, omitIdentityReminder: true });
    expect(request.systemText).toBe('You are terse.');
  });

  if (capsTools) {
    it('restores one named reminder when the tool-call cap withholds tools', async () => {
      const request = await run({
        identityViaTool: true,
        tools: [identityTool],
        modelDisplayName: 'Selected model',
        _internal: { toolCallCount: 1, maxToolCalls: 1 },
      });
      expect(request.tools?.length ?? 0).toBe(0);
      expect(request.systemText).toBe(`You are terse.\n\n${buildIdentityReminder(model, 'Selected model')}`);
    });
  }
});

describe('Converse identity via tool on models without tool support', () => {
  it('keeps the reminder when the model record withholds the requested tools', async () => {
    const request = await converseRun(false)({ identityViaTool: true, tools: [identityTool] });
    expect(request.tools).toBeUndefined();
    expect(request.systemText).toBe(`You are terse.\n\n${buildIdentityReminder(ChatModels.NOVA_PRO_BEDROCK)}`);
  });
});
