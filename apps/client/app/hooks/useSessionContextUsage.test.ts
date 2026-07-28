import { renderHook } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { useSessionContextUsage } from './useSessionContextUsage';
import { useGetSessionQuests } from '@client/app/hooks/data/sessions';

vi.mock('@client/app/hooks/data/sessions', () => ({
  useGetSessionQuests: vi.fn(),
}));

const SAFE_MAX = 100_000;

type UsageOverrides = {
  utilizationPercentage?: number;
  actualInputTokens?: number;
  overflowDetected?: boolean;
  cacheReadInputTokens?: number;
};

function quest(id: string, overrides: UsageOverrides = {}) {
  const actualInputTokens = overrides.actualInputTokens ?? 50_000;
  return {
    id,
    promptMeta: {
      tokenUsage: { cacheReadInputTokens: overrides.cacheReadInputTokens },
      context: {
        contextWindowUsage: {
          contextLimit: 131_072,
          maxOutputTokens: 16_384,
          safeMaxInputTokens: SAFE_MAX,
          actualInputTokens,
          bufferTokens: 1000,
          utilizationPercentage: overrides.utilizationPercentage ?? (actualInputTokens / SAFE_MAX) * 100,
          overflowDetected: overrides.overflowDetected,
        },
      },
    },
  };
}

function mockPages(quests: unknown[]) {
  (useGetSessionQuests as unknown as ReturnType<typeof vi.fn>).mockReturnValue({
    data: { pages: [{ data: quests, hasMore: false }] },
  });
}

describe('useSessionContextUsage', () => {
  beforeEach(() => vi.clearAllMocks());

  it('returns null when no quest carries context telemetry', () => {
    (useGetSessionQuests as unknown as ReturnType<typeof vi.fn>).mockReturnValue({ data: undefined });
    const { result } = renderHook(() => useSessionContextUsage('s1'));
    expect(result.current).toBeNull();
  });

  it('skips optimistic/in-flight quests that have no telemetry yet', () => {
    mockPages([{ id: 'tmp-1', promptMeta: undefined }, quest('q1', { utilizationPercentage: 40 })]);
    const { result } = renderHook(() => useSessionContextUsage('s1'));
    expect(result.current?.band).toBe('normal');
  });

  it('picks the newest quest (highest ObjectId) with telemetry', () => {
    mockPages([
      quest('q1', { utilizationPercentage: 20 }),
      quest('q3', { utilizationPercentage: 95 }),
      quest('q2', { utilizationPercentage: 50 }),
    ]);
    const { result } = renderHook(() => useSessionContextUsage('s1'));
    expect(result.current?.utilizationPercentage).toBe(95);
    expect(result.current?.band).toBe('danger');
  });

  it('bands normal / warning / danger at the thresholds', () => {
    mockPages([quest('q1', { utilizationPercentage: 69 })]);
    expect(renderHook(() => useSessionContextUsage('s1')).result.current?.band).toBe('normal');

    mockPages([quest('q1', { utilizationPercentage: 70 })]);
    const warning = renderHook(() => useSessionContextUsage('s1')).result.current;
    expect(warning?.band).toBe('warning');
    expect(warning?.isApproachingLimit).toBe(true);

    mockPages([quest('q1', { utilizationPercentage: 90 })]);
    expect(renderHook(() => useSessionContextUsage('s1')).result.current?.band).toBe('danger');
  });

  it('forces danger when the backend flagged an overflow', () => {
    mockPages([quest('q1', { utilizationPercentage: 30, overflowDetected: true })]);
    const { result } = renderHook(() => useSessionContextUsage('s1'));
    expect(result.current?.band).toBe('danger');
    expect(result.current?.overflowDetected).toBe(true);
  });

  it('flags cachingIneffective only for a large context with zero observed cache reads', () => {
    mockPages([quest('q1', { actualInputTokens: 30_000, cacheReadInputTokens: 0 })]);
    expect(renderHook(() => useSessionContextUsage('s1')).result.current?.cachingIneffective).toBe(true);

    mockPages([quest('q1', { actualInputTokens: 30_000, cacheReadInputTokens: 5_000 })]);
    expect(renderHook(() => useSessionContextUsage('s1')).result.current?.cachingIneffective).toBe(false);

    mockPages([quest('q1', { actualInputTokens: 10_000, cacheReadInputTokens: 0 })]);
    expect(renderHook(() => useSessionContextUsage('s1')).result.current?.cachingIneffective).toBe(false);
  });
});
