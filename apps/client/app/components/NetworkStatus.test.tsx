import type { ReactNode } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import { CssVarsProvider, extendTheme } from '@mui/joy/styles';
import { ReadyState } from 'react-use-websocket';
import { getThemeConfig } from '@client/app/utils/themes';
import NetworkStatus from './NetworkStatus';

const socket = vi.hoisted(() => ({ readyState: 0, activeSubscriptions: new Set<string>(), clientId: null }));
vi.mock('@/app/contexts/WebsocketContext', async () => ({
  ReadyState: (await import('react-use-websocket')).ReadyState,
  useWebsocket: () => socket,
}));
vi.mock('@client/app/contexts/UserContext', () => ({ useUser: () => false }));
vi.mock('@tanstack/react-query', () => ({ useQuery: () => ({ data: undefined, isLoading: true }) }));
vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));

const appTheme = extendTheme({ ...getThemeConfig() });
const TestWrapper = ({ children }: { children: ReactNode }) => (
  <CssVarsProvider theme={appTheme}>{children}</CssVarsProvider>
);

const renderStatus = (readyState: ReadyState) => {
  socket.readyState = readyState;
  return render(<NetworkStatus />, { wrapper: TestWrapper });
};

describe('NetworkStatus', () => {
  it('spins inside the status button while the socket connects', () => {
    renderStatus(ReadyState.CONNECTING);

    const button = screen.getByTestId('network-status-btn');
    expect(within(button).getByTestId('network-status-connecting')).toBeInTheDocument();
  });

  it.each([
    [ReadyState.UNINSTANTIATED, 'PendingIcon'],
    [ReadyState.OPEN, 'CloudDoneIcon'],
    [ReadyState.CLOSING, 'CloudDownloadIcon'],
    [ReadyState.CLOSED, 'CloudOffIcon'],
  ])('shows an icon and no spinner in ready state %s', (readyState, icon) => {
    renderStatus(readyState);

    const button = screen.getByTestId('network-status-btn');
    expect(within(button).getByTestId(icon)).toBeInTheDocument();
    expect(screen.queryByTestId('network-status-connecting')).not.toBeInTheDocument();
  });
});
