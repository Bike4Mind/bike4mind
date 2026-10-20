import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import type { AuthenticatedApiClient } from '@bike4mind/client-auth';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ChatService } from './ChatService';
import { ModelCatalog } from './ModelCatalog';
import { SessionStore } from './SessionStore';
import { TITLE_INSTRUCTION } from './sessionTitle';
import type { AccessStore } from './tools/AccessStore';

afterEach(() => {
  vi.restoreAllMocks();
});

describe('thinking preference after a catalog refresh failure', () => {
  it.each([
    { switchedEnvironment: false, thinking: false },
    { switchedEnvironment: true, thinking: true },
  ])(
    'preserves Off only for the same environment ($switchedEnvironment)',
    async ({ switchedEnvironment, thinking }) => {
      let environmentUrl = 'http://localhost:3000';
      const getModels = vi.fn().mockResolvedValue({
        models: [{ id: 'qwen3:8b', type: 'text', backend: 'ollama', supportsTools: true, can_think: true }],
      });
      const logger = { debug: vi.fn(), warn: vi.fn() };
      const models = new ModelCatalog({
        logger,
        getEnvironmentUrl: () => environmentUrl,
        getApiClient: () => ({ get: getModels }) as unknown as AuthenticatedApiClient,
      });
      const post = vi.fn().mockResolvedValue({ data: new PassThrough(), status: 200 });
      const service = new ChatService({
        store: new SessionStore(await mkdtemp(join(tmpdir(), 'b4m-thinking-catalog-')), 'qwen3:8b'),
        access: { list: async () => [] } as unknown as AccessStore,
        models,
        preferredModel: 'qwen3:8b',
        logger,
        getApiClient: () =>
          ({
            get: async () => ({ sseCompletionsUrl: '' }),
            getAxiosInstance: () => ({ post }),
          }) as unknown as AuthenticatedApiClient,
        getEnvironmentUrl: () => environmentUrl,
        emit: () => {},
      });
      const { id } = await service.createSession();
      await service.setSessionReasoningEffort(id, 'minimal');
      vi.spyOn(Date, 'now').mockReturnValue(Date.now() + 6 * 60_000);
      getModels.mockRejectedValue(new Error('temporary catalog failure'));
      if (switchedEnvironment) environmentUrl = 'https://other.example.com';

      await service.send(id, 'hello');
      const request = await vi.waitUntil(
        () =>
          post.mock.calls
            .map(call => call[1] as { messages: { content: unknown }[]; options: Record<string, unknown> })
            .find(body => body.messages[0]?.content !== TITLE_INSTRUCTION),
        { timeout: 2000, interval: 5 }
      );
      if (thinking) expect(request.options.thinking).toEqual({ enabled: true });
      else expect(request.options).not.toHaveProperty('thinking');
      expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('model list lookup failed'));
      expect(models.cached()).toBeNull();
    }
  );
});
