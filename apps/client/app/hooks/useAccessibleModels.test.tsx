import { renderHook } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { PAID_PLAN_ENTITLEMENT_KEY, type LLMModelConfig, type ModelInfo } from '@bike4mind/common';
import { useAccessibleModels } from './useAccessibleModels';

const h = vi.hoisted(() => ({
  locked: [] as unknown[],
  saved: [] as unknown[],
  entitlements: ['base'] as string[],
  user: { tags: [] as string[], isAdmin: false },
}));

vi.mock('@client/app/contexts/UserContext', () => ({
  useUser: (selector: (state: { currentUser: typeof h.user }) => unknown) => selector({ currentUser: h.user }),
}));
vi.mock('@client/app/hooks/data/useModelInfo', () => ({
  useModelInfo: () => ({ data: [], isPending: false, isError: false, refetch: vi.fn() }),
  useLockedModels: () => ({ data: h.locked, isPending: false }),
}));
vi.mock('@client/app/hooks/data/entitlements', () => ({
  useEntitlements: () => ({ data: h.entitlements, isLoading: false }),
}));
// Mirrors the real merge (saved config over ModelInfo, else enabled with the base entitlement); the real
// module imports the API client, which this unit test does not need.
vi.mock('@client/app/hooks/data/llmModelConfig', async () => {
  const { useMemo } = await import('react');
  return {
    useLLMModelConfigurationsWithDefaults: (infos?: ModelInfo[], pending = false) => ({
      data: useMemo(
        () =>
          (infos ?? []).map(info => {
            const saved = (h.saved as LLMModelConfig[]).find(config => config.id === info.id);
            return saved
              ? { ...info, ...saved }
              : { ...info, enabled: true, allowedUserTags: [], allowedEntitlements: ['base'] };
          }),
        [infos]
      ),
      isLoading: pending,
    }),
  };
});

const lockedModel = (id: string) =>
  ({
    id,
    name: id,
    type: 'text',
    access: { locked: true, reason: 'requires_paid_plan' },
  }) as unknown as ModelInfo;

const config = (id: string, overrides: Partial<LLMModelConfig>) =>
  ({ id, enabled: true, allowedUserTags: [], allowedEntitlements: [], ...overrides }) as LLMModelConfig;

const lockedIds = () => renderHook(() => useAccessibleModels()).result.current.lockedModels.map(m => m.id);

describe('useAccessibleModels lockedModels', () => {
  beforeEach(() => {
    h.locked = [lockedModel('paid-a')];
    h.saved = [];
    h.entitlements = ['base'];
    h.user = { tags: [], isAdmin: false };
  });

  it('keeps a locked model with no saved config and returns the original ModelInfo', () => {
    const result = renderHook(() => useAccessibleModels()).result.current;
    expect(result.lockedModels).toEqual(h.locked);
    expect(result.lockedModels[0].access).toEqual({ locked: true, reason: 'requires_paid_plan' });
  });

  it('drops a locked model an admin disabled', () => {
    h.saved = [config('paid-a', { enabled: false, allowedEntitlements: ['base'] })];
    expect(lockedIds()).toEqual([]);
  });

  it('drops a locked model restricted to a tag the user lacks', () => {
    h.saved = [config('paid-a', { allowedUserTags: ['beta'] })];
    expect(lockedIds()).toEqual([]);
  });

  it('keeps a locked model restricted to a tag the user holds', () => {
    h.saved = [config('paid-a', { allowedUserTags: ['beta'] })];
    h.user = { tags: ['beta'], isAdmin: false };
    expect(lockedIds()).toEqual(['paid-a']);
  });

  it('keeps a locked model whose config allows the paid-plan entitlement', () => {
    h.saved = [config('paid-a', { allowedEntitlements: [PAID_PLAN_ENTITLEMENT_KEY] })];
    expect(lockedIds()).toEqual(['paid-a']);
  });

  it('drops a locked model gated on an entitlement the paid plan does not grant', () => {
    h.saved = [config('paid-a', { allowedEntitlements: ['plan:enterprise'] })];
    expect(lockedIds()).toEqual([]);
  });
});
