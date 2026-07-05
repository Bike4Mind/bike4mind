import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { CssVarsProvider, extendTheme } from '@mui/joy/styles';
import { getThemeConfig } from '@client/app/utils/themes';
import DestructiveActionHelp from './DestructiveActionHelp';

const openHelpPanelMock = vi.fn();
vi.mock('@client/app/hooks/useHelpPanel', () => ({
  openHelpPanel: (...args: unknown[]) => openHelpPanelMock(...args),
}));

const appTheme = extendTheme({ ...getThemeConfig() });
const TestWrapper = ({ children }: { children: React.ReactNode }) => (
  <CssVarsProvider theme={appTheme}>{children}</CssVarsProvider>
);

describe('DestructiveActionHelp', () => {
  beforeEach(() => openHelpPanelMock.mockClear());

  it('renders the default affordance label', () => {
    render(<DestructiveActionHelp consequences="Bans the user." />, { wrapper: TestWrapper });
    expect(screen.getByTestId('destructive-action-help-label')).toHaveTextContent("Here's what happens");
  });

  it('reveals consequences on hover and links to the help article', async () => {
    render(<DestructiveActionHelp consequences="Bans the user." helpId="admin/user-management" />, {
      wrapper: TestWrapper,
    });
    fireEvent.mouseOver(screen.getByTestId('destructive-action-help-label'));
    expect(await screen.findByTestId('destructive-action-help-consequences')).toHaveTextContent('Bans the user.');
    fireEvent.click(await screen.findByTestId('destructive-action-help-link'));
    expect(openHelpPanelMock).toHaveBeenCalledWith('admin/user-management');
  });

  it('hides after being dismissed', () => {
    render(<DestructiveActionHelp consequences="Bans the user." />, { wrapper: TestWrapper });
    fireEvent.click(screen.getByTestId('destructive-action-help-dismiss-btn'));
    expect(screen.queryByTestId('destructive-action-help')).not.toBeInTheDocument();
  });
});
