import { act, render } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { StudioJobCompletion } from '@bike4mind/common';

const { toastMock } = vi.hoisted(() => ({
  toastMock: { success: vi.fn(), warning: vi.fn(), error: vi.fn() },
}));
vi.mock('sonner', () => ({ toast: toastMock }));
vi.mock('@client/app/router', () => ({ router: { history: { push: vi.fn() } } }));
vi.mock('@client/app/contexts/WebsocketContext', () => ({ useWebsocket: vi.fn() }));
vi.mock('@client/app/components/Studio/useStudioFeature', () => ({
  useStudioFeature: vi.fn(),
  useStudioFeaturesLoading: vi.fn(),
}));

import { useWebsocket } from '@client/app/contexts/WebsocketContext';
import { useStudioFeature, useStudioFeaturesLoading } from '@client/app/components/Studio/useStudioFeature';
import StudioJobCompletedListener, { showStudioCompletionToast } from './StudioJobCompletedListener';

const completion: StudioJobCompletion = {
  version: 1,
  groupId: 'g1',
  medium: 'image',
  totalCount: 4,
  readyCount: 3,
  failedCount: 1,
  cancelledCount: 0,
  title: 'Cold brew launch',
  link: '/studio/image?group=g1',
  completedAt: '2026-11-12T10:00:00.000Z',
};

describe('showStudioCompletionToast', () => {
  beforeEach(() => vi.clearAllMocks());

  it('shows one toast per group with an Open action that follows the event link', () => {
    const open = vi.fn();
    showStudioCompletionToast(completion, open);

    expect(toastMock.warning).toHaveBeenCalledWith('3 of 4 takes ready, Cold brew launch', {
      id: 'studio-completion-g1',
      description: '1 failed',
      duration: 10_000,
      action: { label: 'Open', onClick: expect.any(Function) },
    });
    const [, options] = toastMock.warning.mock.calls[0];
    options.action.onClick();
    expect(open).toHaveBeenCalledWith('/studio/image?group=g1');
  });

  it('picks the toast tone from the outcome', () => {
    showStudioCompletionToast({ ...completion, readyCount: 4, failedCount: 0 }, vi.fn());
    showStudioCompletionToast({ ...completion, readyCount: 0, failedCount: 4 }, vi.fn());
    expect(toastMock.success).toHaveBeenCalledWith('4 takes ready, Cold brew launch', expect.anything());
    expect(toastMock.error).toHaveBeenCalledWith('4 takes failed, Cold brew launch', expect.anything());
  });
});

describe('StudioJobCompletedListener', () => {
  type Handler = (message: { action: string; completion?: StudioJobCompletion }) => Promise<void>;
  let handler: Handler | undefined;
  const unsubscribe = vi.fn();

  const setGate = (gate: { enabled: boolean; loading: boolean }) => {
    vi.mocked(useStudioFeature).mockReturnValue(gate.enabled);
    vi.mocked(useStudioFeaturesLoading).mockReturnValue(gate.loading);
  };
  const frame = (groupId: string) =>
    act(() => handler!({ action: 'studio_job_completed', completion: { ...completion, groupId } }));

  beforeEach(() => {
    vi.clearAllMocks();
    handler = undefined;
    vi.mocked(useWebsocket).mockReturnValue({
      subscribeToAction: vi.fn((action: string, next: Handler) => {
        expect(action).toBe('studio_job_completed');
        handler = next;
        return unsubscribe;
      }),
    } as unknown as ReturnType<typeof useWebsocket>);
  });

  it('toasts a frame once the flag is on', async () => {
    setGate({ enabled: true, loading: false });
    render(<StudioJobCompletedListener />);

    await frame('g1');
    expect(toastMock.warning).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({ id: 'studio-completion-g1' })
    );
  });

  it('shows nothing while the flag is off', async () => {
    setGate({ enabled: false, loading: false });
    render(<StudioJobCompletedListener />);

    await frame('g1');
    expect(toastMock.warning).not.toHaveBeenCalled();
  });

  it('holds a frame that lands while the flag is loading and shows it once the flag resolves on', async () => {
    setGate({ enabled: false, loading: true });
    const { rerender } = render(<StudioJobCompletedListener />);

    await frame('g1');
    expect(toastMock.warning).not.toHaveBeenCalled();

    setGate({ enabled: true, loading: false });
    rerender(<StudioJobCompletedListener />);
    expect(toastMock.warning).toHaveBeenCalledTimes(1);
    expect(toastMock.warning).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({ id: 'studio-completion-g1' })
    );

    rerender(<StudioJobCompletedListener />);
    expect(toastMock.warning).toHaveBeenCalledTimes(1);
  });

  it('drops a held frame when the flag resolves off', async () => {
    setGate({ enabled: false, loading: true });
    const { rerender } = render(<StudioJobCompletedListener />);

    await frame('g1');
    setGate({ enabled: false, loading: false });
    rerender(<StudioJobCompletedListener />);
    setGate({ enabled: true, loading: false });
    rerender(<StudioJobCompletedListener />);

    expect(toastMock.warning).not.toHaveBeenCalled();
  });

  it('unsubscribes on unmount', () => {
    setGate({ enabled: true, loading: false });
    const { unmount } = render(<StudioJobCompletedListener />);
    unmount();
    expect(unsubscribe).toHaveBeenCalledTimes(1);
  });
});
