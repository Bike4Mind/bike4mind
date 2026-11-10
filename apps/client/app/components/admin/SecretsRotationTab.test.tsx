import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import dayjs from 'dayjs';
import { CssVarsProvider, extendTheme } from '@mui/joy/styles';
import { getThemeConfig } from '@client/app/utils/themes';
import type { SafeSecretRotation } from '@client/lib/secretRotation/utils';

const mocks = vi.hoisted(() => ({ get: vi.fn(), put: vi.fn(), post: vi.fn(), error: vi.fn() }));

vi.mock('@client/app/contexts/ApiContext', () => ({ api: { get: mocks.get, put: mocks.put, post: mocks.post } }));
vi.mock('@client/app/components/help/ContextHelpButton', () => ({ default: () => null }));
vi.mock('sonner', () => ({ toast: { error: mocks.error } }));

import SecretsRotationTab from './SecretsRotationTab';

const appTheme = extendTheme({ ...getThemeConfig() });
const DAY = 24 * 60 * 60 * 1000;
const LONG_KEY = 'SECOPS_ATTACK_SIMULATION_INGEST_TOKEN_WITH_A_LONG_SUFFIX';

const rotation = (overrides: Partial<SafeSecretRotation>): SafeSecretRotation => ({
  id: 'rot-1',
  keyName: 'JWT_SECRET',
  rotatedAt: new Date(Date.now() - 5 * DAY),
  nextRotation: new Date(Date.now() + 25 * DAY),
  rotationIntervalDays: 30,
  lastRotatedByName: 'Admin One',
  description: 'Signs session tokens',
  isActive: true,
  ...overrides,
});

const onSchedule = rotation({});
const overdue = rotation({
  id: 'rot-2',
  keyName: LONG_KEY,
  nextRotation: new Date(Date.now() - 2 * DAY),
  rotationIntervalDays: 90,
  description: 'Ingest token for attack simulation results',
});
const inactive = rotation({ id: 'rot-3', keyName: 'OLD_KEY', isActive: false, description: undefined });

const renderTab = () => {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  return render(
    <QueryClientProvider client={queryClient}>
      <CssVarsProvider theme={appTheme}>
        <SecretsRotationTab />
      </CssVarsProvider>
    </QueryClientProvider>
  );
};

const openRowMenu = (id: string) => fireEvent.click(screen.getByTestId(`secrets-rotation-row-actions-${id}`));

