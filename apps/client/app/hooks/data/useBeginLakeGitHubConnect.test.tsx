import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import type { ReactNode } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { useBeginLakeGitHubConnect } from './useBeginLakeGitHubConnect';
import { api } from '@client/app/contexts/ApiContext';
import { readGitHubLakeConnectHandoff } from '@client/app/utils/githubLakeConnectHandoff';

vi.mock('@client/app/contexts/ApiContext', () => ({
  api: { post: vi.fn() },
}));
const h = vi.hoisted(() => ({ toastError: vi.fn() }));
vi.mock('sonner', () => ({ toast: { error: h.toastError } }));

const AUTHORIZE_URL = 'https://github.com/login/oauth/authorize?client_id=c&state=s1';
const assign = vi.fn();

const wrapper = ({ children }: { children: ReactNode }) => {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>;
};

beforeEach(() => {
  vi.clearAllMocks();
  sessionStorage.clear();
  vi.stubGlobal('location', { assign });
});
afterEach(() => {
  vi.unstubAllGlobals();
});

describe('useBeginLakeGitHubConnect', () => {
  it('saves the handoff and leaves for the authorize URL on success', async () => {
    vi.mocked(api.post).mockResolvedValue({ data: { authorizeUrl: AUTHORIZE_URL } });
    const { result } = renderHook(() => useBeginLakeGitHubConnect('lake1'), { wrapper });

    await act(async () => result.current.begin());

    expect(api.post).toHaveBeenCalledWith('/api/data-lakes/lake1/github-connection');
    expect(readGitHubLakeConnectHandoff()).toEqual({ dataLakeId: 'lake1' });
    expect(assign).toHaveBeenCalledWith(AUTHORIZE_URL);
  });

  it('does not leave for GitHub when the handoff cannot be saved (storage blocked)', async () => {
    vi.mocked(api.post).mockResolvedValue({ data: { authorizeUrl: AUTHORIZE_URL } });
    const setItemSpy = vi.spyOn(Storage.prototype, 'setItem').mockImplementationOnce(() => {
      throw new Error('blocked');
    });

    const { result } = renderHook(() => useBeginLakeGitHubConnect('lake1'), { wrapper });
    await act(async () => result.current.begin());

    expect(assign).not.toHaveBeenCalled();
    expect(h.toastError).toHaveBeenCalledWith(expect.stringMatching(/session storage/));
    setItemSpy.mockRestore();
  });

  it("surfaces the server's reason when the connect cannot start", async () => {
    vi.mocked(api.post).mockRejectedValue({
      isAxiosError: true,
      response: { data: { error: '"Lake" is curated.' } },
    });
    const { result } = renderHook(() => useBeginLakeGitHubConnect('lake1'), { wrapper });

    await act(async () => result.current.begin());

    expect(h.toastError).toHaveBeenCalledWith('"Lake" is curated.');
    expect(assign).not.toHaveBeenCalled();
  });
});
