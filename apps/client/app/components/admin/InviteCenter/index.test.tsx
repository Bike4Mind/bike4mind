import type { ReactNode } from 'react';
import { fireEvent, render, screen } from '@testing-library/react';
import { CssVarsProvider, extendTheme } from '@mui/joy/styles';
import { describe, expect, it, vi } from 'vitest';
import { getThemeConfig } from '@client/app/utils/themes';
import InviteCenter from './index';

vi.mock('./InviteCenterQuickActions', () => ({ default: () => null }));
vi.mock('./BulkInvite/BulkInviteTab', () => ({ default: () => <div data-testid="stub-bulk-view" /> }));
vi.mock('./InviteCodes/InviteCodesTab', () => ({ default: () => <div data-testid="stub-codes-view" /> }));

const theme = extendTheme({ ...getThemeConfig() });
const Wrapper = ({ children }: { children: ReactNode }) => <CssVarsProvider theme={theme}>{children}</CssVarsProvider>;

describe('InviteCenter', () => {
  it('renders one Invites heading and switches views through the tab test ids', () => {
    render(<InviteCenter />, { wrapper: Wrapper });

    expect(screen.getAllByRole('heading', { level: 1 }).map(h => h.textContent)).toEqual(['Invites']);
    expect(screen.getByTestId('stub-bulk-view')).toBeInTheDocument();
    fireEvent.click(screen.getByTestId('invite-center-codes-tab'));
    expect(screen.getByTestId('stub-codes-view')).toBeInTheDocument();
    fireEvent.click(screen.getByTestId('invite-center-bulk-tab'));
    expect(screen.getByTestId('stub-bulk-view')).toBeInTheDocument();
  });
});
