import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, waitFor, act } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

/**
 * Regression coverage for the batch upload orchestration: the offline fail-fast +
 * retry affordance, error classification (validation vs network vs upload vs server),
 * and the rollback of orphan state (lake / FabFiles / batch) when an upload fails (#816).
 */

const { toastMock, apiPost, apiPut, apiDelete, uploadFileToUrlMock } = vi.hoisted(() => ({
  toastMock: { error: vi.fn(), success: vi.fn(), warning: vi.fn() },
  apiPost: vi.fn(),
  apiPut: vi.fn(() => Promise.resolve({ data: {} })),
  apiDelete: vi.fn(() => Promise.resolve({ data: {} })),
  uploadFileToUrlMock: vi.fn(() => Promise.resolve()),
}));

vi.mock('sonner', () => ({ toast: toastMock }));
vi.mock('@client/app/contexts/ApiContext', () => ({
  api: { post: apiPost, put: apiPut, delete: apiDelete },
}));
// The upload transport (auth-routing self-host vs S3) lives here; mock it so a test
// can make individual file PUTs succeed or fail deterministically.
vi.mock('@client/app/utils/uploadFileToUrl', () => ({ uploadFileToUrl: uploadFileToUrlMock }));
vi.mock('@client/app/contexts/WebsocketContext', () => ({
  useWebsocket: () => ({ subscribeToAction: () => () => {} }),
}));
// Create mode reads the active org and reveals nav slots after the first upload -
// both reached only once a test runs past the offline short-circuit.
vi.mock('@client/app/hooks/data/dataLakes', () => ({ activeOrgId: () => undefined }));
vi.mock('@client/app/hooks/useGearsStatus', () => ({ invalidateGearsStatusWhileLocked: () => {} }));

import { useBatchUpload, useInferTaxonomy } from './dataLakeWizard';
import { useDataLakeWizardStore } from '@client/app/stores/useDataLakeWizardStore';

const mountHook = <T>(hook: () => T) => {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const wrapper: React.FC<{ children: React.ReactNode }> = ({ children }) =>
    React.createElement(QueryClientProvider, { client: queryClient }, children);
  return renderHook(hook, { wrapper });
};

const mountBatchUpload = () => mountHook(useBatchUpload);

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

