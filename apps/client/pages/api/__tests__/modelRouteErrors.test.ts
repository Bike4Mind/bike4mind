import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createMocks } from 'node-mocks-http';

const BACKEND_URL = 'http://internal-backend.example:11434';

const mockFindBySettingNames = vi.fn();
const mockListModels = vi.fn();
const mockComplete = vi.fn();

vi.mock('@bike4mind/database', () => ({
  apiKeyRepository: {},
  adminSettingsRepository: { findBySettingNames: (...a: unknown[]) => mockFindBySettingNames(...a) },
}));
vi.mock('@bike4mind/services', () => ({
  apiKeyService: { getEffectiveApiKey: vi.fn(async () => 'key') },
}));
vi.mock('@bike4mind/llm-adapters', () => ({
  OllamaBackend: class {
    listModels = (...a: unknown[]) => mockListModels(...a);
  },
  getAvailableModels: vi.fn(async () => [{ id: 'm1', can_stream: false }]),
  getLlmByModel: vi.fn(() => ({ complete: (...a: unknown[]) => mockComplete(...a) })),
}));
vi.mock('@server/middlewares/baseApi', () => ({
  baseApi: () => {
    const chain: Record<string, unknown> = {};
    chain.use = () => chain;
    chain.get = (handler: (...a: unknown[]) => unknown) => handler;
    chain.post = (handler: (...a: unknown[]) => unknown) => handler;
    return chain;
  },
}));

import ollamaModels from '../ollama/models';
import infer from '../infer';

const logger = { error: vi.fn(), info: vi.fn(), warn: vi.fn() };

describe('model routes return generic error bodies', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockFindBySettingNames.mockResolvedValue([
      { settingName: 'EnableOllama', settingValue: 'true' },
      { settingName: 'ollamaBackend', settingValue: BACKEND_URL },
    ]);
  });

  it('ollama models keeps the backend error in the log, not the response', async () => {
    mockListModels.mockRejectedValue(new Error(`connect ECONNREFUSED ${BACKEND_URL}/api/tags`));
    const { req, res } = createMocks({ method: 'GET' });
    (req as unknown as { logger: typeof logger }).logger = logger;
    await (ollamaModels as unknown as (req: unknown, res: unknown) => Promise<void>)(req, res);
    expect(res._getStatusCode()).toBe(500);
    expect(res._getData()).not.toContain(BACKEND_URL);
    expect(logger.error).toHaveBeenCalled();
  });

  it('infer keeps the backend error in the log, not the response', async () => {
    mockComplete.mockRejectedValue(new Error(`request to ${BACKEND_URL}/api/generate failed`));
    const { req, res } = createMocks({ method: 'POST', body: { model: 'm1', prompt: 'hi', stream: 'false' } });
    (req as unknown as { logger: typeof logger }).logger = logger;
    await (infer as unknown as (req: unknown, res: unknown) => Promise<void>)(req, res);
    expect(res._getStatusCode()).toBe(500);
    expect(res._getData()).not.toContain(BACKEND_URL);
    expect(logger.error).toHaveBeenCalled();
  });
});
