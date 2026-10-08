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
    const onFailed = vi.fn();

    await act(async () => result.current.begin({ onFailed }));

    expect(onFailed).not.toHaveBeenCalled();
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
    const onFailed = vi.fn();
    await act(async () => result.current.begin({ onFailed }));

    expect(assign).not.toHaveBeenCalled();
    expect(h.toastError).toHaveBeenCalledWith(expect.stringMatching(/session storage/));
    expect(onFailed).toHaveBeenCalledTimes(1);
    setItemSpy.mockRestore();
  });

  it("surfaces the server's reason when the connect cannot start", async () => {
    const refusal = { isAxiosError: true, response: { status: 400, data: { error: '"Lake" is curated.' } } };
    vi.mocked(api.post).mockRejectedValue(refusal);
    const { result } = renderHook(() => useBeginLakeGitHubConnect('lake1'), { wrapper });
    const onFailed = vi.fn();

    await act(async () => result.current.begin({ onFailed }));

    expect(h.toastError).toHaveBeenCalledWith('"Lake" is curated.');
    expect(assign).not.toHaveBeenCalled();
    expect(onFailed).toHaveBeenCalledWith(refusal);
  });

  it('asks the start to switch a curated lake when ensureConnectorFed is set', async () => {
    vi.mocked(api.post).mockResolvedValue({ data: { authorizeUrl: AUTHORIZE_URL } });
    const { result } = renderHook(() => useBeginLakeGitHubConnect('lake1'), { wrapper });

    await act(async () => result.current.begin({ ensureConnectorFed: true }));

    expect(api.post).toHaveBeenCalledWith('/api/data-lakes/lake1/github-connection', { ensureConnectorFed: true });
    expect(assign).toHaveBeenCalledWith(AUTHORIZE_URL);
  });

  it('still leaves for GitHub when the caller unmounts while the start is in flight', async () => {
    let resolveStart!: (value: unknown) => void;
    vi.mocked(api.post).mockReturnValue(new Promise(resolve => (resolveStart = resolve)));
    const { result, unmount } = renderHook(() => useBeginLakeGitHubConnect('lake1'), { wrapper });

    let pending!: Promise<void>;
    act(() => {
      pending = result.current.begin({ ensureConnectorFed: true });
    });
    unmount();
    await act(async () => {
      resolveStart({ data: { authorizeUrl: AUTHORIZE_URL } });
      await pending;
    });

    expect(readGitHubLakeConnectHandoff()).toEqual({ dataLakeId: 'lake1' });
    expect(assign).toHaveBeenCalledWith(AUTHORIZE_URL);
  });

  it('still reports a refusal when the caller unmounts while the start is in flight', async () => {
    let rejectStart!: (reason: unknown) => void;
    vi.mocked(api.post).mockReturnValue(new Promise((_resolve, reject) => (rejectStart = reject)));
    const { result, unmount } = renderHook(() => useBeginLakeGitHubConnect('lake1'), { wrapper });
    const onFailed = vi.fn();

    let pending!: Promise<void>;
    act(() => {
      pending = result.current.begin({ onFailed });
    });
    unmount();
    const refusal = { isAxiosError: true, response: { status: 400, data: { error: 'Not configured' } } };
    await act(async () => {
      rejectStart(refusal);
      await pending;
    });

    expect(h.toastError).toHaveBeenCalledWith('Not configured');
    expect(onFailed).toHaveBeenCalledWith(refusal);
    expect(assign).not.toHaveBeenCalled();
  });
});
