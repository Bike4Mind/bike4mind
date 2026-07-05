import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, waitFor, act } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

/**
 * Regression coverage: starting an upload while offline used to be a silent
 * no-op - the mutation rejected, but the toast (if it fired at all) had no
 * retry affordance and the raw axios "Network Error" wasn't user-friendly.
 */

const { toastMock, apiPost } = vi.hoisted(() => ({
  toastMock: { error: vi.fn(), success: vi.fn(), warning: vi.fn() },
  apiPost: vi.fn(),
}));

vi.mock('sonner', () => ({ toast: toastMock }));
vi.mock('@client/app/contexts/ApiContext', () => ({
  api: { post: apiPost, put: vi.fn(), delete: vi.fn() },
}));
vi.mock('@client/app/contexts/WebsocketContext', () => ({
  useWebsocket: () => ({ subscribeToAction: () => () => {} }),
}));

import { useBatchUpload } from './dataLakeWizard';
import { useDataLakeWizardStore } from '@client/app/stores/useDataLakeWizardStore';

const mountBatchUpload = () => {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const wrapper: React.FC<{ children: React.ReactNode }> = ({ children }) =>
    React.createElement(QueryClientProvider, { client: queryClient }, children);
  return renderHook(() => useBatchUpload(), { wrapper });
};

const seedWizardFile = () =>
  useDataLakeWizardStore.setState({
    targetLake: null,
    config: {
      name: 'Test Lake',
      description: '',
      tagPrefix: 'test:',
      requiredUserTag: '',
      requiredEntitlement: '',
      conflictResolution: 'skip',
    },
    allFiles: [
      {
        file: new File(['contents'], 'a.txt', { type: 'text/plain' }),
        relativePath: 'a.txt',
        size: 8,
        type: 'text/plain',
        excluded: false,
        isDuplicate: false,
      },
    ],
  });

describe('useBatchUpload onError', () => {
  beforeEach(() => {
    apiPost.mockReset();
    toastMock.error.mockClear();
    useDataLakeWizardStore.getState().resetWizard();
  });

  it('fails fast without ever calling the API when navigator.onLine is false', async () => {
    // Regression: previously the mutation's only defense against being offline was
    // whatever axios/the browser did with a timeout-less request - which, per manual
    // testing with DevTools "Offline", can hang indefinitely rather than reject,
    // leaving "Start Upload" spinning forever. The upfront navigator.onLine check
    // must short-circuit before any network call is attempted.
    const onLineSpy = vi.spyOn(navigator, 'onLine', 'get').mockReturnValue(false);
    seedWizardFile();

    const { result } = mountBatchUpload();
    act(() => {
      result.current.mutate();
    });

    await waitFor(() => expect(toastMock.error).toHaveBeenCalledTimes(1));

    expect(apiPost).not.toHaveBeenCalled();
    const [message] = toastMock.error.mock.calls[0] as [string];
    expect(message).toBe('No internet connection — check your network and try again.');
    expect(result.current.isPending).toBe(false);

    onLineSpy.mockRestore();
  });

  it('shows a friendly offline message with a retry action when the network is unreachable', async () => {
    apiPost.mockRejectedValue({ isAxiosError: true, code: 'ERR_NETWORK', message: 'Network Error' });
    seedWizardFile();

    const { result } = mountBatchUpload();
    act(() => {
      result.current.mutate();
    });

    await waitFor(() => expect(toastMock.error).toHaveBeenCalledTimes(1));

    const [message, opts] = toastMock.error.mock.calls[0] as [
      string,
      { action: { label: string; onClick: () => void } },
    ];
    expect(message).toBe('No internet connection — check your network and try again.');
    expect(opts.action.label).toBe('Retry');

    // The wizard's uploadProgress reflects the same friendly message, since the
    // wizard can still be showing the Configure step (setStep('upload') never ran).
    expect(useDataLakeWizardStore.getState().uploadProgress.status).toBe('error');
    expect(useDataLakeWizardStore.getState().uploadProgress.errorMessage).toBe(message);
  });

  it('retrying via the toast action re-invokes the upload', async () => {
    apiPost.mockRejectedValue({ isAxiosError: true, code: 'ERR_NETWORK', message: 'Network Error' });
    seedWizardFile();

    const { result } = mountBatchUpload();
    act(() => {
      result.current.mutate();
    });
    await waitFor(() => expect(toastMock.error).toHaveBeenCalledTimes(1));

    const opts = toastMock.error.mock.calls[0][1] as { action: { onClick: () => void } };
    apiPost.mockClear();
    act(() => opts.action.onClick());

    await waitFor(() => expect(apiPost).toHaveBeenCalledTimes(1));
  });
});
