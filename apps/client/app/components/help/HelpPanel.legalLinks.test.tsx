import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { CssVarsProvider, extendTheme } from '@mui/joy/styles';
import { getThemeConfig } from '@client/app/utils/themes';
import { ExternalLinks } from '@client/app/utils/externalLinks';

// Hook results must be stable references: HelpPanel's effects depend on them and re-render on change.
const { panelState, helpIndexResult, analytics, adminSettings } = vi.hoisted(() => ({
  panelState: {
    open: true,
    currentSlug: 'index',
    currentAnchor: undefined,
    panelWidth: 480,
    setPanelWidth: vi.fn(),
    chatHeight: 400,
    setChatHeight: vi.fn(),
    close: vi.fn(),
    navigateTo: vi.fn(),
    goBack: vi.fn(),
    goForward: vi.fn(),
    history: ['index'],
    historyIndex: 0,
    setOpen: vi.fn(),
  },
  helpIndexResult: { data: { entries: [], categories: [] }, isLoading: false },
  analytics: { trackArticleView: vi.fn(), trackSearch: vi.fn() },
  adminSettings: { isFeatureEnabled: () => false },
}));

vi.mock('@client/app/hooks/useHelpPanel', () => ({
  useHelpPanel: Object.assign(() => panelState, { getState: () => panelState }),
}));
vi.mock('@client/app/hooks/useHelpIndex', () => ({
  useHelpIndex: () => helpIndexResult,
  searchEntries: () => [],
  getEntryBySlug: () => undefined,
}));
vi.mock('@client/app/hooks/useAdminSettingsCache', () => ({
  useAdminSettingsCache: () => adminSettings,
}));
vi.mock('@client/app/hooks/useHelpChat', () => ({ useHelpChat: () => false }));
vi.mock('@client/app/hooks/useHelpAnalytics', () => ({
  useHelpAnalytics: () => analytics,
  useMyRecentlyViewed: () => ({ data: undefined }),
}));
vi.mock('@client/app/hooks/useArticleFeedbackState', () => ({
  useArticleFeedbackState: () => ({ rating: null, handleRating: vi.fn() }),
}));
vi.mock('./HelpContent', () => ({ default: () => null }));
vi.mock('./HelpChat', () => ({ default: () => null }));

import HelpPanel from './HelpPanel';

const appTheme = extendTheme({ ...getThemeConfig() });
const TestWrapper = ({ children }: { children: React.ReactNode }) => (
  <CssVarsProvider theme={appTheme}>{children}</CssVarsProvider>
);

describe('HelpPanel home legal links', () => {
  it('links the API data-handling page in a new tab', () => {
    render(<HelpPanel />, { wrapper: TestWrapper });
    fireEvent.click(screen.getByRole('tab', { name: 'Help Center' }));

    const link = screen.getByTestId('help-home-data-handling-link');
    expect(link).toHaveAttribute('href', ExternalLinks.dataHandling);
    expect(link).toHaveAttribute('target', '_blank');
    expect(link).toHaveAttribute('rel', 'noopener noreferrer');
  });
});
