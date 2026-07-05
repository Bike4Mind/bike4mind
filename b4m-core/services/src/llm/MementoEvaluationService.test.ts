import { describe, it, expect, vi, beforeEach } from 'vitest';
import { MementoEvaluationService } from './MementoEvaluationService';
import { BadRequestError, InternalServerError } from '@bike4mind/utils';
import { ChatModels } from '@bike4mind/common';

vi.mock('@bike4mind/llm-adapters', async importOriginal => {
  const actual = await importOriginal<typeof import('@bike4mind/llm-adapters')>();
  return {
    ...actual,
    getAvailableModels: vi.fn(),
    getLlmByModel: vi.fn(),
  };
});

import { getAvailableModels, getLlmByModel } from '@bike4mind/llm-adapters';

const mockGetAvailableModels = vi.mocked(getAvailableModels);
const mockGetLlmByModel = vi.mocked(getLlmByModel);

function createMockLogger() {
  return {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    updateMetadata: vi.fn(),
  } as unknown as ConstructorParameters<typeof MementoEvaluationService>[0];
}

const mockApiKeyTable = { openai: 'test-key' } as Parameters<
  InstanceType<typeof MementoEvaluationService>['evaluate']
>[0]['apiKeyTable'];

describe('MementoEvaluationService', () => {
  let service: MementoEvaluationService;
  let logger: ReturnType<typeof createMockLogger>;

  beforeEach(() => {
    vi.clearAllMocks();
    logger = createMockLogger();
    service = new MementoEvaluationService(logger);
  });

  describe('error classification', () => {
    it('throws BadRequestError when model is not available', async () => {
      mockGetAvailableModels.mockResolvedValue([]);

      const result = service.evaluate({
        apiKeyTable: mockApiKeyTable,
        model: 'nonexistent-model' as ChatModels,
        prompt: 'test prompt',
      });

      // The service catches errors internally and returns null,
      // but we can verify the error type through the logger
      await expect(result).resolves.toBeNull();
      expect(logger.warn).toHaveBeenCalledWith('Failed to evaluate memento:', expect.any(BadRequestError));
    });

    it('throws InternalServerError when LLM fails to initialize', async () => {
      const mockModelInfo = { id: ChatModels.GPT4_1_MINI, backend: 'openai' };
      mockGetAvailableModels.mockResolvedValue([mockModelInfo as never]);
      mockGetLlmByModel.mockReturnValue(null as never);

      const result = service.evaluate({
        apiKeyTable: mockApiKeyTable,
        model: ChatModels.GPT4_1_MINI,
        prompt: 'test prompt',
      });

      await expect(result).resolves.toBeNull();
      expect(logger.warn).toHaveBeenCalledWith('Failed to evaluate memento:', expect.any(InternalServerError));
    });

    it('includes model name in BadRequestError message', async () => {
      mockGetAvailableModels.mockResolvedValue([]);

      await service.evaluate({
        apiKeyTable: mockApiKeyTable,
        model: 'fake-model' as ChatModels,
        prompt: 'test prompt',
      });

      const error = (logger.warn as ReturnType<typeof vi.fn>).mock.calls[0][1] as BadRequestError;
      expect(error.message).toContain('fake-model');
      expect(error.statusCode).toBe(400);
    });

    it('includes model name in InternalServerError message', async () => {
      const mockModelInfo = { id: ChatModels.GPT4_1_MINI, backend: 'openai' };
      mockGetAvailableModels.mockResolvedValue([mockModelInfo as never]);
      mockGetLlmByModel.mockReturnValue(null as never);

      await service.evaluate({
        apiKeyTable: mockApiKeyTable,
        model: ChatModels.GPT4_1_MINI,
        prompt: 'test prompt',
      });

      const error = (logger.warn as ReturnType<typeof vi.fn>).mock.calls[0][1] as InternalServerError;
      expect(error.message).toContain(ChatModels.GPT4_1_MINI);
      expect(error.statusCode).toBe(500);
    });
  });

  describe('successful evaluation', () => {
    it('returns mementos for personal content', async () => {
      const mockModelInfo = { id: ChatModels.GPT4_1_MINI, backend: 'openai' };
      mockGetAvailableModels.mockResolvedValue([mockModelInfo as never]);

      const mockLlm = {
        complete: vi.fn(
          async (
            _model: string,
            _messages: unknown[],
            _options: unknown,
            callback: (texts: string[]) => Promise<void>
          ) => {
            await callback([
              JSON.stringify({
                isPersonal: true,
                mementos: [{ importance: 7, summary: 'User is a software engineer', tags: ['profession'] }],
              }),
            ]);
          }
        ),
      };
      mockGetLlmByModel.mockReturnValue(mockLlm as never);

      const result = await service.evaluate({
        apiKeyTable: mockApiKeyTable,
        model: ChatModels.GPT4_1_MINI,
        prompt: "I'm a software engineer",
      });

      expect(result).toEqual([{ importance: 7, summary: 'User is a software engineer', tags: ['profession'] }]);
    });

    it('returns null for non-personal content', async () => {
      const mockModelInfo = { id: ChatModels.GPT4_1_MINI, backend: 'openai' };
      mockGetAvailableModels.mockResolvedValue([mockModelInfo as never]);

      const mockLlm = {
        complete: vi.fn(
          async (
            _model: string,
            _messages: unknown[],
            _options: unknown,
            callback: (texts: string[]) => Promise<void>
          ) => {
            await callback([JSON.stringify({ isPersonal: false })]);
          }
        ),
      };
      mockGetLlmByModel.mockReturnValue(mockLlm as never);

      const result = await service.evaluate({
        apiKeyTable: mockApiKeyTable,
        model: ChatModels.GPT4_1_MINI,
        prompt: 'What is React?',
      });

      expect(result).toBeNull();
    });

    it('returns null when no mementos identified', async () => {
      const mockModelInfo = { id: ChatModels.GPT4_1_MINI, backend: 'openai' };
      mockGetAvailableModels.mockResolvedValue([mockModelInfo as never]);

      const mockLlm = {
        complete: vi.fn(
          async (
            _model: string,
            _messages: unknown[],
            _options: unknown,
            callback: (texts: string[]) => Promise<void>
          ) => {
            await callback([JSON.stringify({ isPersonal: true, mementos: [] })]);
          }
        ),
      };
      mockGetLlmByModel.mockReturnValue(mockLlm as never);

      const result = await service.evaluate({
        apiKeyTable: mockApiKeyTable,
        model: ChatModels.GPT4_1_MINI,
        prompt: 'test prompt',
      });

      expect(result).toBeNull();
    });
  });
});