describe('SecretsRotationTab', () => {
  beforeEach(() => {
    Object.values(mocks).forEach(mock => mock.mockReset());
    mocks.get.mockResolvedValue({ data: [onSchedule, overdue, inactive] });
    mocks.put.mockResolvedValue({ data: {} });
    mocks.post.mockResolvedValue({ data: {} });
  });

  it('opens with the page header: a sentence-case h1 with a count and no icon', async () => {
    renderTab();

    const header = await screen.findByTestId('admin-page-header');
    expect(screen.getByTestId('admin-secrets-rotation-tab').firstElementChild).toBe(header);
    const title = within(header).getByRole('heading', { level: 1 });
    expect(title).toHaveTextContent('Secrets rotation');
    await waitFor(() => expect(title).toHaveTextContent('Secrets rotation (3)'));
    expect(within(header).queryByTestId('SecurityIcon')).toBeNull();
    expect(screen.getAllByRole('heading', { level: 1 })).toHaveLength(1);
  });

  it('labels each status in one tone: active good, overdue warn, inactive neutral', async () => {
    renderTab();

    const active = await screen.findByTestId('secrets-rotation-status-rot-1');
    expect(active).toHaveTextContent('Active');
    expect(active).toHaveAttribute('data-tone', 'good');
    expect(screen.getByTestId('secrets-rotation-status-rot-2')).toHaveTextContent('Overdue');
    expect(screen.getByTestId('secrets-rotation-status-rot-2')).toHaveAttribute('data-tone', 'warn');
    expect(screen.getByTestId('secrets-rotation-status-rot-3')).toHaveTextContent('Inactive');
    expect(screen.getByTestId('secrets-rotation-status-rot-3')).toHaveAttribute('data-tone', 'neutral');
  });

  it('keeps the key name on one line and truncates it instead of breaking it', async () => {
    renderTab();

    const key = await screen.findByTestId('secrets-rotation-key-rot-2');
    expect(key).toHaveTextContent(LONG_KEY);
    expect(key).toHaveStyle({ whiteSpace: 'nowrap', textOverflow: 'ellipsis', overflow: 'hidden' });
    const cell = key.closest('td') as HTMLElement;
    expect(getComputedStyle(cell).wordBreak).not.toBe('break-all');
    expect(getComputedStyle(key).overflowWrap).not.toBe('anywhere');
    expect(getComputedStyle(cell).overflowWrap).not.toBe('anywhere');

    fireEvent.mouseOver(key);
    expect(await screen.findByRole('tooltip')).toHaveTextContent(LONG_KEY);
  });

  it('keeps the absolute date in the cell and puts the relative time in its tooltip', async () => {
    renderTab();

    const date = await screen.findByTestId('secrets-rotation-rotated-at-rot-1');
    const absolute = dayjs(onSchedule.rotatedAt).format('MMM D, YYYY');
    expect(date).toHaveTextContent(absolute);
    expect(date).not.toHaveAttribute('aria-label');

    fireEvent.mouseOver(date);
    const tooltip = await screen.findByRole('tooltip');
    expect(tooltip).toHaveTextContent('5 days ago');
    expect(date).toHaveTextContent(absolute);
    expect(date).not.toHaveAttribute('aria-label');
    expect(screen.getByTestId('secrets-rotation-next-rotation-rot-1')).toHaveTextContent(
      dayjs(onSchedule.nextRotation).format('MMM D, YYYY')
    );
  });

  it('scrolls the table inside its own frame below 64rem', async () => {
    renderTab();

    const table = await screen.findByTestId('secrets-rotation-table');
    expect(table).toHaveStyle({ minWidth: '64rem' });
    expect(screen.getByTestId('secrets-rotation-table-frame')).toBeInTheDocument();
  });

  it('moves Renew and Edit off the row into its "..." menu', async () => {
    renderTab();

    const row = await screen.findByTestId('secrets-rotation-row-rot-1');
    expect(within(row).queryByRole('button', { name: /renew/i })).toBeNull();
    expect(within(row).queryByRole('button', { name: /^edit$/i })).toBeNull();
    expect(within(row).getByRole('button', { name: 'Actions for JWT_SECRET' })).toBeInTheDocument();

    openRowMenu('rot-1');
    expect(await screen.findByTestId('secrets-rotation-row-renew-rot-1')).toHaveTextContent('Mark renewed');
    expect(screen.getByTestId('secrets-rotation-row-edit-rot-1')).toHaveTextContent('Edit rotation');
  });

  it('marks a secret renewed through a confirm dialog that names it, with the same payload', async () => {
    renderTab();
    await screen.findByTestId('secrets-rotation-row-rot-2');

    openRowMenu('rot-2');
    fireEvent.click(await screen.findByTestId('secrets-rotation-row-renew-rot-2'));

    const dialog = await screen.findByTestId('secrets-rotation-renew-dialog');
    expect(within(dialog).getByRole('heading', { level: 2 })).toHaveTextContent('Mark secret as renewed');
    expect(dialog).toHaveTextContent(LONG_KEY);
    expect(dialog).toHaveTextContent('next rotation in 90 days');

    fireEvent.click(within(dialog).getByTestId('secrets-rotation-renew-confirm-btn'));

    await waitFor(() => expect(mocks.post).toHaveBeenCalledWith('/api/secret-rotations/renewed', { id: 'rot-2' }));
    await waitFor(() => expect(screen.queryByTestId('secrets-rotation-renew-dialog')).toBeNull());
    await waitFor(() => expect(mocks.get).toHaveBeenCalledTimes(2));
  });

  it('edits a rotation in a dialog prefilled from the row, with the same payload', async () => {
    renderTab();
    await screen.findByTestId('secrets-rotation-row-rot-2');

    openRowMenu('rot-2');
    fireEvent.click(await screen.findByTestId('secrets-rotation-row-edit-rot-2'));

    const dialog = await screen.findByTestId('secrets-rotation-edit-dialog');
    expect(within(dialog).getByRole('heading', { level: 2 })).toHaveTextContent('Edit rotation');
    expect(dialog).toHaveTextContent(LONG_KEY);
    const description = within(dialog).getByTestId('secrets-rotation-edit-description-input');
    const interval = within(dialog).getByTestId('secrets-rotation-edit-interval-input');
    expect(description).toHaveValue('Ingest token for attack simulation results');
    expect(interval).toHaveValue(90);

    fireEvent.change(description, { target: { value: 'Rotated by the security team' } });
    fireEvent.change(interval, { target: { value: '45' } });
    fireEvent.click(within(dialog).getByTestId('secrets-rotation-edit-save-btn'));

    await waitFor(() =>
      expect(mocks.put).toHaveBeenCalledWith('/api/secret-rotations/rot-2', {
        id: 'rot-2',
        rotationIntervalDays: 45,
        description: 'Rotated by the security team',
      })
    );
    await waitFor(() => expect(screen.queryByTestId('secrets-rotation-edit-dialog')).toBeNull());
  });

  it.each(['edit', 'renew'] as const)('keeps the %s dialog attached to its pending request', async action => {
    const request = Promise.withResolvers<{ data: Record<string, never> }>();
    const mutation = action === 'edit' ? mocks.put : mocks.post;
    mutation.mockReturnValueOnce(request.promise);
    renderTab();
    await screen.findByTestId('secrets-rotation-row-rot-2');
    openRowMenu('rot-2');
    fireEvent.click(await screen.findByTestId(`secrets-rotation-row-${action}-rot-2`));

    const dialogId = `secrets-rotation-${action}-dialog`;
    const dialog = await screen.findByTestId(dialogId);
    const submitId = action === 'edit' ? 'secrets-rotation-edit-save-btn' : 'secrets-rotation-renew-confirm-btn';
    fireEvent.click(within(dialog).getByTestId(submitId));
    const cancel = within(dialog).getByTestId(`secrets-rotation-${action}-cancel-btn`);
    await waitFor(() => expect(cancel).toBeDisabled());

    fireEvent.click(cancel);
    expect(dialog).toBeInTheDocument();
    fireEvent.click(within(dialog).getByTestId(`${dialogId}-close-btn`));
    expect(dialog).toBeInTheDocument();
    fireEvent.keyDown(dialog, { key: 'Escape' });
    expect(dialog).toBeInTheDocument();
    expect(dialog).toHaveTextContent(LONG_KEY);
    expect(mutation).toHaveBeenCalledTimes(1);

    await act(async () => request.resolve({ data: {} }));
    await waitFor(() => expect(screen.queryByTestId(dialogId)).toBeNull());
  });

  it('shows a renewal refusal and keeps the dialog open for a retry', async () => {
    const message = 'The signing secret has not changed since its last capture';
    mocks.post.mockRejectedValueOnce(
      Object.assign(new Error('Request failed'), { isAxiosError: true, response: { data: { error: message } } })
    );
    renderTab();
    await screen.findByTestId('secrets-rotation-row-rot-1');
    openRowMenu('rot-1');
    fireEvent.click(await screen.findByTestId('secrets-rotation-row-renew-rot-1'));

    const dialog = await screen.findByTestId('secrets-rotation-renew-dialog');
    fireEvent.click(within(dialog).getByTestId('secrets-rotation-renew-confirm-btn'));

    await waitFor(() => expect(mocks.error).toHaveBeenCalledWith(message));
    expect(dialog).toBeInTheDocument();
    expect(mocks.get).toHaveBeenCalledTimes(1);

    fireEvent.click(within(dialog).getByTestId('secrets-rotation-renew-confirm-btn'));
    await waitFor(() => expect(screen.queryByTestId('secrets-rotation-renew-dialog')).toBeNull());
  });

  it('shows an edit failure and preserves the entered values for a retry', async () => {
    mocks.put.mockRejectedValueOnce(new Error('Network Error'));
    renderTab();
    await screen.findByTestId('secrets-rotation-row-rot-2');
    openRowMenu('rot-2');
    fireEvent.click(await screen.findByTestId('secrets-rotation-row-edit-rot-2'));

    const dialog = await screen.findByTestId('secrets-rotation-edit-dialog');
    const interval = within(dialog).getByTestId('secrets-rotation-edit-interval-input');
    fireEvent.change(interval, { target: { value: '45' } });
    fireEvent.click(within(dialog).getByTestId('secrets-rotation-edit-save-btn'));

    await waitFor(() => expect(mocks.error).toHaveBeenCalledWith('Network Error'));
    expect(dialog).toBeInTheDocument();
    expect(interval).toHaveValue(45);
    expect(mocks.get).toHaveBeenCalledTimes(1);

    fireEvent.click(within(dialog).getByTestId('secrets-rotation-edit-save-btn'));
    await waitFor(() => expect(screen.queryByTestId('secrets-rotation-edit-dialog')).toBeNull());
  });

  it.each(['', '0', '-1', '366', '1.5'])('does not submit an invalid rotation interval: %j', async value => {
    renderTab();
    await screen.findByTestId('secrets-rotation-row-rot-2');
    openRowMenu('rot-2');
    fireEvent.click(await screen.findByTestId('secrets-rotation-row-edit-rot-2'));

    const dialog = await screen.findByTestId('secrets-rotation-edit-dialog');
    fireEvent.change(within(dialog).getByTestId('secrets-rotation-edit-interval-input'), { target: { value } });
    const save = within(dialog).getByTestId('secrets-rotation-edit-save-btn');
    expect(save).toBeDisabled();
    fireEvent.click(save);
    expect(mocks.put).not.toHaveBeenCalled();
    expect(dialog).toBeInTheDocument();
  });

  it.each([1, 365])('accepts the rotation interval boundary: %i', async rotationIntervalDays => {
    renderTab();
    await screen.findByTestId('secrets-rotation-row-rot-2');
    openRowMenu('rot-2');
    fireEvent.click(await screen.findByTestId('secrets-rotation-row-edit-rot-2'));

    const dialog = await screen.findByTestId('secrets-rotation-edit-dialog');
    fireEvent.change(within(dialog).getByTestId('secrets-rotation-edit-interval-input'), {
      target: { value: String(rotationIntervalDays) },
    });
    fireEvent.click(within(dialog).getByTestId('secrets-rotation-edit-save-btn'));

    await waitFor(() =>
      expect(mocks.put).toHaveBeenCalledWith('/api/secret-rotations/rot-2', {
        id: 'rot-2',
        rotationIntervalDays,
        description: 'Ingest token for attack simulation results',
      })
    );
  });

  it('shows skeleton rows under the header while the first load runs', async () => {
    mocks.get.mockReturnValue(new Promise(() => {}));
    renderTab();

    expect(await screen.findByTestId('admin-page-header')).toBeInTheDocument();
    expect(screen.getAllByTestId('admin-table-skeleton-row').length).toBeGreaterThan(0);
  });

  it('keeps the rows on screen with the updating bar while a refresh runs', async () => {
    renderTab();
    await screen.findByTestId('secrets-rotation-row-rot-1');
    expect(screen.queryByTestId('secrets-rotation-updating-bar')).toBeNull();

    mocks.get.mockReturnValueOnce(new Promise(() => {}));
    fireEvent.click(screen.getByTestId('secrets-rotation-refresh-btn'));

    expect(await screen.findByTestId('secrets-rotation-updating-bar')).toBeInTheDocument();
    expect(screen.getByTestId('secrets-rotation-row-rot-1')).toBeInTheDocument();
    expect(screen.queryAllByTestId('admin-table-skeleton-row')).toHaveLength(0);
  });

  it('shows an empty state with a refresh action when nothing is tracked', async () => {
    mocks.get.mockResolvedValue({ data: [] });
    renderTab();

    const empty = await screen.findByTestId('admin-empty-state');
    expect(empty).toHaveTextContent('No secrets are tracked for rotation');
    fireEvent.click(within(empty).getByTestId('secrets-rotation-empty-refresh-btn'));
    await waitFor(() => expect(mocks.get).toHaveBeenCalledTimes(2));
  });

  it('shows an error state with a retry when the load fails', async () => {
    mocks.get.mockRejectedValueOnce(new Error('boom'));
    renderTab();

    const error = await screen.findByTestId('admin-error-state');
    expect(error).toHaveTextContent('Could not load the rotation schedules.');
    expect(screen.getByTestId('admin-page-header')).toBeInTheDocument();

    fireEvent.click(within(error).getByTestId('admin-error-retry-btn'));
    expect(await screen.findByTestId('secrets-rotation-row-rot-1')).toBeInTheDocument();
  });
});
