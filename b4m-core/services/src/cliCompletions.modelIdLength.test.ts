import { describe, it, expect, vi } from 'vitest';

vi.mock('@bike4mind/llm-adapters', async importOriginal => ({
  ...(await importOriginal<typeof import('@bike4mind/llm-adapters')>()),
  getAvailableModels: vi.fn(),
  getLlmByModel: vi.fn(),
}));

import { BadRequestError, MAX_MODEL_ID_LENGTH } from '@bike4mind/common';
import { getAvailableModels, getLlmByModel } from '@bike4mind/llm-adapters';
import { executeCompletion } from './cliCompletions';

describe('executeCompletion - model id length guard', () => {
  it('refuses an oversize model id without echoing it or touching any lookup', async () => {
    const model = 'x'.repeat(MAX_MODEL_ID_LENGTH + 1);

    const rejection = executeCompletion({
      userId: 'user1',
      model,
      messages: [{ role: 'user', content: 'hi' }],
      onChunk: vi.fn(),
      db: {} as never,
      logger: {} as never,
    });

    const error = await rejection.catch((e: unknown) => e);
    expect(error).toBeInstanceOf(BadRequestError);
    expect(error).toMatchObject({ additionalInfo: { errorCode: 'unknown_model' } });
    expect((error as Error).message).not.toContain(model);
    expect(getAvailableModels).not.toHaveBeenCalled();
    expect(getLlmByModel).not.toHaveBeenCalled();
  });

  it('lets a 256-character model id through to the next check', async () => {
    const rejection = executeCompletion({
      userId: 'user1',
      model: 'x'.repeat(MAX_MODEL_ID_LENGTH),
      messages: [],
      onChunk: vi.fn(),
      db: {} as never,
      logger: {} as never,
    });

    await expect(rejection).rejects.toThrow('at least one non-empty user or assistant message');
  });
});
