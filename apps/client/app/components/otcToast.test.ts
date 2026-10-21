import { describe, it, expect, vi, beforeEach } from 'vitest';
import { toast } from 'sonner';
import { dismissOtcCodeSentToast, toastOtcCodeSent } from './otcToast';

vi.mock('sonner', () => ({ toast: { success: vi.fn(), dismiss: vi.fn() } }));

describe('otcToast', () => {
  beforeEach(() => vi.clearAllMocks());

  it('dismisses the same toast id it shows', () => {
    toastOtcCodeSent('sent');
    dismissOtcCodeSentToast();
    const shownId = vi.mocked(toast.success).mock.calls[0][1]?.id;
    expect(shownId).toBeTruthy();
    expect(toast.dismiss).toHaveBeenCalledWith(shownId);
  });
});
