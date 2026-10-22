import type { ReactNode } from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import {
  DRIVE_EXPORT_CAP_BYTES,
  driveCommitGate,
  driveWorstCaseBytes,
  useDriveFolderEstimate,
  type DriveFolderEstimate,
} from './useDriveFolderEstimate';

const { mockPost } = vi.hoisted(() => ({ mockPost: vi.fn() }));
vi.mock('@client/app/contexts/ApiContext', () => ({ api: { post: mockPost } }));

const ESTIMATE_URL = '/api/google-drive/estimate-folder';

const estimate = (over: Partial<DriveFolderEstimate> = {}): DriveFolderEstimate => ({
  folderId: 'F1',
  fileCount: 3,
  knownBytes: 1000,
  unknownSizeCount: 0,
  overSizeLimitCount: 0,
  unsupportedCount: 0,
  truncated: false,
  overCandidateCap: false,
  maxFileSizeBytes: 100 * 1024 * 1024,
  candidateCap: 20000,
  ...over,
});

const wrapper = () => {
  const client = new QueryClient();
  return function Wrapper({ children }: { children: ReactNode }) {
    return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
  };
};

describe('useDriveFolderEstimate', () => {
  beforeEach(() => mockPost.mockReset());

  it('POSTs the folder id to the estimate route and returns the body', async () => {
    mockPost.mockResolvedValue({ data: estimate() });
    const { result } = renderHook(() => useDriveFolderEstimate('F1'), { wrapper: wrapper() });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(mockPost).toHaveBeenCalledWith(ESTIMATE_URL, { folderId: 'F1' });
    expect(result.current.data).toEqual(estimate());
  });

  it('never calls without a folder id', () => {
    const { result } = renderHook(() => useDriveFolderEstimate(undefined), { wrapper: wrapper() });
    expect(result.current.fetchStatus).toBe('idle');
    expect(mockPost).not.toHaveBeenCalledWith(ESTIMATE_URL, expect.anything());
  });

  it('posts again when a different folder is picked', async () => {
    mockPost.mockResolvedValue({ data: estimate() });
    const { result, rerender } = renderHook(({ id }: { id: string }) => useDriveFolderEstimate(id), {
      wrapper: wrapper(),
      initialProps: { id: 'F1' },
    });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));

    rerender({ id: 'F2' });
    await waitFor(() => expect(mockPost.mock.calls.filter(([url]) => url === ESTIMATE_URL)).toHaveLength(2));
  });

  it('does not re-post the same folder on a remount within staleTime', async () => {
    mockPost.mockResolvedValue({ data: estimate() });
    // One client across both mounts: the second must read the still-fresh cache, not walk Drive again.
    const client = new QueryClient();
    const sharedWrapper = ({ children }: { children: ReactNode }) => (
      <QueryClientProvider client={client}>{children}</QueryClientProvider>
    );

    const first = renderHook(() => useDriveFolderEstimate('F1'), { wrapper: sharedWrapper });
    await waitFor(() => expect(first.result.current.isSuccess).toBe(true));
    first.unmount();

    const second = renderHook(() => useDriveFolderEstimate('F1'), { wrapper: sharedWrapper });
    await waitFor(() => expect(second.result.current.isSuccess).toBe(true));

    expect(mockPost.mock.calls.filter(([url]) => url === ESTIMATE_URL)).toHaveLength(1);
  });

  it('does not retry a failed estimate', async () => {
    // Scoped to the estimate URL: other modules in the import graph fire their own api.post calls.
    mockPost.mockImplementation(async (url: string) => {
      if (url === ESTIMATE_URL) throw new Error('boom');
      return { data: {} };
    });
    const { result } = renderHook(() => useDriveFolderEstimate('F1'), { wrapper: wrapper() });
    await waitFor(() => expect(result.current.isError).toBe(true));
    expect(mockPost.mock.calls.filter(([url]) => url === ESTIMATE_URL)).toHaveLength(1);
  });
});

describe('driveWorstCaseBytes', () => {
  it.each([
    ['no unknown-size files', { unknownSizeCount: 0 }, 1000],
    ['MaxFileSize above the export cap', { unknownSizeCount: 3 }, 1000 + 3 * DRIVE_EXPORT_CAP_BYTES],
    ['MaxFileSize below the export cap', { unknownSizeCount: 3, maxFileSizeBytes: 2_000_000 }, 1000 + 3 * 2_000_000],
  ])('%s', (_label, over, expected) => {
    expect(driveWorstCaseBytes(estimate(over))).toBe(expected);
  });
});

describe('driveCommitGate', () => {
  const quota = { usedBytes: 0, limitBytes: 5000 };

  it('blocks on partial known bytes from a truncated estimate', () => {
    const gate = driveCommitGate(quota, 0, estimate({ knownBytes: 6000, truncated: true }));
    expect(gate).toMatchObject({ exceedsStorage: true, commitBytes: 6000, worstCaseExceeds: false });
  });

  it('never blocks on a pending/failed estimate or a commit carrying no bytes', () => {
    expect(driveCommitGate({ usedBytes: 9000, limitBytes: 5000 }, 0, undefined).exceedsStorage).toBe(false);
    expect(driveCommitGate({ usedBytes: 9000, limitBytes: 5000 }, 0, estimate({ knownBytes: 0 })).exceedsStorage).toBe(
      false
    );
  });

  it('only warns on the worst case, and only for a complete estimate', () => {
    const unknown = { unknownSizeCount: 1 };
    expect(driveCommitGate(quota, 0, estimate(unknown))).toMatchObject({
      exceedsStorage: false,
      worstCaseExceeds: true,
    });
    expect(driveCommitGate(quota, 0, estimate({ ...unknown, truncated: true })).worstCaseExceeds).toBe(false);
  });

  it('carries the candidate cap through', () => {
    expect(driveCommitGate(quota, 0, estimate({ overCandidateCap: true })).overCandidateCap).toBe(true);
  });
});
