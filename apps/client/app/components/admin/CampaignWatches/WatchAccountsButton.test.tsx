import type { ReactNode } from 'react';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { CssVarsProvider, extendTheme } from '@mui/joy/styles';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { toast } from 'sonner';
import { getThemeConfig } from '@client/app/utils/themes';
import { WatchAccountsButton } from './WatchAccountsButton';

const mocks = vi.hoisted(() => ({ navigate: vi.fn(), create: vi.fn(), admin: true }));
vi.mock('sonner', () => ({ toast: { info: vi.fn() } }));
vi.mock('@tanstack/react-router', () => ({ useNavigate: () => mocks.navigate }));
vi.mock('@client/app/contexts/UserContext', () => ({ useUser: () => ({ currentUser: { isAdmin: mocks.admin } }) }));
vi.mock('@client/app/hooks/data/campaignWatches', () => ({
  useCreateCampaignWatch: () => ({ mutateAsync: mocks.create, isPending: false }),
  watchErrorMessage: (failure: Error) => failure.message,
}));
const theme = extendTheme({ ...getThemeConfig() });
const Wrapper = ({ children }: { children: ReactNode }) => <CssVarsProvider theme={theme}>{children}</CssVarsProvider>;
const first = 'a'.repeat(24);
const second = 'b'.repeat(24);
const watchId = 'c'.repeat(24);
beforeEach(() => {
  vi.clearAllMocks();
  mocks.admin = true;
  mocks.create.mockResolvedValue({ watch: { id: watchId }, created: true });
});

describe('WatchAccountsButton', () => {
  it('freezes the selected cohort while the source refreshes and opens its durable URL after saving', async () => {
    const { rerender } = render(<WatchAccountsButton userIds={[first, first]} />, { wrapper: Wrapper });
    fireEvent.click(screen.getByTestId('watch-accounts-open-btn'));
    rerender(<WatchAccountsButton userIds={[second]} />);
    fireEvent.click(screen.getByTestId('watch-accounts-dialog-reason-input-preset-0'));
    fireEvent.click(screen.getByTestId('watch-accounts-dialog-confirm-btn'));
    await waitFor(() =>
      expect(mocks.create).toHaveBeenCalledWith({
        name: 'Account watch',
        userIds: [first],
        sourceDetectionId: undefined,
        reason: 'Monitor account activity',
      })
    );
    await waitFor(() =>
      expect(mocks.navigate).toHaveBeenCalledWith({
        to: '/admin',
        search: { tab: 'shadow-detections', campaignWatch: watchId },
      })
    );
  });

  it('notifies when the selected accounts already have an open watch and opens it', async () => {
    mocks.create.mockResolvedValue({ watch: { id: watchId }, created: false });
    render(<WatchAccountsButton userIds={[first]} />, { wrapper: Wrapper });
    fireEvent.click(screen.getByTestId('watch-accounts-open-btn'));
    fireEvent.click(screen.getByTestId('watch-accounts-dialog-reason-input-preset-0'));
    fireEvent.click(screen.getByTestId('watch-accounts-dialog-confirm-btn'));
    await waitFor(() =>
      expect(toast.info).toHaveBeenCalledWith('These accounts already have an open watch. Opening it instead.')
    );
    await waitFor(() =>
      expect(mocks.navigate).toHaveBeenCalledWith({
        to: '/admin',
        search: { tab: 'shadow-detections', campaignWatch: watchId },
      })
    );
  });

  it('keeps a failed save visible with its error', async () => {
    mocks.create.mockRejectedValue(new Error('Watch could not be saved'));
    render(<WatchAccountsButton userIds={[first]} />, { wrapper: Wrapper });
    fireEvent.click(screen.getByTestId('watch-accounts-open-btn'));
    fireEvent.click(screen.getByTestId('watch-accounts-dialog-reason-input-preset-0'));
    fireEvent.click(screen.getByTestId('watch-accounts-dialog-confirm-btn'));
    expect(await screen.findByTestId('watch-accounts-error')).toHaveTextContent('Watch could not be saved');
    expect(mocks.navigate).not.toHaveBeenCalled();
  });

  it('blocks truncated groups and hides writes from readers', () => {
    const { rerender } = render(<WatchAccountsButton userIds={[first]} incomplete />, { wrapper: Wrapper });
    expect(screen.getByTestId('watch-accounts-open-btn')).toBeDisabled();
    mocks.admin = false;
    rerender(<WatchAccountsButton userIds={[first]} />);
    expect(screen.queryByTestId('watch-accounts-open-btn')).not.toBeInTheDocument();
  });
});
