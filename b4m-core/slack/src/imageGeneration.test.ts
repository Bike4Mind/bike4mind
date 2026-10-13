import { describe, it, expect, vi, beforeEach } from 'vitest';

const { getSlackDeps, getSlackDb, invoke, findById, findByIdAndUpdate } = vi.hoisted(() => ({
  getSlackDeps: vi.fn(),
  getSlackDb: vi.fn(),
  invoke: vi.fn(),
  findById: vi.fn(),
  findByIdAndUpdate: vi.fn(),
}));
vi.mock('./di', () => ({ getSlackDeps, getSlackDb }));
vi.mock('@bike4mind/services/llm/ChatCompletionInvoke', () => ({
  ChatCompletionInvoke: function MockChatCompletionInvoke() {
    return { invoke };
  },
}));
vi.mock('@bike4mind/utils', () => ({
  SQSService: function MockSQSService() {
    return {};
  },
}));
vi.mock('@bike4mind/observability', () => ({
  Logger: class MockLogger {
    static error = vi.fn();
    static info = vi.fn();
  },
}));

import { ImageModels } from '@bike4mind/common';
import { triggerImageGeneration } from './imageGeneration';

beforeEach(() => {
  vi.clearAllMocks();
  findById.mockResolvedValue({ id: 'user-1' });
  invoke.mockResolvedValue({ id: 'quest-1' });
  getSlackDb.mockReturnValue({ User: { findById }, Quest: { findByIdAndUpdate } });
  getSlackDeps.mockReturnValue({
    chatCompletionDefaults: { defaultChatCompletionOptions: {}, getSharedTokenizer: vi.fn() },
    eventBus: { LLMEvents: { CompletionStart: { publish: vi.fn() } } },
  });
});

describe('triggerImageGeneration', () => {
  it('invokes as an internal turn with no API key', async () => {
    await triggerImageGeneration({
      notebookId: 'nb-1',
      userId: 'user-1',
      prompt: 'a cat',
      model: Object.values(ImageModels)[0] as ImageModels,
      questId: 'quest-0',
      slackNotification: { workspaceId: 'W1', channelId: 'C1' },
    });

    expect(invoke).toHaveBeenCalledTimes(1);
    const arg = invoke.mock.calls[0][0];
    expect(arg).toEqual(expect.objectContaining({ authOrigin: 'internal' }));
    expect(arg).not.toHaveProperty('apiKeyId');
  });
});
