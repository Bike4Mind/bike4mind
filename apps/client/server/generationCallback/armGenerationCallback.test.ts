import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Logger } from '@bike4mind/observability';
import { ApiKeyStatus } from '@bike4mind/common';
import { BadRequestError } from '@server/utils/errors';
import { SsrfError } from '@server/utils/ssrfProtection';

const h = vi.hoisted(() => ({
  armCallback: vi.fn(),
  findCallbackSigningSecret: vi.fn(),
  assertUrlAllowed: vi.fn(),
  dispatchQuestCallback: vi.fn(),
  getGenerationCallbackQueueUrl: vi.fn(),
}));

vi.mock('@bike4mind/database', () => ({
  questRepository: { armCallback: h.armCallback },
  userApiKeyRepository: { findCallbackSigningSecret: h.findCallbackSigningSecret },
}));

vi.mock('@server/utils/ssrfProtection', async orig => {
  const actual = await orig<typeof import('@server/utils/ssrfProtection')>();
  return { ...actual, assertUrlAllowed: h.assertUrlAllowed };
});

vi.mock('./dispatchQuestCallback', () => ({
  dispatchQuestCallback: h.dispatchQuestCallback,
  getGenerationCallbackQueueUrl: h.getGenerationCallbackQueueUrl,
}));

import { resolveGenerationCallback, armGenerationCallback } from './armGenerationCallback';

function makeLogger(): Logger {
  return { info: vi.fn(), warn: vi.fn(), error: vi.fn() } as unknown as Logger;
}

describe('resolveGenerationCallback', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    h.assertUrlAllowed.mockResolvedValue(undefined);
    h.getGenerationCallbackQueueUrl.mockReturnValue('https://sqs.example.com/generationCallbackQueue');
  });

  it('rejects with 400 when the deployment has no callback delivery queue', async () => {
    h.getGenerationCallbackQueueUrl.mockReturnValue(undefined);

    await expect(
      resolveGenerationCallback({ apiKeyInfo: { keyId: 'key-1' } } as never, 'https://receiver.example.com/hook')
    ).rejects.toThrow('callbackUrl is not supported on this deployment');
    expect(h.findCallbackSigningSecret).not.toHaveBeenCalled();
  });

  it('returns undefined and makes no lookups when there is no callbackUrl', async () => {
    const result = await resolveGenerationCallback({ apiKeyInfo: { keyId: 'key-1' } }, undefined);

    expect(result).toBeUndefined();
    expect(h.assertUrlAllowed).not.toHaveBeenCalled();
    expect(h.findCallbackSigningSecret).not.toHaveBeenCalled();
  });

  it('rejects a JWT/browser caller (no apiKeyInfo) with BadRequestError', async () => {
    const promise = resolveGenerationCallback({ apiKeyInfo: undefined }, 'https://example.com/hook');

    await expect(promise).rejects.toThrow(BadRequestError);
    await expect(promise).rejects.toThrow(/API key authentication/);
    expect(h.assertUrlAllowed).not.toHaveBeenCalled();
  });

  it('wraps an SsrfError from assertUrlAllowed in a BadRequestError', async () => {
    h.assertUrlAllowed.mockRejectedValue(new SsrfError('target resolves to a private address'));

    const promise = resolveGenerationCallback({ apiKeyInfo: { keyId: 'key-1' } }, 'https://internal.example.com/hook');

    await expect(promise).rejects.toThrow(BadRequestError);
    await expect(promise).rejects.toThrow(/callbackUrl is not allowed/);
    expect(h.findCallbackSigningSecret).not.toHaveBeenCalled();
  });

  it('propagates a non-SsrfError from assertUrlAllowed unwrapped', async () => {
    const boom = new Error('DNS resolver exploded');
    h.assertUrlAllowed.mockRejectedValue(boom);

    await expect(
      resolveGenerationCallback({ apiKeyInfo: { keyId: 'key-1' } }, 'https://example.com/hook')
    ).rejects.toBe(boom);
  });

  it('rejects with a BadRequestError naming the callback-secret endpoint when the key has no signing secret', async () => {
    h.findCallbackSigningSecret.mockResolvedValue(null);

    const promise = resolveGenerationCallback({ apiKeyInfo: { keyId: 'key-42' } }, 'https://example.com/hook');

    await expect(promise).rejects.toThrow(BadRequestError);
    await expect(promise).rejects.toThrow('/api/user-api-keys/key-42/callback-secret');
  });

  it('returns {url, apiKeyId} when the key has a signing secret and the target is allowed', async () => {
    h.findCallbackSigningSecret.mockResolvedValue({
      secret: 'whsec_abc',
      userId: 'user-1',
      status: ApiKeyStatus.ACTIVE,
    });

    const result = await resolveGenerationCallback({ apiKeyInfo: { keyId: 'key-42' } }, 'https://example.com/hook');

    expect(result).toEqual({ url: 'https://example.com/hook', apiKeyId: 'key-42' });
    expect(h.assertUrlAllowed).toHaveBeenCalledWith('https://example.com/hook');
    expect(h.findCallbackSigningSecret).toHaveBeenCalledWith('key-42');
  });
});

describe('armGenerationCallback', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('does nothing when the target is undefined', async () => {
    const logger = makeLogger();

    await armGenerationCallback('quest-1', undefined, logger);

    expect(h.armCallback).not.toHaveBeenCalled();
    expect(h.dispatchQuestCallback).not.toHaveBeenCalled();
  });

  it('arms the callback then dispatches it, in that order', async () => {
    const callOrder: string[] = [];
    h.armCallback.mockImplementation(async () => {
      callOrder.push('armCallback');
    });
    h.dispatchQuestCallback.mockImplementation(async () => {
      callOrder.push('dispatchQuestCallback');
    });
    const logger = makeLogger();
    const target = { url: 'https://example.com/hook', apiKeyId: 'key-42' };

    await armGenerationCallback('quest-1', target, logger);

    expect(h.armCallback).toHaveBeenCalledWith('quest-1', target);
    expect(h.dispatchQuestCallback).toHaveBeenCalledWith('quest-1', logger);
    expect(callOrder).toEqual(['armCallback', 'dispatchQuestCallback']);
  });

  it('logs and resolves without dispatching when armCallback throws, so the queued render is not failed', async () => {
    const boom = new Error('mongo down');
    h.armCallback.mockRejectedValue(boom);
    const logger = makeLogger();

    await expect(
      armGenerationCallback('quest-1', { url: 'https://example.com/hook', apiKeyId: 'key-42' }, logger)
    ).resolves.toBeUndefined();

    expect(logger.error).toHaveBeenCalledWith(expect.any(String), { questId: 'quest-1', error: boom });
    expect(h.dispatchQuestCallback).not.toHaveBeenCalled();
  });
});
