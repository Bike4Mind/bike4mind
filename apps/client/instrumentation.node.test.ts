// @vitest-environment node
import { afterEach, describe, expect, it, vi } from 'vitest';

const { registerProcessErrorHandlers, getAvailableModels, logExpiringModels } = vi.hoisted(() => ({
  registerProcessErrorHandlers: vi.fn(),
  getAvailableModels: vi.fn(),
  logExpiringModels: vi.fn(),
}));
vi.mock('@bike4mind/utils', () => ({ registerProcessErrorHandlers }));
vi.mock('@bike4mind/llm-adapters', () => ({ getAvailableModels, logExpiringModels }));

import { register } from './instrumentation.node';

describe('instrumentation.node register', () => {
  afterEach(() => {
    vi.resetAllMocks();
  });

  it('registers the process error handlers and logs expiring models', async () => {
    const models = [{ id: 'model-a' }];
    getAvailableModels.mockResolvedValue(models);

    register();

    expect(registerProcessErrorHandlers).toHaveBeenCalledWith(undefined, 'NextServer');
    await vi.waitFor(() => expect(logExpiringModels).toHaveBeenCalledWith(models));
  });

  it('swallows a getAvailableModels rejection', async () => {
    const rejection = Promise.reject(new Error('catalog unavailable'));
    getAvailableModels.mockReturnValue(rejection);

    expect(() => register()).not.toThrow();
    await new Promise(resolve => setImmediate(resolve));

    expect(registerProcessErrorHandlers).toHaveBeenCalledOnce();
    expect(logExpiringModels).not.toHaveBeenCalled();
  });
});
