import { describe, expect, it, vi } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import { CssVarsProvider, extendTheme } from '@mui/joy/styles';
import { getThemeConfig } from '@client/app/utils/themes';

vi.mock('@tanstack/react-router', () => ({
  useRouter: () => ({ state: { location: { pathname: '/new' } } }),
  useNavigate: () => vi.fn(),
}));
vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string, fallback?: string) => fallback ?? key }),
}));
vi.mock('./index', () => ({
  useNotebookLayout: (select: (s: unknown) => unknown) =>
    select({ openSideNav: false, setOpenSideNav: vi.fn(), showMessageCounts: false }),
}));
vi.mock('@client/app/components/Session/SidenavItem', () => ({ default: () => null }));
vi.mock('@client/app/components/Session/SearchBarWithToggle', () => ({ default: () => null }));
vi.mock('@client/app/components/Session/SessionOwnerBadge', () => ({ default: () => null }));
vi.mock('@client/app/contexts/SessionsContext', () => ({ useSessions: () => ({ currentSession: null }) }));
vi.mock('@client/app/contexts/NotebookSearchContext', () => ({ useNotebookSearch: () => ({ setSearch: vi.fn() }) }));
vi.mock('@client/app/hooks/data/sessions', () => ({ useGetFavoriteSessions: () => ({ data: [] }) }));
vi.mock('@client/app/hooks/useVisibleGears', () => ({
  gearsMenuDot: () => null,
  useGearsNavSignal: () => ({ startHere: false, claimableCount: 0 }),
}));

import NotebookHeader from './Header';

const appTheme = extendTheme({ ...getThemeConfig() });

describe('NotebookHeader', () => {
  it('is the page banner landmark and holds the menu toggle', () => {
    render(
      <CssVarsProvider theme={appTheme}>
        <NotebookHeader />
      </CssVarsProvider>
    );
    const banner = screen.getByRole('banner');
    expect(within(banner).getByTestId('notebook-header-menu-btn')).toBeInTheDocument();
  });
});
