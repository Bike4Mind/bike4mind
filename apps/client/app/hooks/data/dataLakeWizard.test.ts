import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, waitFor, act } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

/**
 * Regression coverage for the batch upload orchestration: the offline fail-fast +
 * retry affordance, and the rollback of orphan state (lake / FabFiles / batch) when
 * an upload fails (#816).
 */

const { toastMock, apiPost, apiPut, apiDelete, uploadMock } = vi.hoisted(() => ({
  toastMock: { error: vi.fn(), success: vi.fn(), warning: vi.fn() },
  apiPost: vi.fn(),
  apiPut: vi.fn(),
  apiDelete: vi.fn(),
  uploadMock: vi.fn(),
}));

vi.mock('sonner', () => ({ toast: toastMock }));
vi.mock('@client/app/contexts/ApiContext', () => ({
  api: { post: apiPost, put: apiPut, delete: apiDelete },
}));
vi.mock('@client/app/contexts/WebsocketContext', () => ({
  useWebsocket: () => ({ subscribeToAction: () => () => {} }),
}));
// The upload transport (auth-routing self-host vs S3) lives here; mock it so a test
// can make individual file PUTs succeed or fail deterministically.
vi.mock('@client/app/utils/uploadFileToUrl', () => ({ uploadFileToUrl: uploadMock }));
// Create mode reads the active org and reveals nav slots after the first upload -
// both reached only once a test runs past the offline short-circuit.
vi.mock('@client/app/hooks/data/dataLakes', () => ({ activeOrgId: () => undefined }));
vi.mock('@client/app/hooks/useGearsStatus', () => ({ invalidateGearsStatusWhileLocked: () => {} }));

import { useBatchUpload } from './dataLakeWizard';
import { useDataLakeWizardStore } from '@client/app/stores/useDataLakeWizardStore';

const mountBatchUpload = () => {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const wrapper: React.FC<{ children: React.ReactNode }> = ({ children }) =>
    React.createElement(QueryClientProvider, { client: queryClient }, children);
  return renderHook(() => useBatchUpload(), { wrapper });
};

type SeedOpts = { names?: string[]; targetLake?: { id: string; slug: string } | null };

const seedWizard = ({ names = ['a.txt'], targetLake = null }: SeedOpts = {}) =>
  useDataLakeWizardStore.setState({
    targetLake,
    config: {
      name: 'Test Lake',
      description: '',
      tagPrefix: 'test:',
      requiredUserTag: '',
      requiredEntitlement: '',
      conflictResolution: 'skip',
    },
    allFiles: names.map(name => ({
      file: new File(['contents'], name, { type: 'text/plain' }),
      relativePath: name,
      size: 8,
      type: 'text/plain',
      excluded: false,
      isDuplicate: false,
    })),
  });

// Route apiPost by URL: create lake -> lake1, create batch -> batch1, presign ->
// one descriptor per requested file (fileId = "id-<name>"), everything else -> ok.
const installApiPostRouter = () =>
  apiPost.mockImplementation((url: string, body?: { files?: { fileName: string }[] }) => {
    if (url === '/api/data-lakes') return Promise.resolve({ data: { id: 'lake1' } });
    if (url === '/api/data-lakes/batches') return Promise.resolve({ data: { id: 'batch1' } });
    if (url === '/api/files/generate-presigned-urls-batch') {
      const files = (body?.files ?? []).map(f => ({
        fileId: `id-${f.fileName}`,
        fileKey: `key-${f.fileName}`,
        url: `https://s3.example.com/${f.fileName}`,
        fileName: f.fileName,
      }));
      return Promise.resolve({ data: { files } });
    }
    return Promise.resolve({ data: { success: true } });
  });

const deleteCalledWith = (url: string) => apiDelete.mock.calls.some(([u]) => u === url);
const postCall = (url: string) => apiPost.mock.calls.find(([u]) => u === url);
const putCall = (url: string) => apiPut.mock.calls.find(([u]) => u === url);

const resetMocks = () => {
  apiPost.mockReset();
  apiPut.mockReset().mockResolvedValue({ data: { success: true } });
  apiDelete.mockReset().mockResolvedValue({ data: { success: true } });
  uploadMock.mockReset().mockResolvedValue(undefined);
  toastMock.error.mockClear();
  toastMock.success.mockClear();
  toastMock.warning.mockClear();
  useDataLakeWizardStore.getState().resetWizard();
};

