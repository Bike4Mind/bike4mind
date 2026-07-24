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

  it('total failure (append mode): keeps the user lake, reconciles via upload-complete', async () => {
    uploadMock.mockRejectedValue(new Error('PUT failed'));
    seedWizard({ names: ['a.txt'], targetLake: { id: 'existing', slug: 'existing-slug' } });

    const { result } = mountBatchUpload();
    act(() => result.current.mutate());
    await waitFor(() => expect(result.current.isError).toBe(true));

    // Append mode never creates a lake...
    expect(postCall('/api/data-lakes')).toBeUndefined();
    // ...and never deletes the user's existing lake.
    expect(deleteCalledWith('/api/data-lakes/existing')).toBe(false);
    // Orphan FabFiles + failure accounting + terminalization go through upload-complete
    // (server-side), which deletes the orphans and finalizes the batch.
    expect(postCall('/api/data-lakes/batches/upload-complete')?.[1]).toMatchObject({
      batchId: 'batch1',
      failedFiles: 1,
      failedFileIds: ['id-a.txt'],
    });
  });

  it('partial failure: keeps the lake, hands the failed file to upload-complete', async () => {
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
    // The failed file's orphan FabFile id, its name, and the failure count all go to
    // upload-complete, which deletes the orphan and satisfies completion math server-side
    // (no separate, swallow-prone client delete; no stuck 'processing' batch).
    expect(postCall('/api/data-lakes/batches/upload-complete')?.[1]).toMatchObject({
      batchId: 'batch1',
      failedFiles: 1,
      failedFileNames: ['b.txt'],
      failedFileIds: ['id-b.txt'],
    });
    expect(toastMock.warning).toHaveBeenCalled();
  });

  it('later-chunk presign failure does NOT strand already-uploaded files (multi-chunk)', async () => {
    // Two chunks (BATCH_CHUNK_SIZE = 100): chunk 1 (f0..f99) uploads fine; chunk 2's
    // presign (f100) rejects. This used to throw mid-loop and tear the lake down as a
    // "total failure", stranding the 100 uploaded files - the batch must instead be a
    // partial success with the lake kept.
    const names = Array.from({ length: 101 }, (_, i) => `f${i}.txt`);
    apiPost.mockImplementation((url: string, body?: { files?: { fileName: string }[] }) => {
      if (url === '/api/data-lakes') return Promise.resolve({ data: { id: 'lake1' } });
      if (url === '/api/data-lakes/batches') return Promise.resolve({ data: { id: 'batch1' } });
      if (url === '/api/files/generate-presigned-urls-batch') {
        const files = body?.files ?? [];
        if (files.some(f => f.fileName === 'f100.txt')) return Promise.reject(new Error('presign 500'));
        return Promise.resolve({
          data: {
            files: files.map(f => ({
              fileId: `id-${f.fileName}`,
              fileKey: 'k',
              url: `https://s3/${f.fileName}`,
              fileName: f.fileName,
            })),
          },
        });
      }
      return Promise.resolve({ data: { success: true } });
    });
    seedWizard({ names });

    const { result } = mountBatchUpload();
    act(() => result.current.mutate());
    await waitFor(() => expect(result.current.isSuccess).toBe(true));

    // The lake is kept (100 files landed), not archived as a total failure.
    expect(deleteCalledWith('/api/data-lakes/lake1')).toBe(false);
    // The failed chunk's one file is accounted (no fileId - presign never created it).
    expect(postCall('/api/data-lakes/batches/upload-complete')?.[1]).toMatchObject({
      batchId: 'batch1',
      failedFiles: 1,
    });
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
