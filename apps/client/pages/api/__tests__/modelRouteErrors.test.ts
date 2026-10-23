import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createMocks } from 'node-mocks-http';

const BACKEND_URL = 'http://internal-backend.example:11434';

const mockFindBySettingNames = vi.fn();
const mockListModels = vi.fn();

vi.mock('@bike4mind/database', () => ({
  adminSettingsRepository: { findBySettingNames: (...a: unknown[]) => mockFindBySettingNames(...a) },
}));
vi.mock('@bike4mind/llm-adapters', () => ({
  OllamaBackend: class {
    listModels = (...a: unknown[]) => mockListModels(...a);
  },
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
});
