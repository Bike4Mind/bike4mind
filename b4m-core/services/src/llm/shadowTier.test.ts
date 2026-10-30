import { describe, expect, it, vi } from 'vitest';
import type { ModelInfo } from '@bike4mind/common';
import {
  executedModelFields,
  recordShadowTokenUsage,
  reserveShadowTokenBudget,
  resolveShadowModelInfo,
  shadowCandidates,
  shadowTokenKey,
} from './shadowTier';

const shadow = { id: 'u1', throttle: { tier: 'shadow' as const } };
const normal = { id: 'u2' };
const allowlist = ['cheap-a', 'cheap-b'];

const cacheMock = (success = true) => ({
  tryAddWithinLimitFixedWindow: vi.fn().mockResolvedValue({ success, count: 1, expiresAt: new Date() }),
});

describe('resolveShadowModelInfo', () => {
  const model = (id: string, extra: Partial<ModelInfo> = {}) => ({ id, type: 'text', ...extra }) as ModelInfo;

  it('returns the substitute model info for a restricted user', () => {
    const models = [model('premium'), model('cheap-a')];
    expect(resolveShadowModelInfo(shadow, models[0], models, allowlist)?.id).toBe('cheap-a');
  });

  it('picks the first allowlisted model that is available', () => {
    const models = [model('premium'), model('cheap-b')];
    expect(resolveShadowModelInfo(shadow, models[0], models, allowlist)?.id).toBe('cheap-b');
  });

  it('never substitutes for an admin', () => {
    const models = [model('premium'), model('cheap-a')];
    expect(resolveShadowModelInfo({ ...shadow, isAdmin: true }, models[0], models, allowlist)).toBeUndefined();
  });

  it('returns undefined when nothing changes', () => {
    const models = [model('premium'), model('cheap-a')];
    expect(resolveShadowModelInfo(normal, models[0], models, allowlist)).toBeUndefined();
    expect(resolveShadowModelInfo(shadow, models[1], models, allowlist)).toBeUndefined();
  });

  it('ignores disabled allowlisted models and leaves non-text requests alone', () => {
    const models = [model('premium'), model('cheap-a', { disabled: true }), model('image', { type: 'image' })];
    expect(resolveShadowModelInfo(shadow, models[0], models, allowlist)).toBeUndefined();
    expect(resolveShadowModelInfo(shadow, models[2], [...models, model('cheap-b')], allowlist)).toBeUndefined();
  });
});

describe('shadowCandidates', () => {
  const model = (id: string, extra: Partial<ModelInfo> = {}) => ({ id, type: 'text', ...extra }) as ModelInfo;

  it('lists the runnable allowlisted models in allowlist order', () => {
    const models = [model('cheap-b'), model('premium'), model('cheap-a')];
    expect(shadowCandidates(models, allowlist).map(m => m.id)).toEqual(['cheap-a', 'cheap-b']);
    expect(
      shadowCandidates([model('cheap-a', { disabled: true }), model('cheap-b')], allowlist).map(m => m.id)
    ).toEqual(['cheap-b']);
  });
});

describe('daily token budget', () => {
  it('keys the counter by UTC day', () => {
    expect(shadowTokenKey('u1', new Date('2026-03-01T23:59:00Z'))).not.toBe(
      shadowTokenKey('u1', new Date('2026-03-02T00:01:00Z'))
    );
    expect(shadowTokenKey('u1', new Date('2026-03-01T23:59:00Z'))).toBe('shadow-tokens:u1:2026-03-01');
  });

  it('allows a restricted user under the cap', async () => {
    const cache = cacheMock(true);
    await expect(reserveShadowTokenBudget(shadow, 20000, { cache })).resolves.toBe(true);
    expect(cache.tryAddWithinLimitFixedWindow).toHaveBeenCalledWith(
      expect.stringMatching(/^shadow-tokens:u1:/),
      1,
      20000,
      expect.any(Number)
    );
  });

  it('denies a restricted user at the cap', async () => {
    await expect(reserveShadowTokenBudget(shadow, 20000, { cache: cacheMock(false) })).resolves.toBe(false);
  });

  it('makes no cache call for a non-restricted user', async () => {
    const cache = cacheMock();
    await expect(reserveShadowTokenBudget(normal, 20000, { cache })).resolves.toBe(true);
    await recordShadowTokenUsage(normal, 500, { cache });
    expect(cache.tryAddWithinLimitFixedWindow).not.toHaveBeenCalled();
  });

  it('records usage against an unbounded limit and skips zero', async () => {
    const cache = cacheMock();
    await recordShadowTokenUsage(shadow, 0, { cache });
    expect(cache.tryAddWithinLimitFixedWindow).not.toHaveBeenCalled();
    await recordShadowTokenUsage(shadow, 1234, { cache });
    expect(cache.tryAddWithinLimitFixedWindow).toHaveBeenCalledWith(
      expect.stringMatching(/^shadow-tokens:u1:/),
      1234,
      Number.MAX_SAFE_INTEGER,
      expect.any(Number)
    );
  });

  it('never throws when recording fails', async () => {
    const cache = { tryAddWithinLimitFixedWindow: vi.fn().mockRejectedValue(new Error('down')) };
    await expect(recordShadowTokenUsage(shadow, 10, { cache })).resolves.toBeUndefined();
  });
});

describe('executedModelFields', () => {
  const requested = { id: 'premium', backend: 'anthropic' };
  it('names the executed model only when it differs from the recorded one', () => {
    expect(executedModelFields(requested, { id: 'cheap', backend: 'gemini' })).toEqual({
      executedProvider: 'gemini',
      executedModel: 'cheap',
    });
    expect(executedModelFields(requested, requested)).toEqual({});
    expect(executedModelFields(requested, undefined)).toEqual({});
  });
});
