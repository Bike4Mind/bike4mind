import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { CssVarsProvider, extendTheme } from '@mui/joy/styles';
import { getThemeConfig } from '@client/app/utils/themes';
import AdminApiKeysModal from './AdminApiKeysModal';
import { toast } from 'sonner';

const h = vi.hoisted(() => ({
  keys: [] as Record<string, unknown>[],
  liveUsage: {} as Record<string, { minute: number; day: number }>,
  resetMutate: vi.fn(),
  // Auto-invokes onOk so the confirm-then-mutate flow runs synchronously;
  // individual tests override the implementation to model a dismissal.
  confirmRun: vi.fn((opts: { onOk?: () => void | Promise<void> }) => opts.onOk?.()),
}));

vi.mock('@client/app/hooks/data/userApiKeys', () => ({
  useAdminGetUserApiKeys: () => ({
    data: { apiKeys: h.keys, liveUsage: h.liveUsage },
    isLoading: false,
    error: null,
    refetch: vi.fn(),
  }),
  useAdminResetApiKeyRateLimit: () => ({ mutate: h.resetMutate, isPending: false }),
}));

vi.mock('@client/app/hooks/useConfirmation', () => ({
  useConfirmation: () => h.confirmRun,
}));

vi.mock('sonner', () => ({
  toast: { success: vi.fn(), error: vi.fn() },
}));

const appTheme = extendTheme({ ...getThemeConfig() });
const USER = { id: 'u1', username: 'target-user' } as never;

const renderModal = () =>
  render(
    <CssVarsProvider theme={appTheme}>
      <AdminApiKeysModal open onClose={vi.fn()} user={USER} />
    </CssVarsProvider>
  );

const KEY = {
  id: 'k1',
  name: 'pipeline key',
  keyPrefix: 'b4m_live_abc',
  scopes: ['chat'],
  status: 'active',
  rateLimit: { requestsPerMinute: 60, requestsPerDay: 1000 },
};

beforeEach(() => {
  h.keys = [];
  h.liveUsage = {};
  h.resetMutate.mockReset();
  h.confirmRun.mockClear();
  h.confirmRun.mockImplementation((opts: { onOk?: () => void | Promise<void> }) => opts.onOk?.());
  // Without this, a test asserting a bare toast string can pass on a PRIOR test's stale call
  // instead of its own - vi.mock's module-level toast object is shared across every test in
  // this file and is otherwise never reset.
  vi.mocked(toast.success).mockClear();
  vi.mocked(toast.error).mockClear();
});

