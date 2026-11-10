import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { CssVarsProvider, extendTheme } from '@mui/joy/styles';
import { getThemeConfig } from '@client/app/utils/themes';

const { isFeatureEnabled, navigate, location, pagesState } = vi.hoisted(() => ({
  isFeatureEnabled: vi.fn(),
  navigate: vi.fn(),
  location: { pathname: '/new' },
  pagesState: { pages: [] as Array<{ id: string; name: string; icon?: string }> },
}));

vi.mock('@client/app/hooks/useFeatureEnabled', () => ({ useFeatureEnabled: () => ({ isFeatureEnabled }) }));
vi.mock('@client/app/hooks/data/customPages', () => ({
  useCustomPages: () => ({ data: pagesState.pages }),
  useCreateCustomPage: () => ({ mutateAsync: vi.fn(), isPending: false }),
}));
vi.mock('@client/app/hooks/useIsMobile', () => ({ useIsMobile: () => false }));
vi.mock('@tanstack/react-router', () => ({
  useNavigate: () => navigate,
  useLocation: () => ({ pathname: location.pathname }),
}));
vi.mock('..', () => ({ useNotebookLayout: () => vi.fn() }));

import SidenavPages from './SidenavPages';

const appTheme = extendTheme({ ...getThemeConfig() });
const renderPages = () =>
  render(
    <CssVarsProvider theme={appTheme}>
      <SidenavPages />
    </CssVarsProvider>
  );

beforeEach(() => {
  vi.clearAllMocks();
  isFeatureEnabled.mockReturnValue(true);
  location.pathname = '/new';
  pagesState.pages = [
    { id: 'p1', name: 'Daily menu' },
    { id: 'p2', name: 'Budget', icon: 'x' },
  ];
});

describe('SidenavPages', () => {
  it('renders nothing when the feature is off', () => {
    isFeatureEnabled.mockReturnValue(false);
    renderPages();
    expect(screen.queryByTestId('sidenav-pages-new-btn')).not.toBeInTheDocument();
    expect(screen.queryByTestId('sidenav-page-p1')).not.toBeInTheDocument();
    expect(isFeatureEnabled).toHaveBeenCalledWith('enableCustomPages');
  });

  it('lists pages and navigates on click', () => {
    renderPages();
    expect(screen.getByTestId('sidenav-page-p1')).toHaveTextContent('Daily menu');
    fireEvent.click(screen.getByTestId('sidenav-page-p2'));
    expect(navigate).toHaveBeenCalledWith({ to: '/pages/$id', params: { id: 'p2' } });
  });

  it('marks the current page active', () => {
    location.pathname = '/pages/p1';
    renderPages();
    expect(screen.getByTestId('sidenav-page-p1')).toHaveAttribute('aria-current', 'page');
    expect(screen.getByTestId('sidenav-page-p2')).not.toHaveAttribute('aria-current');
  });

  it('opens the new page dialog from the add button', () => {
    renderPages();
    expect(screen.queryByTestId('new-page-name-input')).not.toBeInTheDocument();
    fireEvent.click(screen.getByTestId('sidenav-pages-new-btn'));
    expect(screen.getByTestId('new-page-name-input')).toBeInTheDocument();
  });
});
