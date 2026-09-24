import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, act } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { useDataLakeWizardStore } from '@client/app/stores/useDataLakeWizardStore';
import DataLakeUploadIndicator from './DataLakeUploadIndicator';

/**
 * Regression coverage for #3234's follow-up: QA found the browse-tree tag-count refresh never
 * reached a real user, because the cache invalidation lived in a listener (useBatchProgressListener)
 * that unsubscribes the moment Done clears the wizard's currentBatchId - before a still-ingesting
 * batch's completed message can arrive. useDataLakeBatchCompletionSync fixes that by living here
 * instead, in the component that's always mounted regardless of the wizard or its own visibility.
 */

const { subscribeToAction } = vi.hoisted(() => ({
  subscribeToAction: vi.fn(() => () => {}),
}));

vi.mock('@client/app/contexts/WebsocketContext', () => ({
  useWebsocket: () => ({ subscribeToAction }),
}));

const mountIndicator = () => {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const spy = vi.spyOn(queryClient, 'invalidateQueries').mockResolvedValue(undefined);
  const result = render(
    React.createElement(QueryClientProvider, { client: queryClient }, React.createElement(DataLakeUploadIndicator))
  );
  return { ...result, spy };
};

const invalidatedKeys = (spy: ReturnType<typeof vi.spyOn>) =>
  spy.mock.calls.map(([arg]) => JSON.stringify((arg as { queryKey?: unknown })?.queryKey));

describe('DataLakeUploadIndicator - batch-completion cache sync stays live while hidden (#3234)', () => {
  beforeEach(() => {
    subscribeToAction.mockClear();
    // No visible indicator (totalFiles: 0) and no active batch id - mirrors the state right after
    // Done (resetWizard), which is exactly when this sync must still be listening.
    useDataLakeWizardStore.setState({
      isOpen: false,
      uploadProgress: {
        totalFiles: 0,
        uploadedFiles: 0,
        chunkedFiles: 0,
        vectorizedFiles: 0,
        failedFiles: 0,
        failedFileNames: [],
        processingFailedFiles: 0,
        status: 'idle',
        currentBatchId: undefined,
      },
    });
  });

  it('renders nothing when no upload is active or shown', () => {
    const { container } = mountIndicator();
    expect(container).toBeEmptyDOMElement();
  });

  it('subscribes to batch-progress even while rendering nothing', () => {
    mountIndicator();
    expect(subscribeToAction).toHaveBeenCalledWith('data_lake_batch_progress', expect.any(Function));
  });

  it('invalidates the lake list, health, tag-counts, articles, and files roots on batch completion, with no active batch id in the wizard store', () => {
    const { spy } = mountIndicator();
    const [, onMessage] = subscribeToAction.mock.calls.at(-1)!;

    act(() => {
      onMessage({
        action: 'data_lake_batch_progress',
        batchId: 'batch-still-ingesting-in-background',
        status: 'completed',
      });
    });

    expect(invalidatedKeys(spy)).toEqual(
      expect.arrayContaining([
        JSON.stringify(['data-lakes']),
        JSON.stringify(['dataLakeHealth']),
        JSON.stringify(['dataLakeTagCounts']),
        JSON.stringify(['dataLakeArticles']),
        JSON.stringify(['dataLakeFiles']),
      ])
    );
  });

  it('does not invalidate on an ordinary progress tick', () => {
    const { spy } = mountIndicator();
    const [, onMessage] = subscribeToAction.mock.calls.at(-1)!;

    act(() => {
      onMessage({ action: 'data_lake_batch_progress', batchId: 'batch1', chunkedFiles: 1 });
    });

    expect(invalidatedKeys(spy)).toEqual([]);
  });
});
