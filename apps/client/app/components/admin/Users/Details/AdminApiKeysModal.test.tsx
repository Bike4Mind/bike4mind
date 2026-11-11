import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, act } from '@testing-library/react';
import { CssVarsProvider, extendTheme } from '@mui/joy/styles';
import { getThemeConfig } from '@client/app/utils/themes';
import AdminApiKeysModal from './AdminApiKeysModal';
import { toast } from 'sonner';
import { useUser } from '@client/app/contexts/UserContext';

const h = vi.hoisted(() => ({
  keys: [] as Record<string, unknown>[],
  hookArgs: [] as unknown[],
  liveUsage: {} as Record<string, { minute: number; day: number; minuteResetAt?: number; dayResetAt?: number }>,
  resetMutate: vi.fn(),
  loading: false,
  error: null as Error | null,
  refetch: vi.fn(),
}));

vi.mock('@client/app/hooks/data/userApiKeys', () => ({
  useAdminGetUserApiKeys: (...args: unknown[]) => {
    h.hookArgs = args;
    return {
      data: { apiKeys: h.keys, liveUsage: h.liveUsage },
      isLoading: h.loading,
      error: h.error,
      refetch: h.refetch,
    };
  },
  useAdminResetApiKeyRateLimit: () => ({ mutateAsync: h.resetMutate, isPending: false }),
}));

vi.mock('sonner', () => ({
  toast: { success: vi.fn(), error: vi.fn() },
}));

const appTheme = extendTheme({ ...getThemeConfig() });
const USER = { id: 'u1', username: 'target-user' } as never;

