import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { StudioJobCompletion } from '@bike4mind/common';

const { toastMock } = vi.hoisted(() => ({
  toastMock: { success: vi.fn(), warning: vi.fn(), error: vi.fn() },
}));
vi.mock('sonner', () => ({ toast: toastMock }));
vi.mock('@client/app/router', () => ({ router: { history: { push: vi.fn() } } }));
vi.mock('@client/app/contexts/WebsocketContext', () => ({ useWebsocket: vi.fn() }));
vi.mock('@client/app/components/Studio/useStudioFeature', () => ({ useStudioFeature: vi.fn() }));

import { showStudioCompletionToast } from './StudioJobCompletedListener';

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
