import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { CssVarsProvider, extendTheme } from '@mui/joy/styles';
import { getThemeConfig } from '@client/app/utils/themes';
import RecentlyViewedList from './RecentlyViewedList';
import type { MyRecentlyViewedArticle } from '@client/app/hooks/useHelpAnalytics';

const appTheme = extendTheme({ ...getThemeConfig() });
const TestWrapper = ({ children }: { children: React.ReactNode }) => (
  <CssVarsProvider theme={appTheme}>{children}</CssVarsProvider>
);

const articles: MyRecentlyViewedArticle[] = [
  { slug: 'features/projects', articleTitle: 'Projects', viewedAt: '2026-07-01T00:00:00Z' },
  { slug: 'features/agents', viewedAt: '2026-06-30T00:00:00Z' }, // no title → falls back to slug
];

describe('RecentlyViewedList', () => {
  it('renders nothing when there are no articles', () => {
    const { container } = render(<RecentlyViewedList articles={[]} onNavigate={() => {}} />, {
      wrapper: TestWrapper,
    });
    expect(container).toBeEmptyDOMElement();
  });

  it('renders each article, falling back to slug when title is missing', () => {
    render(<RecentlyViewedList articles={articles} onNavigate={() => {}} />, { wrapper: TestWrapper });
    expect(screen.getByTestId('help-recently-viewed')).toBeInTheDocument();
    expect(screen.getByText('Projects')).toBeInTheDocument();
    expect(screen.getByText('features/agents')).toBeInTheDocument();
  });

  it('calls onNavigate with the slug when an item is clicked', () => {
    const onNavigate = vi.fn();
    render(<RecentlyViewedList articles={articles} onNavigate={onNavigate} />, { wrapper: TestWrapper });
    fireEvent.click(screen.getByTestId('help-recently-viewed-features-projects'));
    expect(onNavigate).toHaveBeenCalledWith('features/projects');
  });
});
