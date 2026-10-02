import type { ReactNode } from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { CssVarsProvider, extendTheme } from '@mui/joy/styles';
import { getThemeConfig } from '@client/app/utils/themes';

const isAdminFeatureEnabled = vi.fn();
vi.mock('@client/app/hooks/useFeatureEnabled', () => ({
  useFeatureEnabled: () => ({ isAdminFeatureEnabled, isFeatureEnabled: vi.fn(), isLoading: false }),
}));

import ConnectSourceMenu from './ConnectSourceMenu';

const appTheme = extendTheme({ ...getThemeConfig() });
const wrap = (ui: ReactNode) => render(<CssVarsProvider theme={appTheme}>{ui}</CssVarsProvider>);

const openMenu = () => fireEvent.click(screen.getByTestId('datalake-connect-source-btn'));

describe('ConnectSourceMenu', () => {
  beforeEach(() => {
    isAdminFeatureEnabled.mockReset();
    isAdminFeatureEnabled.mockImplementation((key: string) => key === 'EnableDataLakeGitHub');
  });

  it('lists Google Drive as a connectable source on an org lake', () => {
    const onConnectDrive = vi.fn();
    wrap(
      <ConnectSourceMenu
        lake={{ organizationId: 'org-1', isCreator: false }}
        onConnectDrive={onConnectDrive}
        onConnectGitHub={vi.fn()}
      />
    );
    openMenu();

    const item = screen.getByTestId('datalake-connect-source-drive-item');
    expect(item).not.toHaveAttribute('aria-disabled', 'true');
    fireEvent.click(item);
    expect(onConnectDrive).toHaveBeenCalledOnce();
  });

  it('enables Google Drive on a personal lake the caller created', () => {
    const onConnectDrive = vi.fn();
    wrap(
      <ConnectSourceMenu
        lake={{ organizationId: null, isCreator: true }}
        onConnectDrive={onConnectDrive}
        onConnectGitHub={vi.fn()}
      />
    );
    openMenu();

    const item = screen.getByTestId('datalake-connect-source-drive-item');
    expect(item).not.toHaveAttribute('aria-disabled', 'true');
    fireEvent.click(item);
    expect(onConnectDrive).toHaveBeenCalledOnce();
  });

  it("keeps Google Drive listed but disabled on someone else's personal lake, with the reason inline", () => {
    const onConnectDrive = vi.fn();
    wrap(
      <ConnectSourceMenu
        lake={{ organizationId: null, isCreator: false }}
        onConnectDrive={onConnectDrive}
        onConnectGitHub={vi.fn()}
      />
    );
    openMenu();

    const item = screen.getByTestId('datalake-connect-source-drive-item');
    expect(item).toHaveAttribute('aria-disabled', 'true');
    expect(screen.getByTestId('datalake-connect-source-drive-hint')).toHaveTextContent(/Only the person who created/);
    fireEvent.click(item);
    expect(onConnectDrive).not.toHaveBeenCalled();
  });

  it('lists GitHub as a connectable source on an org lake', () => {
    const onConnectGitHub = vi.fn();
    wrap(
      <ConnectSourceMenu
        lake={{ organizationId: 'org-1', isCreator: false }}
        onConnectDrive={vi.fn()}
        onConnectGitHub={onConnectGitHub}
      />
    );
    openMenu();

    const item = screen.getByTestId('datalake-connect-source-github-item');
    expect(item).not.toHaveAttribute('aria-disabled', 'true');
    fireEvent.click(item);
    expect(onConnectGitHub).toHaveBeenCalledOnce();
  });

  it('keeps GitHub listed but disabled on a personal lake, with the reason inline', () => {
    const onConnectGitHub = vi.fn();
    wrap(
      <ConnectSourceMenu
        lake={{ organizationId: null, isCreator: true }}
        onConnectDrive={vi.fn()}
        onConnectGitHub={onConnectGitHub}
      />
    );
    openMenu();

    const item = screen.getByTestId('datalake-connect-source-github-item');
    expect(item).toHaveAttribute('aria-disabled', 'true');
    expect(screen.getByTestId('datalake-connect-source-github-hint')).toHaveTextContent(/organization/);
    fireEvent.click(item);
    expect(onConnectGitHub).not.toHaveBeenCalled();
  });

  it('hides GitHub entirely while EnableDataLakeGitHub is off', () => {
    isAdminFeatureEnabled.mockReturnValue(false);
    wrap(
      <ConnectSourceMenu
        lake={{ organizationId: 'org-1', isCreator: false }}
        onConnectDrive={vi.fn()}
        onConnectGitHub={vi.fn()}
      />
    );
    openMenu();

    expect(screen.getByTestId('datalake-connect-source-drive-item')).toBeInTheDocument();
    expect(screen.queryByTestId('datalake-connect-source-github-item')).toBeNull();
    expect(isAdminFeatureEnabled).toHaveBeenCalledWith('EnableDataLakeGitHub');
  });
});
