import { describe, expect, it, vi } from 'vitest';
import { act, renderHook } from '@testing-library/react';
import { QueryClient } from '@tanstack/react-query';
import { ProfileTestWrapper } from '../profileTestUtils';
import { useAdminUserUpdate } from './useAdminUserUpdate';

vi.mock('@client/app/utils/userAPICalls', () => ({ updateUserToServer: vi.fn().mockResolvedValue({}) }));

describe('useAdminUserUpdate', () => {
  it('refetches the API keys after a write, since a suspend deactivates them', async () => {
    const invalidate = vi.spyOn(QueryClient.prototype, 'invalidateQueries');
    const { result } = renderHook(() => useAdminUserUpdate('user-1'), { wrapper: ProfileTestWrapper });

    await act(() => result.current({ isBanned: true }));

    expect(invalidate).toHaveBeenCalledWith({ queryKey: ['admin', 'user-api-keys', 'user-1'] });
    invalidate.mockRestore();
  });
});