describe('AdminApiKeysModal', () => {
  it('renders each key with its live counters', () => {
    h.keys = [KEY, { ...KEY, id: 'k2', name: 'idle key', status: 'disabled' }];
    h.liveUsage = { k1: { minute: 3, day: 42 }, k2: { minute: 0, day: 0 } };
    renderModal();

    expect(screen.getByTestId('admin-api-key-row-k1')).toBeTruthy();
    expect(screen.getByTestId('admin-api-key-row-k2')).toBeTruthy();
    expect(screen.getByTestId('admin-api-key-usage-k1').textContent).toContain('3/60 per min');
    expect(screen.getByTestId('admin-api-key-usage-k1').textContent).toContain('42/1000 per day');
    expect(screen.getByTestId('admin-api-key-status-k1').textContent).toBe('Active');
    expect(screen.getByTestId('admin-api-key-status-k2').textContent).toBe('Disabled');
  });

  it('flags an active key whose live counter sits at its limit as rate limited', () => {
    h.keys = [KEY];
    h.liveUsage = { k1: { minute: 60, day: 500 } };
    renderModal();

    expect(screen.getByTestId('admin-api-key-status-k1').textContent).toBe('Rate limited');
  });

  it('confirms with a danger dialog and resets the right key on OK', () => {
    h.keys = [KEY];
    renderModal();

    fireEvent.click(screen.getByTestId('admin-api-key-reset-rate-limit-btn-k1'));

    expect(h.confirmRun).toHaveBeenCalledWith(expect.objectContaining({ type: 'danger' }));
    expect(h.resetMutate).toHaveBeenCalledTimes(1);
    expect(h.resetMutate.mock.calls[0][0]).toBe('k1');
  });

  it('shows a bare success toast when neither counter was at its ceiling', () => {
    h.keys = [KEY];
    h.resetMutate.mockImplementation((_id: string, opts?: { onSuccess?: (response: unknown) => void }) =>
      opts?.onSuccess?.({
        success: true,
        id: 'k1',
        lockout: {
          request: { minuteAtLimit: false, dayAtLimit: false },
          management: { minuteAtLimit: false, dayAtLimit: false },
        },
      })
    );
    renderModal();

    fireEvent.click(screen.getByTestId('admin-api-key-reset-rate-limit-btn-k1'));

    expect(vi.mocked(toast.success)).toHaveBeenCalledWith('Rate limit reset for "pipeline key"');
  });

  it('names the counter that caused the lockout in the success toast', () => {
    h.keys = [KEY];
    h.resetMutate.mockImplementation((_id: string, opts?: { onSuccess?: (response: unknown) => void }) =>
      opts?.onSuccess?.({
        success: true,
        id: 'k1',
        lockout: {
          request: { minuteAtLimit: true, dayAtLimit: false },
          management: { minuteAtLimit: false, dayAtLimit: false },
        },
      })
    );
    renderModal();

    fireEvent.click(screen.getByTestId('admin-api-key-reset-rate-limit-btn-k1'));

    expect(vi.mocked(toast.success)).toHaveBeenCalledWith(
      'Rate limit reset for "pipeline key" - request counter was at its ceiling'
    );
  });

  it('names the management counter alone when only it was at its ceiling', () => {
    h.keys = [KEY];
    h.resetMutate.mockImplementation((_id: string, opts?: { onSuccess?: (response: unknown) => void }) =>
      opts?.onSuccess?.({
        success: true,
        id: 'k1',
        lockout: {
          request: { minuteAtLimit: false, dayAtLimit: false },
          management: { minuteAtLimit: false, dayAtLimit: true },
        },
      })
    );
    renderModal();

    fireEvent.click(screen.getByTestId('admin-api-key-reset-rate-limit-btn-k1'));

    expect(vi.mocked(toast.success)).toHaveBeenCalledWith(
      'Rate limit reset for "pipeline key" - management counter was at its ceiling'
    );
  });

  it('flags a counter that failed to clear as unverified, distinct from one confirmed clear', () => {
    // An undefined entry means clearing that counter itself failed - it must not read as
    // "confirmed not at its ceiling", which would hide a clear failure behind a clean-looking
    // toast.
    h.keys = [KEY];
    h.resetMutate.mockImplementation((_id: string, opts?: { onSuccess?: (response: unknown) => void }) =>
      opts?.onSuccess?.({
        success: true,
        id: 'k1',
        lockout: { request: undefined, management: { minuteAtLimit: false, dayAtLimit: false } },
      })
    );
    renderModal();

    fireEvent.click(screen.getByTestId('admin-api-key-reset-rate-limit-btn-k1'));

    expect(vi.mocked(toast.success)).toHaveBeenCalledWith(
      'Rate limit reset for "pipeline key" - request counter could not be verified'
    );
  });

  it('shows a bare success toast without throwing when the response has no lockout field (deploy skew)', () => {
    h.keys = [KEY];
    h.resetMutate.mockImplementation((_id: string, opts?: { onSuccess?: (response: unknown) => void }) =>
      opts?.onSuccess?.({ success: true, id: 'k1' })
    );
    renderModal();

    expect(() => fireEvent.click(screen.getByTestId('admin-api-key-reset-rate-limit-btn-k1'))).not.toThrow();
    expect(vi.mocked(toast.success)).toHaveBeenCalledWith('Rate limit reset for "pipeline key"');
  });

  it('names both counters when both were at their ceiling', () => {
    h.keys = [KEY];
    h.resetMutate.mockImplementation((_id: string, opts?: { onSuccess?: (response: unknown) => void }) =>
      opts?.onSuccess?.({
        success: true,
        id: 'k1',
        lockout: {
          request: { minuteAtLimit: false, dayAtLimit: true },
          management: { minuteAtLimit: true, dayAtLimit: false },
        },
      })
    );
    renderModal();

    fireEvent.click(screen.getByTestId('admin-api-key-reset-rate-limit-btn-k1'));

    expect(vi.mocked(toast.success)).toHaveBeenCalledWith(
      'Rate limit reset for "pipeline key" - request and management counters were at their ceilings'
    );
  });

  it('does not reset when the confirmation is dismissed', () => {
    h.keys = [KEY];
    h.confirmRun.mockImplementation(() => undefined);
    renderModal();

    fireEvent.click(screen.getByTestId('admin-api-key-reset-rate-limit-btn-k1'));

    expect(h.confirmRun).toHaveBeenCalled();
    expect(h.resetMutate).not.toHaveBeenCalled();
  });

  it('shows the empty state for a user with no keys', () => {
    renderModal();

    expect(screen.getByTestId('admin-api-keys-empty')).toBeTruthy();
    expect(screen.queryByTestId('admin-api-key-row-k1')).toBeNull();
  });
});
