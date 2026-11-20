import type { ReactNode } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { act, renderHook } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { EVAL_SETS_QUERY_KEY, useEvalSetVerdict } from './verdictEvalSets';

const mocks = vi.hoisted(() => ({ post: vi.fn() }));
vi.mock('@client/app/contexts/ApiContext', () => ({ api: { post: mocks.post } }));

const request = {
  userId: 'a'.repeat(24),
  verdict: 'confirmed_abuse' as const,
  reason: 'looks like a farm',
  expectedRevision: 2,
};

const setup = () => {
  const cache = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  const wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={cache}>{children}</QueryClientProvider>
  );
  const keys = [
    [...EVAL_SETS_QUERY_KEY, 'list'],
    [...EVAL_SETS_QUERY_KEY, 'detail', 's1'],
  ];
  keys.forEach(key => cache.setQueryData(key, {}));
  const invalidated = () => keys.map(key => cache.getQueryState(key)?.isInvalidated);
  return { wrapper, invalidated };
};

beforeEach(() => {
  vi.resetAllMocks();
});

describe('useEvalSetVerdict', () => {
  it('posts to the set and refreshes the list and the detail', async () => {
    const { wrapper, invalidated } = setup();
    mocks.post.mockResolvedValue({ data: { ok: true } });
    const { result } = renderHook(() => useEvalSetVerdict('s1'), { wrapper });
    await act(async () => {
      await result.current.mutateAsync(request);
    });
    expect(mocks.post).toHaveBeenCalledWith('/api/admin/shadow-detections/eval-sets/s1/verdict', request);
    expect(invalidated()).toEqual([true, true]);
  });

  it('refreshes the list and the detail after a 409 so the example is reviewed again', async () => {
    const { wrapper, invalidated } = setup();
    mocks.post.mockRejectedValue({ isAxiosError: true, response: { status: 409, data: {} } });
    const { result } = renderHook(() => useEvalSetVerdict('s1'), { wrapper });
    await act(async () => {
      await expect(result.current.mutateAsync(request)).rejects.toMatchObject({ response: { status: 409 } });
    });
    expect(invalidated()).toEqual([true, true]);
  });
});
