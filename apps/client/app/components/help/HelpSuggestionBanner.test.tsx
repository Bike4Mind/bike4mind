import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { CssVarsProvider, extendTheme } from '@mui/joy/styles';
import { getThemeConfig } from '@client/app/utils/themes';
import HelpSuggestionBanner, { useDismissedHelpSuggestions } from './HelpSuggestionBanner';

// Control the current route path per-test.
let mockPathname = '/projects';
vi.mock('@tanstack/react-router', () => ({
  useLocation: () => ({ pathname: mockPathname }),
}));

const openHelpPanelMock = vi.fn();
vi.mock('@client/app/hooks/useHelpPanel', () => ({
  openHelpPanel: (...args: unknown[]) => openHelpPanelMock(...args),
}));

const appTheme = extendTheme({ ...getThemeConfig() });
const TestWrapper = ({ children }: { children: React.ReactNode }) => (
  <CssVarsProvider theme={appTheme}>{children}</CssVarsProvider>
);

describe('HelpSuggestionBanner', () => {
  beforeEach(() => {
    mockPathname = '/projects';
    openHelpPanelMock.mockClear();
    useDismissedHelpSuggestions.setState({ dismissedPaths: [] });
    localStorage.clear();
  });

  it('renders a suggestion for a mapped route', () => {
    render(<HelpSuggestionBanner />, { wrapper: TestWrapper });
    expect(screen.getByTestId('help-suggestion-banner')).toBeInTheDocument();
    expect(screen.getByTestId('help-suggestion-link')).toHaveTextContent('Learn about Projects');
  });

  it('renders nothing for an unmapped route', () => {
    mockPathname = '/settings';
    render(<HelpSuggestionBanner />, { wrapper: TestWrapper });
    expect(screen.queryByTestId('help-suggestion-banner')).not.toBeInTheDocument();
  });

  it('opens the help panel to the mapped article when clicked', () => {
    render(<HelpSuggestionBanner />, { wrapper: TestWrapper });
    fireEvent.click(screen.getByTestId('help-suggestion-link'));
    expect(openHelpPanelMock).toHaveBeenCalledWith('features/projects');
  });

  it('hides after dismissal and records the dismissed path', () => {
    render(<HelpSuggestionBanner />, { wrapper: TestWrapper });
    fireEvent.click(screen.getByTestId('help-suggestion-dismiss-btn'));
    expect(screen.queryByTestId('help-suggestion-banner')).not.toBeInTheDocument();
    expect(useDismissedHelpSuggestions.getState().dismissedPaths).toContain('/projects');
  });
});
