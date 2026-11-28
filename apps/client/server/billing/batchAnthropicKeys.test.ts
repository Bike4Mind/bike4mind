import { beforeEach, describe, expect, it, vi } from 'vitest';

const m = vi.hoisted(() => ({
  resolve: vi.fn(),
  config: { ANTHROPIC_API_KEY: 'sk-deployment' as string | undefined },
}));

vi.mock('@bike4mind/database', () => ({ adminSettingsRepository: {}, apiKeyRepository: {} }));
vi.mock('@bike4mind/utils', () => ({ getSettingsByNames: vi.fn() }));
vi.mock('@bike4mind/services', () => ({ apiKeyService: { getEffectiveLLMApiKeys: m.resolve } }));
vi.mock('@bike4mind/server-utils/utils/config', () => ({ Config: m.config }));

const { batchSubmitKey, batchPollKeys, firstKeyHolding } = await import('./batchAnthropicKeys');

const notFound = Object.assign(new Error('not found'), { status: 404 });

beforeEach(() => {
  vi.clearAllMocks();
  m.config.ANTHROPIC_API_KEY = 'sk-deployment';
  m.resolve.mockResolvedValue({ anthropic: 'sk-platform' });
});

describe('batchSubmitKey', () => {
  it('submits under the platform key, never the deployment secret', async () => {
    expect(await batchSubmitKey()).toBe('sk-platform');
  });

  it('has no key when none is stored, even though the deployment secret is set', async () => {
    m.resolve.mockResolvedValue({ anthropic: null });

    expect(await batchSubmitKey()).toBeUndefined();
  });

  it('rejects a placeholder platform key', async () => {
    m.resolve.mockResolvedValue({ anthropic: 'not-configured' });

    expect(await batchSubmitKey()).toBeUndefined();
  });

  it('resolves platform keys only, never a user key', async () => {
    await batchSubmitKey();

    expect(m.resolve).toHaveBeenCalledWith(null, expect.anything());
  });
});

describe('batchPollKeys', () => {
  it('prefers the platform key and keeps the deployment secret as a drain-only second choice', async () => {
    expect(await batchPollKeys()).toEqual(['sk-platform', 'sk-deployment']);
  });

  it('lists one key when both sources hold the same value', async () => {
    m.resolve.mockResolvedValue({ anthropic: 'sk-deployment' });

    expect(await batchPollKeys()).toEqual(['sk-deployment']);
  });

  it('drops placeholder values, leaving nothing when neither source is configured', async () => {
    m.resolve.mockResolvedValue({ anthropic: null });
    m.config.ANTHROPIC_API_KEY = 'not-configured';

    expect(await batchPollKeys()).toEqual([]);
  });
});

describe('firstKeyHolding', () => {
  it('reads with the first key and does not try the second', async () => {
    const read = vi.fn(async (key: string) => `read:${key}`);

    expect(await firstKeyHolding(['a', 'b'], read)).toEqual({ key: 'a', value: 'read:a' });
    expect(read).toHaveBeenCalledTimes(1);
  });

  it('moves to the next key when the first does not hold the batch', async () => {
    const read = vi.fn(async (key: string) => {
      if (key === 'a') throw notFound;
      return `read:${key}`;
    });

    expect(await firstKeyHolding(['a', 'b'], read)).toEqual({ key: 'b', value: 'read:b' });
  });

  it('throws any other failure without trying the next key', async () => {
    const read = vi.fn(async () => {
      throw Object.assign(new Error('overloaded'), { status: 529 });
    });

    await expect(firstKeyHolding(['a', 'b'], read)).rejects.toThrow('overloaded');
    expect(read).toHaveBeenCalledTimes(1);
  });

  it('throws the miss when no key holds the batch', async () => {
    const read = vi.fn(async () => {
      throw notFound;
    });

    await expect(firstKeyHolding(['a', 'b'], read)).rejects.toBe(notFound);
    expect(read).toHaveBeenCalledTimes(2);
  });
});
