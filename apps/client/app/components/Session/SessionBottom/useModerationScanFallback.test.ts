import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import type { IFabFileDocument } from '@bike4mind/common';

const { getFabFilesFromServerByIds, toastError } = vi.hoisted(() => ({
  getFabFilesFromServerByIds: vi.fn(),
  toastError: vi.fn(),
}));

vi.mock('@client/app/utils/filesAPICalls', () => ({ getFabFilesFromServerByIds }));
vi.mock('sonner', () => ({ toast: { error: toastError } }));

import useSessionLayout, {
  getSendableMessageFileIds,
  hasBlockingPendingFiles,
  type PendingMessageFile,
} from '@client/app/hooks/useSessionLayout';
import {
  MODERATION_POLL_INTERVAL_MS,
  MODERATION_SCAN_TIMEOUT_MS,
  useModerationScanFallback,
} from './useModerationScanFallback';

const scanningImage = (id: string): PendingMessageFile => ({
  fabFile: { id, fileName: 'photo.png', mimeType: 'image/png' } as IFabFileDocument,
  uploadProgress: 100,
  status: 'scanning',
  scope: 'message',
  uploadSessionId: null,
});

const mountWithStore = (applyResult = vi.fn()) => {
  const hook = renderHook(() =>
    useModerationScanFallback(useSessionLayout(s => s.pendingMessageFiles) ?? [], applyResult)
  );
  return { ...hook, applyResult };
};

const advance = async (ms: number) => {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });
};

describe('useModerationScanFallback', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    getFabFilesFromServerByIds.mockReset();
    toastError.mockReset();
    useSessionLayout.setState({ pendingMessageFiles: [scanningImage('img-1')], pendingModerationEvents: {} });
  });

  afterEach(() => {
    vi.useRealTimers();
    useSessionLayout.setState({ pendingMessageFiles: [] });
  });

  it('hands a server-confirmed clean result to the shared apply path', async () => {
    getFabFilesFromServerByIds.mockResolvedValue([
      { id: 'img-1', moderationStatus: 'clean', fileUrl: 'https://example.test/img-1' },
    ]);
    const { applyResult } = mountWithStore();

    await advance(MODERATION_POLL_INTERVAL_MS);

    expect(getFabFilesFromServerByIds).toHaveBeenCalledWith(['img-1']);
    expect(applyResult).toHaveBeenCalledWith('img-1', 'clean', 'https://example.test/img-1');
  });

  it('keeps polling while the server still reports the scan pending', async () => {
    getFabFilesFromServerByIds.mockResolvedValue([{ id: 'img-1', moderationStatus: 'pending' }]);
    const { applyResult } = mountWithStore();

    await advance(MODERATION_POLL_INTERVAL_MS * 2);

    expect(getFabFilesFromServerByIds).toHaveBeenCalledTimes(2);
    expect(applyResult).not.toHaveBeenCalled();
  });

  it('times out to an error state that releases Send but is never sendable', async () => {
    getFabFilesFromServerByIds.mockResolvedValue([{ id: 'img-1', moderationStatus: 'pending' }]);
    mountWithStore();

    await advance(MODERATION_SCAN_TIMEOUT_MS + MODERATION_POLL_INTERVAL_MS);

    const files = useSessionLayout.getState().pendingMessageFiles;
    expect(files[0].status).toBe('error');
    expect(hasBlockingPendingFiles(files)).toBe(false);
    expect(getSendableMessageFileIds(files).ids).toEqual([]);
    expect(toastError).toHaveBeenCalledTimes(1);
  });

  it('times out even when the status poll itself keeps failing', async () => {
    getFabFilesFromServerByIds.mockRejectedValue(new Error('network down'));
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    mountWithStore();

    await advance(MODERATION_SCAN_TIMEOUT_MS + MODERATION_POLL_INTERVAL_MS);

    expect(useSessionLayout.getState().pendingMessageFiles[0].status).toBe('error');
  });

  it('does not poll when nothing is scanning', async () => {
    useSessionLayout.setState({ pendingMessageFiles: [] });
    mountWithStore();

    await advance(MODERATION_POLL_INTERVAL_MS * 3);

    expect(getFabFilesFromServerByIds).not.toHaveBeenCalled();
  });
});