describe('useBatchUpload onError', () => {
  beforeEach(() => {
    apiPost.mockReset();
    toastMock.error.mockClear();
    toastMock.warning.mockClear();
    apiPut.mockClear();
    apiDelete.mockClear();
    uploadFileToUrlMock.mockReset();
    uploadFileToUrlMock.mockResolvedValue(undefined);
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
    expect(message).toBe('No internet connection. Check your network and try again.');
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
    expect(message).toBe('No internet connection. Check your network and try again.');
    expect(opts.action.label).toBe('Retry');

    // The wizard's uploadProgress reflects the same friendly message, since the
    // wizard can still be showing the Configure step (setStep('upload') never ran).
    expect(useDataLakeWizardStore.getState().uploadProgress.status).toBe('error');
    expect(useDataLakeWizardStore.getState().uploadProgress.errorKind).toBe('network');
    expect(useDataLakeWizardStore.getState().uploadProgress.errorMessage).toBe(message);
  });

  it('translates a 422 into a friendly validation message and never surfaces raw zod text', async () => {
    // The server returns zod-validation-error text on a 422; it must not reach the UI.
    const rawZod = 'Validation error: String must contain at least 2 character(s) at "slug"';
    apiPost.mockRejectedValue({ isAxiosError: true, response: { status: 422, data: { error: rawZod } } });
    seedWizardFile();
    // A name that slugifies to a single char is what actually trips slug.min(2) server-side.
    useDataLakeWizardStore.getState().setConfig({ name: 'A' });

    const { result } = mountBatchUpload();
    act(() => {
      result.current.mutate();
    });

    await waitFor(() => expect(toastMock.error).toHaveBeenCalledTimes(1));

    const progress = useDataLakeWizardStore.getState().uploadProgress;
    expect(progress.status).toBe('error');
    expect(progress.errorKind).toBe('validation');
    expect(progress.errorMessage).toBe(
      'The data lake name is too short. Use a name with at least 2 letters or numbers.'
    );
    expect(progress.errorMessage).not.toContain('zod');
    expect(progress.errorMessage).not.toBe(rawZod);
  });

  it('classifies a 5xx as a server error', async () => {
    apiPost.mockRejectedValue({ isAxiosError: true, response: { status: 500, data: { error: 'boom' } } });
    seedWizardFile();

    const { result } = mountBatchUpload();
    act(() => {
      result.current.mutate();
    });

    await waitFor(() => expect(toastMock.error).toHaveBeenCalledTimes(1));

    const progress = useDataLakeWizardStore.getState().uploadProgress;
    expect(progress.errorKind).toBe('server');
    expect(progress.errorMessage).toBe('The server ran into a problem. Please try again in a moment.');
  });

  it('surfaces the server message for a non-422 4xx instead of axios default text', async () => {
    // The EnableDataLakes feature gate 403s with a curated message; showing
    // "Request failed with status code 403" instead would be a downgrade. Only 422
    // carries validator text, so other 4xx bodies are safe to display.
    apiPost.mockRejectedValue({
      isAxiosError: true,
      message: 'Request failed with status code 403',
      response: { status: 403, data: { error: 'Feature not available', code: 'FEATURE_DISABLED' } },
    });
    seedWizardFile();

    const { result } = mountBatchUpload();
    act(() => {
      result.current.mutate();
    });

    await waitFor(() => expect(toastMock.error).toHaveBeenCalledTimes(1));

    const progress = useDataLakeWizardStore.getState().uploadProgress;
    expect(progress.errorKind).toBe('server');
    expect(progress.errorMessage).toBe('Feature not available');
  });

  it('reports errorKind "upload" when every file fails to PUT', async () => {
    // The lake and batch are created fine; every PUT then fails. #816 rolls the empty
    // lake back and throws, so onError classifies it as a transport ('upload') problem -
    // not a config/validation one - and shows the retry-able upload message.
    apiPost.mockImplementation((url: string) => {
      if (url === '/api/data-lakes') return Promise.resolve({ data: { id: 'lake-1' } });
      if (url === '/api/data-lakes/batches') return Promise.resolve({ data: { id: 'batch-1' } });
      if (url === '/api/files/generate-presigned-urls-batch') {
        return Promise.resolve({
          data: { files: [{ fileId: 'f1', fileKey: 'k1', url: 'https://upload.example/f1', fileName: 'a.txt' }] },
        });
      }
      return Promise.resolve({ data: {} });
    });
    // Every presigned PUT fails (network blocked / CSP), which is the reported case.
    uploadFileToUrlMock.mockRejectedValue(new Error('blocked'));
    seedWizardFile();

    const { result } = mountBatchUpload();
    act(() => {
      result.current.mutate();
    });

    await waitFor(() => expect(useDataLakeWizardStore.getState().uploadProgress.status).toBe('error'));

    const progress = useDataLakeWizardStore.getState().uploadProgress;
    expect(progress.errorKind).toBe('upload');
    expect(progress.failedFiles).toBe(1);
    expect(progress.errorMessage).toBe(
      'None of the files could be uploaded. This is usually a network or connection issue, not your data lake settings. Please try again.'
    );
  });

  it('sends the reviewed taxonomy tags with each file, honoring renames and deletes', async () => {
    // Regression: the Taxonomy step's edits used to be discarded entirely - every file
    // got only a folder slug, so reviewing tags changed nothing about the upload.
    apiPost.mockImplementation((url: string) => {
      if (url === '/api/files/generate-presigned-urls-batch') return Promise.resolve({ data: { files: [] } });
      return Promise.resolve({ data: { id: 'id-1' } });
    });
    seedWizardFile();
    useDataLakeWizardStore.setState({
      allFiles: [
        {
          file: new File(['contents'], 'vendor.pdf', { type: 'application/pdf' }),
          relativePath: 'root/legal/vendor.pdf',
          size: 8,
          type: 'application/pdf',
          excluded: false,
          isDuplicate: false,
        },
      ],
      taxonomy: {
        prefix: 'test:',
        suggestedName: 'Acme',
        attempted: true,
        analyzing: false,
        fileAssignments: [],
        tags: [
          {
            // User edited the suffix to "type:agreement"; originalName stays the inference id.
            suffix: 'type:agreement',
            originalName: 'acme:type:contract',
            strength: 0.95,
            source: 'ai',
            matchingFolders: ['legal'],
            deleted: false,
          },
          {
            suffix: 'topic:hr',
            originalName: 'acme:topic:hr',
            strength: 0.8,
            source: 'ai',
            matchingFolders: ['legal'],
            deleted: true,
          },
        ],
      },
    });

    const { result } = mountBatchUpload();
    act(() => {
      result.current.mutate();
    });

    await waitFor(() =>
      expect(apiPost).toHaveBeenCalledWith('/api/files/generate-presigned-urls-batch', expect.anything())
    );

    const presign = apiPost.mock.calls.find(([url]) => url === '/api/files/generate-presigned-urls-batch');
    const tagNames = (presign?.[1] as { files: { tags: { name: string }[] }[] }).files[0].tags.map(t => t.name).sort();
    // Applied tag = prefix + edited suffix; deleted tag gone; folder tag kept.
    expect(tagNames).toEqual(['test:legal', 'test:type:agreement']);
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

describe('useBatchUpload rollback (#816)', () => {
  beforeEach(() => {
    apiPost.mockReset();
    apiPut.mockReset().mockResolvedValue({ data: { success: true } });
    apiDelete.mockReset().mockResolvedValue({ data: { success: true } });
    uploadFileToUrlMock.mockReset().mockResolvedValue(undefined);
    toastMock.error.mockClear();
    toastMock.success.mockClear();
    toastMock.warning.mockClear();
    installApiPostRouter();
    useDataLakeWizardStore.getState().resetWizard();
  });

  it('total failure (create mode): archives the new lake, marks the batch failed, no success', async () => {
    uploadFileToUrlMock.mockRejectedValue(new Error('PUT failed'));
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
    uploadFileToUrlMock.mockRejectedValue(new Error('PUT failed'));
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
    uploadFileToUrlMock.mockImplementation((url: string) =>
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

  it('batch-creation failure (create mode): setup-phase catch archives the new lake', async () => {
    // Exercises the outer !reconciled catch: the lake was created but creating the batch
    // throws before the outcome branch runs, so the catch (not the outcome branch) rolls
    // the empty lake back. batchId is unset here, so no status PUT fires.
    apiPost.mockImplementation((url: string) => {
      if (url === '/api/data-lakes') return Promise.resolve({ data: { id: 'lake1' } });
      if (url === '/api/data-lakes/batches') return Promise.reject(new Error('batch create 500'));
      return Promise.resolve({ data: { success: true } });
    });
    seedWizard({ names: ['a.txt'] });

    const { result } = mountBatchUpload();
    act(() => result.current.mutate());
    await waitFor(() => expect(result.current.isError).toBe(true));

    expect(deleteCalledWith('/api/data-lakes/lake1')).toBe(true);
    // Never reconciled through the outcome branch, so upload-complete is not called.
    expect(postCall('/api/data-lakes/batches/upload-complete')).toBeUndefined();
    expect(toastMock.success).not.toHaveBeenCalled();
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

/**
 * The infer-taxonomy endpoint validates only suggestedPrefix + categories-is-an-array and
 * otherwise returns the model's raw JSON. Since the taxonomy now feeds the upload path -
 * which runs after the lake record exists - a malformed payload reaching tagsForFile would
 * throw mid-upload and trigger the lake rollback. It has to be sanitized on the way in.
 */
describe('useInferTaxonomy response handling', () => {
  const seedFolderTree = () =>
    useDataLakeWizardStore.setState({
      folderTree: { name: 'root', path: 'root', type: 'folder', children: [], excluded: false },
      allFiles: [
        {
          file: new File(['contents'], 'a.txt', { type: 'text/plain' }),
          relativePath: 'root/legal/a.txt',
          size: 8,
          type: 'text/plain',
          excluded: false,
          isDuplicate: false,
        },
      ],
    });

  beforeEach(() => {
    apiPost.mockReset();
    toastMock.success.mockClear();
    useDataLakeWizardStore.getState().resetWizard();
  });

  it('splits each category into a stable originalName and an editable suffix, dropping malformed ones', async () => {
    apiPost.mockResolvedValue({
      data: {
        suggestedPrefix: 'acme:',
        suggestedName: 'Acme',
        categories: [
          { tagName: 'acme:type:contract', confidence: 0.9, matchingFolders: ['legal'] }, // carries prefix
          { tagName: 'topic:finance', confidence: 0.85, matchingFolders: ['finance'] }, // no prefix -> whole name is suffix
          { confidence: 0.8, matchingFolders: ['finance'] }, // no tagName
          { tagName: '  ', confidence: 0.8 }, // blank tagName
          { tagName: 'acme:', confidence: 0.8 }, // nothing but the prefix -> empty suffix, dropped
        ],
        fileAssignments: { nope: true }, // not an array
      },
    });
    seedFolderTree();

    const { result } = mountHook(useInferTaxonomy);
    act(() => {
      result.current.mutate({});
    });

    await waitFor(() => expect(useDataLakeWizardStore.getState().taxonomy.attempted).toBe(true));

    const { taxonomy } = useDataLakeWizardStore.getState();
    expect(taxonomy.prefix).toBe('acme:');
    // Prefix stripped into suffix; a category without the prefix keeps its whole name as suffix.
    expect(taxonomy.tags.map(t => t.suffix)).toEqual(['type:contract', 'topic:finance']);
    // originalName stays the full inferred name (the per-file-assignment join key).
    expect(taxonomy.tags.map(t => t.originalName)).toEqual(['acme:type:contract', 'topic:finance']);
    expect(taxonomy.fileAssignments).toEqual([]);
    // The toast must reflect what was kept, not what the model claimed to send.
    expect(toastMock.success).toHaveBeenCalledWith('AI suggested 2 tag categories');
  });

  it('keeps the existing prefix when the endpoint returns an empty taxonomy', async () => {
    // No API key configured -> emptyTaxonomy with a blank suggestedPrefix. It must not blank
    // a prefix the user already has, or Config's tagPrefix>=2 gate would strand them.
    apiPost.mockResolvedValue({
      data: { suggestedPrefix: '', suggestedName: '', categories: [], fileAssignments: [] },
    });
    seedFolderTree();
    useDataLakeWizardStore.setState({
      taxonomy: { ...useDataLakeWizardStore.getState().taxonomy, prefix: 'mine:' },
    });

    const { result } = mountHook(useInferTaxonomy);
    act(() => {
      result.current.mutate({});
    });

    await waitFor(() => expect(useDataLakeWizardStore.getState().taxonomy.attempted).toBe(true));

    expect(useDataLakeWizardStore.getState().taxonomy.prefix).toBe('mine:');
    expect(toastMock.success).not.toHaveBeenCalled();
  });
});