describe('useBatchUpload onError (offline)', () => {
  beforeEach(resetMocks);

  it('fails fast without ever calling the API when navigator.onLine is false', async () => {
    // Regression: previously the mutation's only defense against being offline was
    // whatever axios/the browser did with a timeout-less request - which, per manual
    // testing with DevTools "Offline", can hang indefinitely rather than reject,
    // leaving "Start Upload" spinning forever. The upfront navigator.onLine check
    // must short-circuit before any network call is attempted.
    const onLineSpy = vi.spyOn(navigator, 'onLine', 'get').mockReturnValue(false);
    seedWizard();

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
    seedWizard();

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
    seedWizard();

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

describe('useBatchUpload rollback (#816)', () => {
  beforeEach(() => {
    resetMocks();
    installApiPostRouter();
  });

  it('total failure (create mode): archives the new lake, marks the batch failed, no success', async () => {
    uploadMock.mockRejectedValue(new Error('PUT failed'));
    seedWizard({ names: ['a.txt'] });

    const { result } = mountBatchUpload();
    act(() => result.current.mutate());
    await waitFor(() => expect(result.current.isError).toBe(true));

    // Empty new lake archived (cascade tears down its FabFiles + batch).
    expect(deleteCalledWith('/api/data-lakes/lake1')).toBe(true);
    // Batch driven to a terminal 'failed' state, not left mid-flight.
    expect(putCall('/api/data-lakes/batches/batch1')?.[1]).toMatchObject({ status: 'failed' });
    // Never closes out as if the upload landed, and never reports success.
    expect(postCall('/api/data-lakes/batches/upload-complete')).toBeUndefined();
    expect(toastMock.success).not.toHaveBeenCalled();
  });

  it('total failure (append mode): keeps the user lake, deletes only orphan FabFiles', async () => {
    uploadMock.mockRejectedValue(new Error('PUT failed'));
    seedWizard({ names: ['a.txt'], targetLake: { id: 'existing', slug: 'existing-slug' } });

    const { result } = mountBatchUpload();
    act(() => result.current.mutate());
    await waitFor(() => expect(result.current.isError).toBe(true));

    // Append mode never creates a lake...
    expect(postCall('/api/data-lakes')).toBeUndefined();
    // ...and never deletes the user's existing lake.
    expect(deleteCalledWith('/api/data-lakes/existing')).toBe(false);
    // The orphan 0-chunk FabFiles created by presign are removed.
    const del = apiDelete.mock.calls.find(([u]) => u === '/api/files/bulk-delete');
    expect(del?.[1]).toMatchObject({ data: { fileIds: ['id-a.txt'] } });
    // Batch still terminalized.
    expect(putCall('/api/data-lakes/batches/batch1')?.[1]).toMatchObject({ status: 'failed' });
  });

  it('partial failure: keeps the lake, deletes the failed file, hands off to upload-complete', async () => {
    // a.txt uploads, b.txt fails.
    uploadMock.mockImplementation((url: string) =>
      url.endsWith('b.txt') ? Promise.reject(new Error('PUT failed')) : Promise.resolve()
    );
    seedWizard({ names: ['a.txt', 'b.txt'] });

    const { result } = mountBatchUpload();
    act(() => result.current.mutate());
    await waitFor(() => expect(result.current.isSuccess).toBe(true));

    // Lake kept - it has a real file.
    expect(deleteCalledWith('/api/data-lakes/lake1')).toBe(false);
    // Only the failed file's orphan FabFile is removed.
    const del = apiDelete.mock.calls.find(([u]) => u === '/api/files/bulk-delete');
    expect(del?.[1]).toMatchObject({ data: { fileIds: ['id-b.txt'] } });
    // Browser-failure count handed to the server so completion math can be satisfied
    // (no stuck 'processing' batch).
    expect(postCall('/api/data-lakes/batches/upload-complete')?.[1]).toMatchObject({
      batchId: 'batch1',
      failedFiles: 1,
      failedFileNames: ['b.txt'],
    });
    expect(toastMock.warning).toHaveBeenCalled();
  });

  it('presign failure (create mode): rolls back the lake and marks the batch failed', async () => {
    apiPost.mockImplementation((url: string) => {
      if (url === '/api/data-lakes') return Promise.resolve({ data: { id: 'lake1' } });
      if (url === '/api/data-lakes/batches') return Promise.resolve({ data: { id: 'batch1' } });
      if (url === '/api/files/generate-presigned-urls-batch') return Promise.reject(new Error('presign 500'));
      return Promise.resolve({ data: { success: true } });
    });
    seedWizard({ names: ['a.txt'] });

    const { result } = mountBatchUpload();
    act(() => result.current.mutate());
    await waitFor(() => expect(result.current.isError).toBe(true));

    expect(deleteCalledWith('/api/data-lakes/lake1')).toBe(true);
    expect(putCall('/api/data-lakes/batches/batch1')?.[1]).toMatchObject({ status: 'failed' });
    expect(toastMock.success).not.toHaveBeenCalled();
  });
});
