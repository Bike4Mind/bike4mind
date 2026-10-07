import type { ReactNode } from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { CssVarsProvider, extendTheme } from '@mui/joy/styles';
import { getThemeConfig } from '@client/app/utils/themes';

const isAdminFeatureEnabled = vi.fn();
vi.mock('@client/app/hooks/useFeatureEnabled', () => ({
  useFeatureEnabled: () => ({ isAdminFeatureEnabled, isFeatureEnabled: vi.fn(), isLoading: false }),
}));
vi.mock('@client/app/components/DataLakeWizard/steps/DriveConnectAction', () => ({ default: () => null }));
vi.mock('@client/app/components/DataLakeWizard/steps/GitHubConnectAction', () => ({ default: () => null }));

import ConnectSourceMenu from './ConnectSourceMenu';
import { LAKE_MANAGER_ONLY_REASON } from './lakeSources';

const appTheme = extendTheme({ ...getThemeConfig() });
const wrap = (ui: ReactNode) => render(<CssVarsProvider theme={appTheme}>{ui}</CssVarsProvider>);

const openMenu = () => fireEvent.click(screen.getByTestId('datalake-connect-source-btn'));

describe('ConnectSourceMenu', () => {
  beforeEach(() => {
    isAdminFeatureEnabled.mockReset();
    isAdminFeatureEnabled.mockImplementation((key: string) => key === 'EnableDataLakeGitHub');
  });

  it('lists Google Drive as a connectable source on an org lake', () => {
    const onConnect = vi.fn();
    wrap(
      <ConnectSourceMenu lake={{ organizationId: 'org-1', canManage: true, isCreator: false }} onConnect={onConnect} />
    );
    openMenu();

    const item = screen.getByTestId('datalake-connect-source-drive-item');
    expect(item).not.toHaveAttribute('aria-disabled', 'true');
    fireEvent.click(item);
    expect(onConnect).toHaveBeenCalledWith('googleDrive');
  });

  it('enables Google Drive on a personal lake the caller created', () => {
    const onConnect = vi.fn();
    wrap(<ConnectSourceMenu lake={{ organizationId: null, canManage: true, isCreator: true }} onConnect={onConnect} />);
    openMenu();

    const item = screen.getByTestId('datalake-connect-source-drive-item');
    expect(item).not.toHaveAttribute('aria-disabled', 'true');
    fireEvent.click(item);
    expect(onConnect).toHaveBeenCalledWith('googleDrive');
  });

  it("keeps Google Drive listed but disabled on someone else's personal lake, with the reason inline", () => {
    const onConnect = vi.fn();
    wrap(
      <ConnectSourceMenu lake={{ organizationId: null, canManage: false, isCreator: false }} onConnect={onConnect} />
    );
    openMenu();

    const item = screen.getByTestId('datalake-connect-source-drive-item');
    expect(item).toHaveAttribute('aria-disabled', 'true');
    expect(screen.getByTestId('datalake-connect-source-drive-hint')).toHaveTextContent(/Only the person who created/);
    fireEvent.click(item);
    expect(onConnect).not.toHaveBeenCalled();
  });

  it('lists GitHub as a connectable source on an org lake', () => {
    const onConnect = vi.fn();
    wrap(
      <ConnectSourceMenu lake={{ organizationId: 'org-1', canManage: true, isCreator: false }} onConnect={onConnect} />
    );
    openMenu();

    const item = screen.getByTestId('datalake-connect-source-github-item');
    expect(item).not.toHaveAttribute('aria-disabled', 'true');
    fireEvent.click(item);
    expect(onConnect).toHaveBeenCalledWith('github');
  });

  it('keeps GitHub listed but disabled on a personal lake, with the reason inline', () => {
    const onConnect = vi.fn();
    wrap(<ConnectSourceMenu lake={{ organizationId: null, canManage: true, isCreator: true }} onConnect={onConnect} />);
    openMenu();

    const item = screen.getByTestId('datalake-connect-source-github-item');
    expect(item).toHaveAttribute('aria-disabled', 'true');
    expect(screen.getByTestId('datalake-connect-source-github-hint')).toHaveTextContent(/organization/);
    fireEvent.click(item);
    expect(onConnect).not.toHaveBeenCalled();
  });

  it('hides GitHub entirely while EnableDataLakeGitHub is off', () => {
    isAdminFeatureEnabled.mockReturnValue(false);
    wrap(
      <ConnectSourceMenu lake={{ organizationId: 'org-1', canManage: true, isCreator: false }} onConnect={vi.fn()} />
    );
    openMenu();

    expect(screen.getByTestId('datalake-connect-source-drive-item')).toBeInTheDocument();
    expect(screen.queryByTestId('datalake-connect-source-github-item')).toBeNull();
    expect(isAdminFeatureEnabled).toHaveBeenCalledWith('EnableDataLakeGitHub');
  });

  it('disables both sources, with the manager-only reason inline, for an org member who cannot manage the lake', () => {
    const onConnect = vi.fn();
    wrap(
      <ConnectSourceMenu lake={{ organizationId: 'org-1', canManage: false, isCreator: false }} onConnect={onConnect} />
    );
    openMenu();

    for (const slug of ['drive', 'github']) {
      expect(screen.getByTestId(`datalake-connect-source-${slug}-item`)).toHaveAttribute('aria-disabled', 'true');
      expect(screen.getByTestId(`datalake-connect-source-${slug}-hint`)).toHaveTextContent(LAKE_MANAGER_ONLY_REASON);
    }
    fireEvent.click(screen.getByTestId('datalake-connect-source-github-item'));
    fireEvent.click(screen.getByTestId('datalake-connect-source-drive-item'));
    expect(onConnect).not.toHaveBeenCalled();
  });

  it('reports the chosen source kind to onConnect', () => {
    const onConnect = vi.fn();
    wrap(
      <ConnectSourceMenu lake={{ organizationId: 'org-1', canManage: true, isCreator: false }} onConnect={onConnect} />
    );
    openMenu();
    fireEvent.click(screen.getByTestId('datalake-connect-source-github-item'));
    expect(onConnect).toHaveBeenLastCalledWith('github');

    openMenu();
    fireEvent.click(screen.getByTestId('datalake-connect-source-drive-item'));
    expect(onConnect).toHaveBeenLastCalledWith('googleDrive');
    expect(onConnect).toHaveBeenCalledTimes(2);
  });
});