// Pinned clock: the minute window formats in seconds, the day window in hours.
const NOW_MS = new Date('2026-10-21T12:00:00Z').getTime();
const NOW_S = Math.floor(NOW_MS / 1000);

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
  vi.useFakeTimers();
  vi.setSystemTime(NOW_MS);
  h.keys = [];
  h.liveUsage = {};
  h.resetMutate.mockReset();
  h.resetMutate.mockResolvedValue({ success: true, id: 'k1' });
  h.loading = false;
  h.error = null;
  h.refetch.mockClear();
  useUser.setState({ currentUser: { id: 'admin1', isAdmin: true } as never });
  // Without this, a test asserting a bare toast string can pass on a PRIOR test's stale call
  // instead of its own - vi.mock's module-level toast object is shared across every test in
  // this file and is otherwise never reset.
  vi.mocked(toast.success).mockClear();
  vi.mocked(toast.error).mockClear();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('AdminApiKeysModal', () => {
  const confirmReset = async () => {
    fireEvent.click(screen.getByTestId('admin-api-key-reset-rate-limit-btn-k1'));
    fireEvent.click(screen.getByTestId('admin-api-keys-reset-dialog-reason-input-preset-0'));
    await act(async () => fireEvent.click(screen.getByTestId('admin-api-keys-reset-dialog-confirm-btn')));
    expect(h.resetMutate).toHaveBeenCalled();
  };

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

  it('shows the reset time for each open window', () => {
    h.keys = [KEY];
    h.liveUsage = { k1: { minute: 3, day: 42, minuteResetAt: NOW_S + 42, dayResetAt: NOW_S + 3600 } };
    renderModal();

    expect(screen.getByTestId('admin-api-key-usage-minute-k1').textContent).toContain('3/60 per min · resets in 42s');
    expect(screen.getByTestId('admin-api-key-usage-day-k1').textContent).toContain('42/1000 per day · resets in 1h 0m');
  });

  it('polls while open so the minute window does not freeze at fetch time', () => {
    h.keys = [KEY];
    renderModal();

    expect(h.hookArgs[1]).toEqual({ refetchInterval: 15_000 });
  });

  it('gates each reset on its own window', () => {
    // Both resets are future; k1 has only day usage and k2 only minute usage, so swapping
    // the two `> 0` gates fails one line in each direction.
    h.keys = [KEY, { ...KEY, id: 'k2', name: 'busy minute key' }];
    h.liveUsage = {
      k1: { minute: 0, day: 42, minuteResetAt: NOW_S + 42, dayResetAt: NOW_S + 3600 },
      k2: { minute: 3, day: 0, minuteResetAt: NOW_S + 42, dayResetAt: NOW_S + 3600 },
    };
    renderModal();

    expect(screen.getByTestId('admin-api-key-usage-minute-k1').textContent).not.toContain('resets in');
    expect(screen.getByTestId('admin-api-key-usage-day-k1').textContent).toContain('resets in 1h 0m');
    expect(screen.getByTestId('admin-api-key-usage-minute-k2').textContent).toContain('resets in 42s');
    expect(screen.getByTestId('admin-api-key-usage-day-k2').textContent).not.toContain('resets in');
  });

  it('drops a reset whose window already closed, keeping the other line', () => {
    // A snapshot taken while a window was open outlives it: the counter is still
    // non-zero, but the formatter returns ''. Without the truthiness guard the line
    // would end in a bare "resets in ".
    h.keys = [KEY, { ...KEY, id: 'k2', name: 'stale day key' }];
    h.liveUsage = {
      k1: { minute: 3, day: 42, minuteResetAt: NOW_S - 1, dayResetAt: NOW_S + 3600 },
      k2: { minute: 3, day: 42, minuteResetAt: NOW_S + 42, dayResetAt: NOW_S - 1 },
    };
    renderModal();

    expect(screen.getByTestId('admin-api-key-usage-minute-k1').textContent).toContain('3/60 per min');
    expect(screen.getByTestId('admin-api-key-usage-minute-k1').textContent).not.toContain('resets in');
    expect(screen.getByTestId('admin-api-key-usage-day-k1').textContent).toContain('resets in 1h 0m');
    expect(screen.getByTestId('admin-api-key-usage-day-k2').textContent).not.toContain('resets in');
    expect(screen.getByTestId('admin-api-key-usage-minute-k2').textContent).toContain('resets in 42s');
  });

  it('omits the reset time while a window is empty', () => {
    h.keys = [KEY];
    h.liveUsage = {
      k1: { minute: 0, day: 0, minuteResetAt: NOW_S + 42, dayResetAt: NOW_S + 3600 },
    };
    renderModal();

    expect(screen.getByTestId('admin-api-key-usage-minute-k1').textContent).not.toContain('resets in');
    expect(screen.getByTestId('admin-api-key-usage-day-k1').textContent).not.toContain('resets in');
  });

  it('flags an active key whose live counter sits at its limit as rate limited', () => {
    h.keys = [KEY];
    h.liveUsage = { k1: { minute: 60, day: 500 } };
    renderModal();

    expect(screen.getByTestId('admin-api-key-status-k1').textContent).toBe('Rate limited');
  });

  it('requires a reason in the shared dialog and discloses that reset does not store it', async () => {
    h.keys = [KEY];
    renderModal();

    fireEvent.click(screen.getByTestId('admin-api-key-reset-rate-limit-btn-k1'));
    expect(screen.getByTestId('admin-api-keys-reset-dialog-confirm-btn')).toBeDisabled();
    expect(screen.getByTestId('admin-api-keys-reset-dialog')).toHaveTextContent('Not stored yet');
    expect(screen.getByTestId('admin-api-keys-reset-dialog')).toHaveTextContent('cannot be undone');
    fireEvent.click(screen.getByTestId('admin-api-keys-reset-dialog-reason-input-preset-0'));
    await act(async () => fireEvent.click(screen.getByTestId('admin-api-keys-reset-dialog-confirm-btn')));
    expect(h.resetMutate).toHaveBeenCalledTimes(1);
    expect(h.resetMutate).toHaveBeenCalledWith('k1');
    expect(screen.queryByTestId('undo-toast-undo-btn')).toBeNull();
  });

  it('shows a bare success toast when neither counter was at its ceiling', async () => {
    h.keys = [KEY];
    h.resetMutate.mockResolvedValue({
      success: true,
      id: 'k1',
      lockout: {
        request: { minuteAtLimit: false, dayAtLimit: false },
        management: { minuteAtLimit: false, dayAtLimit: false },
      },
    });
    renderModal();

    await confirmReset();

    expect(vi.mocked(toast.success)).toHaveBeenCalledWith('Rate limit reset for "pipeline key"');
  });

  it('names the counter that caused the lockout in the success toast', async () => {
    h.keys = [KEY];
    h.resetMutate.mockResolvedValue({
      success: true,
      id: 'k1',
      lockout: {
        request: { minuteAtLimit: true, dayAtLimit: false },
        management: { minuteAtLimit: false, dayAtLimit: false },
      },
    });
    renderModal();

    await confirmReset();

    expect(vi.mocked(toast.success)).toHaveBeenCalledWith(
      'Rate limit reset for "pipeline key" - request counter was at its ceiling'
    );
  });

  it('names the management counter alone when only it was at its ceiling', async () => {
    h.keys = [KEY];
    h.resetMutate.mockResolvedValue({
      success: true,
      id: 'k1',
      lockout: {
        request: { minuteAtLimit: false, dayAtLimit: false },
        management: { minuteAtLimit: false, dayAtLimit: true },
      },
    });
    renderModal();

    await confirmReset();

    expect(vi.mocked(toast.success)).toHaveBeenCalledWith(
      'Rate limit reset for "pipeline key" - management counter was at its ceiling'
    );
  });

  it('flags a counter that failed to clear as unverified, distinct from one confirmed clear', async () => {
    // An undefined entry means clearing that counter itself failed - it must not read as
    // "confirmed not at its ceiling", which would hide a clear failure behind a clean-looking
    // toast.
    h.keys = [KEY];
    h.resetMutate.mockResolvedValue({
      success: true,
      id: 'k1',
      lockout: { request: undefined, management: { minuteAtLimit: false, dayAtLimit: false } },
    });
    renderModal();

    await confirmReset();

    expect(vi.mocked(toast.success)).toHaveBeenCalledWith(
      'Rate limit reset for "pipeline key" - request counter could not be verified'
    );
  });

  it('shows a bare success toast without throwing when the response has no lockout field (deploy skew)', async () => {
    h.keys = [KEY];
    renderModal();

    await confirmReset();
    expect(vi.mocked(toast.success)).toHaveBeenCalledWith('Rate limit reset for "pipeline key"');
  });

  it('names both counters when both were at their ceiling', async () => {
    h.keys = [KEY];
    h.resetMutate.mockResolvedValue({
      success: true,
      id: 'k1',
      lockout: {
        request: { minuteAtLimit: false, dayAtLimit: true },
        management: { minuteAtLimit: true, dayAtLimit: false },
      },
    });
    renderModal();

    await confirmReset();

    expect(vi.mocked(toast.success)).toHaveBeenCalledWith(
      'Rate limit reset for "pipeline key" - request and management counters were at their ceilings'
    );
  });

  it('does not reset when the confirmation is dismissed', () => {
    h.keys = [KEY];
    renderModal();

    fireEvent.click(screen.getByTestId('admin-api-key-reset-rate-limit-btn-k1'));
    fireEvent.click(screen.getByTestId('admin-api-keys-reset-dialog-cancel-btn'));
    expect(screen.queryByTestId('admin-api-keys-reset-dialog')).toBeNull();
    expect(h.resetMutate).not.toHaveBeenCalled();
  });

  it('keeps a failed reset open for retry', async () => {
    h.keys = [KEY];
    h.resetMutate.mockRejectedValue(new Error('reset failed'));
    renderModal();
    await confirmReset();
    expect(screen.getByTestId('admin-api-keys-reset-dialog')).toBeTruthy();
    expect(toast.success).not.toHaveBeenCalled();
  });

  it('renders skeletons while loading and an actionable error on failure', () => {
    h.keys = [KEY];
    h.loading = true;
    const view = renderModal();
    expect(screen.getAllByTestId('admin-table-skeleton-row').length).toBeGreaterThan(0);
    expect(screen.queryByTestId('admin-api-key-row-k1')).toBeNull();
    h.loading = false;
    h.error = new Error('unavailable');
    view.rerender(
      <CssVarsProvider theme={appTheme}>
        <AdminApiKeysModal open onClose={vi.fn()} user={USER} />
      </CssVarsProvider>
    );
    expect(screen.getByText('Failed to load API keys.')).toBeTruthy();
    expect(screen.queryByTestId('admin-api-key-row-k1')).toBeNull();
    fireEvent.click(screen.getByText('Try again'));
    expect(h.refetch).toHaveBeenCalled();
  });

  it('disables reset without users:moderate or on a protected admin target', () => {
    h.keys = [KEY];
    useUser.setState({ currentUser: { id: 'delegate', isAdmin: false, adminPermissions: ['support:read'] } as never });
    const view = renderModal();
    expect(screen.getByTestId('admin-api-key-reset-rate-limit-btn-k1')).toBeDisabled();
    expect(screen.getByTestId('admin-api-key-reset-rate-limit-btn-k1').parentElement).toHaveAttribute(
      'aria-label',
      'Missing permission: users:moderate'
    );
    view.unmount();
    useUser.setState({
      currentUser: { id: 'delegate', isAdmin: false, adminPermissions: ['users:moderate'] } as never,
    });
    render(
      <CssVarsProvider theme={appTheme}>
        <AdminApiKeysModal open onClose={vi.fn()} user={{ ...USER, isAdmin: true }} />
      </CssVarsProvider>
    );
    expect(screen.getByTestId('admin-api-key-reset-rate-limit-btn-k1')).toBeDisabled();
    expect(h.resetMutate).not.toHaveBeenCalled();
  });

  it('shows the empty state for a user with no keys', () => {
    renderModal();

    expect(screen.getByTestId('admin-empty-state')).toHaveTextContent('This user has no API keys.');
    expect(screen.queryByTestId('admin-api-key-row-k1')).toBeNull();
  });
});
