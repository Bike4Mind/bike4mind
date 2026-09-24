import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import type { IFabFileDocument } from '@bike4mind/common';

const { getFabFilesFromServerByIds, toastInfo } = vi.hoisted(() => ({
  getFabFilesFromServerByIds: vi.fn(),
  toastInfo: vi.fn(),
}));

vi.mock('@client/app/utils/filesAPICalls', () => ({ getFabFilesFromServerByIds }));
vi.mock('sonner', () => ({ toast: { info: toastInfo } }));

import useSessionLayout, {
  getSendableMessageFileIds,
  hasBlockingPendingFiles,
  recordModerationStatus,
  type PendingMessageFile,
} from '@client/app/hooks/useSessionLayout';
import {
  MODERATION_POLL_INTERVAL_MS,
  MODERATION_SCAN_TIMEOUT_MS,
  MODERATION_SLOW_POLL_INTERVAL_MS,
  MODERATION_SLOW_POLL_WINDOW_MS,
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
    toastInfo.mockReset();
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
    expect(toastInfo).toHaveBeenCalledTimes(1);
    expect(toastInfo.mock.calls[0][0]).toMatch(/still checking/i);
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

  it('keeps re-checking a timed-out image slowly and completes it on a late clean result', async () => {
    getFabFilesFromServerByIds.mockResolvedValue([{ id: 'img-1', moderationStatus: 'pending' }]);
    // Mirrors SessionBottom's apply path: a clean result flips the item via recordModerationStatus.
    mountWithStore(
      vi.fn((id: string, status: 'clean' | 'blocked', url?: string) => recordModerationStatus(id, status, url))
    );

    await advance(MODERATION_SCAN_TIMEOUT_MS + MODERATION_POLL_INTERVAL_MS);
    expect(useSessionLayout.getState().pendingMessageFiles[0].status).toBe('error');

    getFabFilesFromServerByIds.mockResolvedValue([
      { id: 'img-1', moderationStatus: 'clean', fileUrl: 'https://x.test/1' },
    ]);
    await advance(MODERATION_SLOW_POLL_INTERVAL_MS);

    const files = useSessionLayout.getState().pendingMessageFiles;
    expect(files[0].status).toBe('complete');
    expect(getSendableMessageFileIds(files).ids).toEqual(['img-1']);
  });

  it('stays non-sendable while the slow re-check keeps reporting pending, and stops after the window', async () => {
    getFabFilesFromServerByIds.mockResolvedValue([{ id: 'img-1', moderationStatus: 'pending' }]);
    mountWithStore();

    await advance(MODERATION_SCAN_TIMEOUT_MS + MODERATION_POLL_INTERVAL_MS);
    await advance(MODERATION_SLOW_POLL_WINDOW_MS + MODERATION_SLOW_POLL_INTERVAL_MS);
    const files = useSessionLayout.getState().pendingMessageFiles;
    expect(files[0].status).toBe('error');
    expect(getSendableMessageFileIds(files).ids).toEqual([]);

    const callsAtWindowEnd = getFabFilesFromServerByIds.mock.calls.length;
    await advance(MODERATION_SLOW_POLL_INTERVAL_MS * 3);
    expect(getFabFilesFromServerByIds.mock.calls.length).toBe(callsAtWindowEnd);
  });

  it('does not slow-poll a file that errored for another reason (failed upload)', async () => {
    useSessionLayout.setState({ pendingMessageFiles: [{ ...scanningImage('img-9'), status: 'error' }] });
    mountWithStore();

    await advance(MODERATION_SLOW_POLL_INTERVAL_MS * 2);

    expect(getFabFilesFromServerByIds).not.toHaveBeenCalled();
  });
});
