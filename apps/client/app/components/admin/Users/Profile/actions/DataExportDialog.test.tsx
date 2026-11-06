import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { DataExportDialog } from './DataExportDialog';
import { ProfileTestWrapper, buildProfile } from '../profileTestUtils';

const mocks = vi.hoisted(() => ({
  get: vi.fn(),
  post: vi.fn(),
  toastSuccess: vi.fn(),
  toastError: vi.fn(),
  assign: vi.fn(),
}));

vi.mock('sonner', () => ({ toast: { success: mocks.toastSuccess, error: mocks.toastError, warning: vi.fn() } }));
vi.mock('@client/app/contexts/ApiContext', () => ({ api: { get: mocks.get, post: mocks.post } }));

const READY = {
  exportJobId: 'job-ready',
  requestedAt: '2026-11-06T10:00:00.000Z',
  requestedBy: 'Grace Hopper',
  reason: 'Access request from the user (GDPR Art. 15)',
  status: { state: 'ready', builtAt: '2026-11-06T10:10:00.000Z', expiresAt: '2026-11-07T10:10:00.000Z' },
};
const BUILDING = { ...READY, exportJobId: 'job-building', status: { state: 'building' } };

const setup = () => {
  const user = buildProfile();
  render(<DataExportDialog user={user} onClose={vi.fn()} />, { wrapper: ProfileTestWrapper });
  return { user };
};

describe('DataExportDialog', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    Object.defineProperty(window, 'location', { value: { assign: mocks.assign }, writable: true });
    mocks.get.mockImplementation(async (url: string) =>
      url.endsWith('/data-export')
        ? { data: { exports: [READY, BUILDING] } }
        : { data: { url: 'https://signed.example/export.zip', filename: 'x.zip', expiresAt: '' } }
    );
    mocks.post.mockResolvedValue({ data: { exportJobId: 'new-job' } });
  });

  it('lists recent exports and offers a download only for a ready one', async () => {
    const { user } = setup();

    await waitFor(() => expect(screen.getAllByTestId('data-export-row')).toHaveLength(2));
    expect(mocks.get).toHaveBeenCalledWith(`/api/admin/users/${user.id}/data-export`);
    expect(screen.getAllByTestId('data-export-status-chip').map(chip => chip.textContent)).toEqual([
      'Ready',
      'Building',
    ]);
    expect(screen.getAllByTestId('data-export-download-btn')).toHaveLength(1);
  });

  it('downloads through a freshly signed link', async () => {
    const { user } = setup();
    fireEvent.click(await screen.findByTestId('data-export-download-btn'));

    await waitFor(() => expect(mocks.assign).toHaveBeenCalledWith('https://signed.example/export.zip'));
    expect(mocks.get).toHaveBeenCalledWith(`/api/admin/users/${user.id}/data-export/job-ready`);
  });

  it('requests an export with the chosen reason and keeps the dialog open to show it', async () => {
    const { user } = setup();
    fireEvent.click(screen.getByTestId('data-export-dialog-reason-input-preset-0'));
    fireEvent.click(screen.getByTestId('data-export-dialog-confirm-btn'));

    await waitFor(() =>
      expect(mocks.post).toHaveBeenCalledWith(`/api/admin/users/${user.id}/data-export`, {
        reason: expect.stringContaining('GDPR Art. 15'),
      })
    );
    await waitFor(() => expect(mocks.toastSuccess).toHaveBeenCalled());
    expect(screen.getByTestId('data-export-dialog')).toBeInTheDocument();
  });

  it('shows when nothing was exported recently', async () => {
    mocks.get.mockResolvedValue({ data: { exports: [] } });
    setup();

    expect(await screen.findByText('No exports in the last day.')).toBeInTheDocument();
  });
});
