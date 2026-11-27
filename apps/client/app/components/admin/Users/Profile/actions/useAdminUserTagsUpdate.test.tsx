import { describe, expect, it, vi } from 'vitest';
import { act, renderHook } from '@testing-library/react';
import { QueryClient } from '@tanstack/react-query';
import { ProfileTestWrapper } from '../profileTestUtils';
import { useAdminUserTagsUpdate } from './useAdminUserTagsUpdate';

vi.mock('@client/app/contexts/ApiContext', () => ({
  api: { patch: vi.fn().mockResolvedValue({ data: { tags: ['pilot'] } }) },
}));

describe('useAdminUserTagsUpdate', () => {
  it('refreshes users, the tag filter, entitlements and timeline before resolving', async () => {
    const invalidate = vi.spyOn(QueryClient.prototype, 'invalidateQueries');
    const { result } = renderHook(() => useAdminUserTagsUpdate('user-1'), { wrapper: ProfileTestWrapper });
    await act(async () => {
      expect(await result.current({ before: [], tags: [' pilot '] })).toEqual(['pilot']);
    });
    expect(invalidate).toHaveBeenCalledWith({ queryKey: ['users'] });
    expect(invalidate).toHaveBeenCalledWith({ queryKey: ['admin', 'users', 'user-1'] });
    expect(invalidate).toHaveBeenCalledWith({ queryKey: ['admin', 'user-entitlements', 'user-1'] });
    invalidate.mockRestore();
  });
});
