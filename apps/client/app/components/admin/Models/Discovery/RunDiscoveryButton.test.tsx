import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { act, fireEvent, render, screen } from '@testing-library/react';
import {
  DELEGATE,
  FULL_ADMIN,
  STATUS,
  apiError,
  makeWrapper,
  newQueryClient,
  runLike,
  statusWith,
} from './__tests__/discoveryTestKit';

const m = vi.hoisted(() => ({
  get: vi.fn(),
  post: vi.fn(),
  currentUser: { id: 'admin-1', isAdmin: true } as Record<string, unknown>,
  nav: { openModel: vi.fn(), openRun: vi.fn(), openSection: vi.fn(), openPrices: vi.fn() },
  toast: Object.assign(vi.fn(), { success: vi.fn(), error: vi.fn() }),
}));

vi.mock('@client/app/contexts/ApiContext', () => ({
  api: { get: (...a: unknown[]) => m.get(...a), post: (...a: unknown[]) => m.post(...a) },
}));
vi.mock('@client/app/contexts/UserContext', () => ({ useUser: () => ({ currentUser: m.currentUser }) }));
vi.mock('../modelsNavigation', () => ({ useModelsNavigation: () => m.nav }));
vi.mock('sonner', () => ({ toast: m.toast }));

import { RunDiscoveryButton } from './RunDiscoveryButton';
import { POLL_INTERVAL_MS, POLL_TIMEOUT_MS, useRunNowStore } from './runDiscoveryNow';

const TEST_ID = 'models-run-discovery-btn';
let queryClient = newQueryClient();

const manualDone = runLike({
  id: 'run-manual',
  startedAt: '2026-07-26T12:10:00.000Z',
  finishedAt: '2026-07-26T12:12:00.000Z',
  trigger: 'manual',
  status: 'ok',
});

const renderButton = () => render(<RunDiscoveryButton data-testid={TEST_ID} />, { wrapper: makeWrapper(queryClient) });

const button = () => screen.getByTestId(TEST_ID);

const tick = async (ms = 0) => {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });
};

type ToastOptions = { action?: { label: string; onClick: () => void } };

beforeEach(() => {
  vi.clearAllMocks();
  vi.useFakeTimers({ shouldAdvanceTime: false });
  queryClient = newQueryClient();
  m.currentUser = FULL_ADMIN;
  useRunNowStore.setState({ phase: 'idle', notice: null, error: null });
  m.get.mockResolvedValue({ data: STATUS });
  m.post.mockResolvedValue({ data: { dispatched: 'lambda' } });
});

afterEach(() => {
  vi.useRealTimers();
});

describe('RunDiscoveryButton', () => {
  it('dispatches, refetches the list when the run reports, and toasts a link to the run', async () => {
    const invalidate = vi.spyOn(queryClient, 'invalidateQueries');
    m.get.mockResolvedValueOnce({ data: STATUS }).mockResolvedValue({ data: statusWith(manualDone) });
    renderButton();

    expect(button()).toHaveTextContent('Run discovery');
    fireEvent.click(button());
    await tick();
    expect(m.post).toHaveBeenCalledWith('/api/admin/model-discovery');
    expect(button()).toBeDisabled();

    await tick(POLL_INTERVAL_MS);
    expect(invalidate).toHaveBeenCalledWith({ queryKey: ['admin', 'models'] });
    expect(m.toast.success).toHaveBeenCalledWith('Discovery run finished: Finished.', expect.any(Object));
    const options = m.toast.success.mock.calls[0][1] as ToastOptions;
    expect(options.action?.label).toBe('View run');
    options.action?.onClick();
    expect(m.nav.openRun).toHaveBeenCalledWith('run-manual');
    expect(button()).not.toBeDisabled();
  });

  it('toasts the off state with a way to settings', async () => {
    m.post.mockRejectedValueOnce(apiError(409, { code: 'discovery-disabled' }));
    renderButton();
    fireEvent.click(button());
    await tick();

    expect(m.toast.error).toHaveBeenCalledWith(
      'Discovery is off. Turn it on to check providers for new models every 6 hours.',
      expect.any(Object)
    );
    const options = m.toast.error.mock.calls[0][1] as ToastOptions;
    expect(options.action?.label).toBe('Open settings');
    options.action?.onClick();
    expect(m.nav.openSection).toHaveBeenCalledWith('settings');
  });

  it('toasts any other refusal with the server reason and no settings link', async () => {
    m.post.mockRejectedValueOnce(apiError(503, { message: 'Model discovery function is not linked.' }));
    renderButton();
    fireEvent.click(button());
    await tick();

    expect(m.toast.error).toHaveBeenCalledWith(
      'Run now is not available here. Model discovery function is not linked.',
      undefined
    );
  });

  it('tells the admin when it stopped waiting', async () => {
    renderButton();
    fireEvent.click(button());
    await tick();
    await tick(POLL_TIMEOUT_MS);

    expect(m.toast).toHaveBeenCalledWith(expect.stringContaining('No new run reported within 2 minutes'));
  });

  it('shares one run with the Discovery section, so a second click anywhere is refused', async () => {
    useRunNowStore.setState({ phase: 'waiting' });
    renderButton();

    expect(button()).toBeDisabled();
    fireEvent.click(button());
    await tick();
    expect(m.post).not.toHaveBeenCalled();
  });

  it('is disabled with the reason for an admin who cannot make model writes', () => {
    m.currentUser = DELEGATE;
    renderButton();

    expect(button()).toBeDisabled();
    expect(screen.getByTestId('models-write-blocked-action')).toContainElement(button());
  });
});
