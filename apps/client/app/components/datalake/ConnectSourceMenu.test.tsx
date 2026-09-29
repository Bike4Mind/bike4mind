import type { ReactNode } from 'react';
import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { CssVarsProvider, extendTheme } from '@mui/joy/styles';
import { getThemeConfig } from '@client/app/utils/themes';
import ConnectSourceMenu from './ConnectSourceMenu';

const appTheme = extendTheme({ ...getThemeConfig() });
const wrap = (ui: ReactNode) => render(<CssVarsProvider theme={appTheme}>{ui}</CssVarsProvider>);

const openMenu = () => fireEvent.click(screen.getByTestId('datalake-connect-source-btn'));

describe('ConnectSourceMenu', () => {
  it('lists Google Drive as a connectable source on an org lake', () => {
    const onConnectDrive = vi.fn();
    wrap(<ConnectSourceMenu lake={{ organizationId: 'org-1' }} onConnectDrive={onConnectDrive} />);
    openMenu();

    const item = screen.getByTestId('datalake-connect-source-drive-item');
    expect(item).not.toHaveAttribute('aria-disabled', 'true');
    fireEvent.click(item);
    expect(onConnectDrive).toHaveBeenCalledOnce();
  });

  it('keeps Google Drive listed but disabled on a personal lake, with the reason inline', () => {
    const onConnectDrive = vi.fn();
    wrap(<ConnectSourceMenu lake={{ organizationId: null }} onConnectDrive={onConnectDrive} />);
    openMenu();

    const item = screen.getByTestId('datalake-connect-source-drive-item');
    expect(item).toHaveAttribute('aria-disabled', 'true');
    expect(screen.getByTestId('datalake-connect-source-drive-hint')).toHaveTextContent(/organization/);
    fireEvent.click(item);
    expect(onConnectDrive).not.toHaveBeenCalled();
  });
});
