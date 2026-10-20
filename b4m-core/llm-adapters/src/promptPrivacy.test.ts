import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from 'vitest';
import { ChatModels, type IMessage } from '@bike4mind/common';
import { Logger } from '@bike4mind/observability';
import AnthropicBedrockBackend from './bedrockBackend/anthropic';
import TitanBedrockBackend from './bedrockBackend/titan';
import { GeminiBackend } from './geminiBackend';
import { XAIBackend } from './xaiBackend';

const SECRET = 'PRIVATE-PROMPT-AND-TOOL-RESULT';
const logLevels = ['log', 'debug', 'info', 'warn', 'error'] as const;
let logSpies: MockInstance[];

function captureLogger(logger: Logger): void {
  logSpies.push(...logLevels.map(level => vi.spyOn(logger, level).mockImplementation(() => {})));
}

function expectSecretNotLogged(): void {
  expect(JSON.stringify(logSpies.map(spy => spy.mock.calls))).not.toContain(SECRET);
}

beforeEach(() => {
  logSpies = logLevels.map(level => vi.spyOn(console, level).mockImplementation(() => {}));
  captureLogger(Logger.globalInstance);
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('provider prompt privacy', () => {
  it('keeps Anthropic Bedrock request content out of logs', () => {
    const payload = new AnthropicBedrockBackend().getPayload(
      ChatModels.CLAUDE_3_HAIKU_BEDROCK,
      [{ role: 'user', content: SECRET }],
      { maxTokens: 64 }
    );

    expect(payload.body).toContain(SECRET);
    expectSecretNotLogged();
  });

  it('keeps Titan request content out of logs', () => {
    const payload = new TitanBedrockBackend().getPayload(
      ChatModels.TITAN_TEXT_G1_EXPRESS,
      [{ role: 'user', content: SECRET }],
      { maxTokens: 64 }
    );

    expect(payload.body).toContain(SECRET);
    expectSecretNotLogged();
  });

  it('keeps Gemini request content out of logs while completing a request', async () => {
    const logger = new Logger();
    captureLogger(logger);
    const backend = new GeminiBackend('test-key', logger);
    const generateContent = vi.fn().mockResolvedValue({
      candidates: [{ content: { parts: [{ text: 'ok' }] }, finishReason: 'STOP' }],
      usageMetadata: { promptTokenCount: 1, candidatesTokenCount: 1 },
    });
    (backend as unknown as { _api: unknown })._api = { models: { generateContent } };
    const callback = vi.fn().mockResolvedValue(undefined);

    await backend.complete(
      ChatModels.GEMINI_2_5_FLASH_LITE,
      [{ role: 'user', content: SECRET }],
      { stream: false },
      callback
    );

    expect(generateContent).toHaveBeenCalledOnce();
    expect(JSON.stringify(generateContent.mock.calls[0])).toContain(SECRET);
    expect(callback).toHaveBeenCalledWith(['ok'], expect.objectContaining({ outputTokens: 1 }));
    expectSecretNotLogged();
  });

  it('keeps xAI tool results and conversation content out of logs', () => {
    const logger = new Logger();
    captureLogger(logger);
    const backend = new XAIBackend('test-key', logger);
    const messages: IMessage[] = [{ role: 'user', content: SECRET }];

    backend.pushToolMessages(messages, { id: 'tool-1', name: 'lookup', parameters: '{}' }, SECRET);

    expect(messages.at(-1)).toMatchObject({ role: 'tool', content: JSON.stringify({ result: SECRET }) });
    expectSecretNotLogged();
  });
});
