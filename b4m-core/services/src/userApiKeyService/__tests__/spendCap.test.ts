import { describe, it, expect, vi, beforeEach } from 'vitest';
import { setEmbedKeySpendCap, resetEmbedKeySpend } from '../spendCap';
import { EMBED_SPEND_CAP_MAX_CREDITS } from '../create';
import { ApiKeyScope } from '@bike4mind/common';

function makeRepo(stored: { id: string; scopes: ApiKeyScope[] } | null) {
  return {
    findByUserIdAndId: vi.fn().mockResolvedValue(stored),
    setSpendCap: vi.fn().mockResolvedValue(undefined),
    resetSpend: vi.fn().mockResolvedValue(undefined),
  };
}

const embedKey = { id: 'key-1', scopes: [ApiKeyScope.EMBED_CHAT] };

describe('setEmbedKeySpendCap', () => {
  let repo: ReturnType<typeof makeRepo>;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const adapters = () => ({ db: { userApiKeys: repo as any } });

  beforeEach(() => {
    repo = makeRepo(embedKey);
  });

  it('sets a valid cap on an owned embed key', async () => {
    const result = await setEmbedKeySpendCap('user-1', { keyId: 'key-1', spendCap: 5000 }, adapters());
    expect(repo.findByUserIdAndId).toHaveBeenCalledWith('user-1', 'key-1');
    expect(repo.setSpendCap).toHaveBeenCalledWith('key-1', 5000);
    expect(result).toEqual({ id: 'key-1', spendCap: 5000 });
  });

  it('clears the cap with null (returned as undefined = uncapped)', async () => {
    const result = await setEmbedKeySpendCap('user-1', { keyId: 'key-1', spendCap: null }, adapters());
    expect(repo.setSpendCap).toHaveBeenCalledWith('key-1', null);
    expect(result).toEqual({ id: 'key-1', spendCap: undefined });
  });

  it('throws NotFound for a key the caller does not own', async () => {
    repo = makeRepo(null);
    await expect(setEmbedKeySpendCap('user-1', { keyId: 'key-1', spendCap: 100 }, adapters())).rejects.toThrow(
      /not found/i
    );
    expect(repo.setSpendCap).not.toHaveBeenCalled();
  });

  it('rejects a non-embed key', async () => {
    repo = makeRepo({ id: 'key-1', scopes: [ApiKeyScope.AI_CHAT] });
    await expect(setEmbedKeySpendCap('user-1', { keyId: 'key-1', spendCap: 100 }, adapters())).rejects.toThrow(
      /embed:chat scope/
    );
    expect(repo.setSpendCap).not.toHaveBeenCalled();
  });

  it.each([
    ['zero', 0],
    ['negative', -1],
    ['fractional', 1.5],
    ['above the ceiling', EMBED_SPEND_CAP_MAX_CREDITS + 1],
  ])('rejects a cap that is %s', async (_label, spendCap) => {
    await expect(setEmbedKeySpendCap('user-1', { keyId: 'key-1', spendCap }, adapters())).rejects.toThrow();
    expect(repo.setSpendCap).not.toHaveBeenCalled();
  });
});

describe('resetEmbedKeySpend', () => {
  let repo: ReturnType<typeof makeRepo>;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const adapters = () => ({ db: { userApiKeys: repo as any } });

  beforeEach(() => {
    repo = makeRepo(embedKey);
  });

  it('zeroes the meter on an owned embed key', async () => {
    const result = await resetEmbedKeySpend('user-1', { keyId: 'key-1' }, adapters());
    expect(repo.resetSpend).toHaveBeenCalledWith('key-1');
    expect(result).toEqual({ id: 'key-1' });
  });

  it('throws NotFound for a key the caller does not own', async () => {
    repo = makeRepo(null);
    await expect(resetEmbedKeySpend('user-1', { keyId: 'key-1' }, adapters())).rejects.toThrow(/not found/i);
    expect(repo.resetSpend).not.toHaveBeenCalled();
  });

  it('rejects a non-embed key', async () => {
    repo = makeRepo({ id: 'key-1', scopes: [ApiKeyScope.AI_CHAT] });
    await expect(resetEmbedKeySpend('user-1', { keyId: 'key-1' }, adapters())).rejects.toThrow(/embed:chat scope/);
    expect(repo.resetSpend).not.toHaveBeenCalled();
  });
});
