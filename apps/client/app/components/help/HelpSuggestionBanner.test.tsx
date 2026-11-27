import { StrictMode } from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { CssVarsProvider, extendTheme } from '@mui/joy/styles';
import { getThemeConfig } from '@client/app/utils/themes';
import HelpSuggestionBanner, { useDismissedHelpSuggestions } from './HelpSuggestionBanner';
import OrgFormSaveBar from '../organizations/OrgFormSaveBar';

// Control the current route path per-test.
let mockPathname = '/projects';
vi.mock('@tanstack/react-router', () => ({
  useLocation: () => ({ pathname: mockPathname }),
  useBlocker: () => ({ status: 'idle' }),
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

  it('temporarily hides help for a dirty, blocked or pending save bar without dismissing the route', () => {
    const view = (count: number, pending = false) => (
      <StrictMode>
        <OrgFormSaveBar
          count={count}
          pending={pending}
          blockedReason="Validation failed"
          onSave={vi.fn()}
          onDiscard={vi.fn()}
        />
        <HelpSuggestionBanner />
      </StrictMode>
    );
    const { rerender } = render(view(0), { wrapper: TestWrapper });
    expect(screen.getByTestId('help-suggestion-banner')).toBeInTheDocument();
    rerender(view(1));
    expect(screen.getByTestId('admin-save-bar')).toBeInTheDocument();
    expect(screen.queryByTestId('help-suggestion-banner')).toBeNull();
    rerender(view(2, true));
    expect(screen.queryByTestId('help-suggestion-banner')).toBeNull();
    expect(useDismissedHelpSuggestions.getState().dismissedPaths).toEqual([]);
    rerender(view(0));
    expect(screen.getByTestId('help-suggestion-banner')).toBeInTheDocument();
  });

  it('releases only each mounted save bar token and cleans up during StrictMode unmounts', () => {
    const view = (first: boolean, second: boolean) => (
      <StrictMode>
        {first && <OrgFormSaveBar key="first" count={1} onSave={vi.fn()} onDiscard={vi.fn()} />}
        {second && <OrgFormSaveBar key="second" count={1} onSave={vi.fn()} onDiscard={vi.fn()} />}
        <HelpSuggestionBanner />
      </StrictMode>
    );
    const { rerender, unmount } = render(view(true, true), { wrapper: TestWrapper });
    expect(screen.queryByTestId('help-suggestion-banner')).toBeNull();
    rerender(view(false, true));
    expect(screen.queryByTestId('help-suggestion-banner')).toBeNull();
    unmount();
    render(<HelpSuggestionBanner />, { wrapper: TestWrapper });
    expect(screen.getByTestId('help-suggestion-banner')).toBeInTheDocument();
    expect(useDismissedHelpSuggestions.getState().dismissedPaths).toEqual([]);
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
