import { beforeEach, describe, expect, it, vi } from 'vitest';
import { renderHook } from '@testing-library/react';
import { AxiosError } from 'axios';
import { toast } from 'sonner';
import { ProfileTestWrapper } from '../profileTestUtils';
import { useAdminUserOrgMembership } from './useAdminUserOrgMembership';

const mocks = vi.hoisted(() => ({ post: vi.fn(), patch: vi.fn(), delete: vi.fn() }));

vi.mock('@client/app/contexts/ApiContext', () => ({
  api: { post: mocks.post, patch: mocks.patch, delete: mocks.delete },
}));
vi.mock('@client/app/utils/stepUpInterceptor', () => ({
  isStepUpCancelled: (error: unknown) => typeof error === 'object' && error !== null && 'cancelled' in error,
}));
vi.mock('sonner', () => ({ toast: { error: vi.fn(), success: vi.fn() } }));

const requestFailed = (body?: unknown) =>
  new AxiosError('Request failed with status code 404', 'ERR_BAD_REQUEST', undefined, undefined, {
    status: 404,
    statusText: 'Not Found',
    data: body,
    headers: {},
    config: {} as never,
  });

const renderMembership = () => renderHook(() => useAdminUserOrgMembership('user-1'), { wrapper: ProfileTestWrapper });

beforeEach(() => {
  vi.clearAllMocks();
});

describe('useAdminUserOrgMembership', () => {
  it('rethrows the friendly message it toasted, keeping the request error as the cause', async () => {
    const raw = requestFailed();
    mocks.post.mockRejectedValue(raw);
    const { result } = renderMembership();

    const failure = await result.current.add('org-1', 'Customer request').catch((e: unknown) => e);

    expect(failure).toBeInstanceOf(Error);
    expect((failure as Error).message).toBe('They were not added to the organization.');
    expect((failure as Error).cause).toBe(raw);
    expect(toast.error).toHaveBeenCalledWith('They were not added to the organization.');
  });

  it('prefers the server message over the fallback', async () => {
    mocks.delete.mockRejectedValue(requestFailed({ error: 'They are not a member of Acme.' }));
    const { result } = renderMembership();

    await expect(result.current.remove('org-1', 'Left the team')).rejects.toThrow('They are not a member of Acme.');
    expect(toast.error).toHaveBeenCalledWith('They are not a member of Acme.');
  });

  it('rethrows a cancelled step-up untouched and silent', async () => {
    const cancelled = Object.assign(new Error('cancelled'), { cancelled: true });
    mocks.patch.mockRejectedValue(cancelled);
    const { result } = renderMembership();

    await expect(result.current.setRole('org-1', 'manager', 'Promoted')).rejects.toBe(cancelled);
    expect(toast.error).not.toHaveBeenCalled();
  });
});
