import { render, screen } from '@testing-library/react';
import { ServerStatusEnum } from '@bike4mind/common';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ServerStatusProvider } from './ServerStatusProvider';

const state = vi.hoisted(() => ({ serverStatus: 'live' as string | undefined, isAdmin: false }));

vi.mock('../hooks/data/settings', () => ({
  useServerStatus: () => ({ data: { serverStatus: state.serverStatus } }),
}));
vi.mock('@client/app/contexts/UserContext', () => ({
  useUser: (selector: (s: { isAdmin?: boolean }) => unknown) => selector({ isAdmin: state.isAdmin }),
}));
vi.mock('@client/app/components/b4m/ComingSoon', () => ({
  default: () => <div data-testid="coming-soon-page" />,
}));
vi.mock('@client/app/components/common/MaintenanceComingSoonPage', () => ({
  default: ({ serverStatus, customComingSoonContent }: { serverStatus?: string; customComingSoonContent: unknown }) =>
    serverStatus === 'maintenance' ? <div data-testid="maintenance-page" /> : customComingSoonContent,
}));

const renderProvider = () =>
  render(
    <ServerStatusProvider>
      <div data-testid="app" />
    </ServerStatusProvider>
  );

describe('ServerStatusProvider', () => {
  beforeEach(() => {
    state.serverStatus = ServerStatusEnum.Live;
    state.isAdmin = false;
    window.history.replaceState(null, '', '/');
  });

  it.each([
    [ServerStatusEnum.Live, 'app'],
    [undefined, 'app'],
    [ServerStatusEnum.Maintenance, 'maintenance-page'],
    [ServerStatusEnum.Offline, 'coming-soon-page'],
  ])('shows a non-admin the right screen for status %s', (status, testId) => {
    state.serverStatus = status;
    renderProvider();
    expect(screen.getByTestId(testId)).toBeInTheDocument();
  });

  it.each([ServerStatusEnum.Maintenance, ServerStatusEnum.Offline])('lets an admin into the app on %s', status => {
    state.serverStatus = status;
    state.isAdmin = true;
    renderProvider();
    expect(screen.getByTestId('app')).toBeInTheDocument();
  });

  it('keeps the emergency admin route open while offline', () => {
    state.serverStatus = ServerStatusEnum.Offline;
    window.history.replaceState(null, '', '/admin-emergency');
    renderProvider();
    expect(screen.getByTestId('app')).toBeInTheDocument();
  });
});
