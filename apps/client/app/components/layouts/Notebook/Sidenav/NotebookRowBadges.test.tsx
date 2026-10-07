import { render, screen } from '@testing-library/react';
import { CssVarsProvider, extendTheme } from '@mui/joy/styles';
import { vi, describe, it, expect } from 'vitest';
import { getThemeConfig } from '@client/app/utils/themes';
import NotebookRowBadges, { hasNotebookRowBadges } from './NotebookRowBadges';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (_k: string, fallback?: string) => fallback ?? _k }),
  initReactI18next: { type: '3rdParty', init: vi.fn() },
}));

const appTheme = extendTheme({ ...getThemeConfig() });
const TestWrapper = ({ children }: { children: React.ReactNode }) => (
  <CssVarsProvider theme={appTheme}>{children}</CssVarsProvider>
);

describe('NotebookRowBadges', () => {
  it('shows both badges for an API notebook with images', () => {
    render(<NotebookRowBadges session={{ imageCount: 2, origin: { channel: 'api' } }} />, { wrapper: TestWrapper });
    expect(screen.getByTestId('sidenav-row-api-badge')).toBeInTheDocument();
    expect(screen.getByTestId('sidenav-row-image-badge')).toBeInTheDocument();
  });

  it('shows only the image badge for a web notebook with images', () => {
    render(<NotebookRowBadges session={{ imageCount: 1, origin: { channel: 'web' } }} />, { wrapper: TestWrapper });
    expect(screen.queryByTestId('sidenav-row-api-badge')).toBeNull();
    expect(screen.getByTestId('sidenav-row-image-badge')).toBeInTheDocument();
  });

  it('renders nothing for a plain notebook or one with no recorded origin', () => {
    render(<NotebookRowBadges session={{ imageCount: 0 }} />, { wrapper: TestWrapper });
    expect(screen.queryByTestId('sidenav-row-badges')).toBeNull();
  });

  it('hasNotebookRowBadges mirrors what renders', () => {
    expect(hasNotebookRowBadges({ imageCount: 0, origin: { channel: 'slack' } })).toBe(false);
    expect(hasNotebookRowBadges({ origin: { channel: 'api' } })).toBe(true);
    expect(hasNotebookRowBadges({ imageCount: 3 })).toBe(true);
  });
});
