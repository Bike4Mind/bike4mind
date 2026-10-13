import type { ReactNode } from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import { CssVarsProvider, extendTheme } from '@mui/joy/styles';
import { getThemeConfig } from '@client/app/utils/themes';
import type { ISessionDocument } from '@bike4mind/common';

const hoisted = vi.hoisted(() => ({
  currentSession: null as Partial<ISessionDocument> | null,
  cachedSession: undefined as Partial<ISessionDocument> | undefined,
}));

vi.mock('./index', () => ({
  useNotebookLayout: (selector: (s: unknown) => unknown) =>
    selector({ openSideNav: false, setOpenSideNav: vi.fn(), showMessageCounts: false }),
}));
vi.mock('@client/app/contexts/SessionsContext', () => ({
  useSessions: () => ({ currentSession: hoisted.currentSession }),
}));
vi.mock('@client/app/hooks/data/sessions', () => ({
  useGetFavoriteSessions: () => ({ data: [] }),
  useGetSession: () => ({ data: hoisted.cachedSession }),
}));
vi.mock('@tanstack/react-router', () => ({
  useRouter: () => ({ state: { location: { pathname: '/notebooks/s1' } } }),
  useNavigate: () => vi.fn(),
}));
vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string, fallback?: string) => fallback ?? key }),
}));
vi.mock('@client/app/contexts/NotebookSearchContext', () => ({ useNotebookSearch: () => ({ setSearch: vi.fn() }) }));
vi.mock('@client/app/components/Session/SearchBarWithToggle', () => ({ default: () => null }));
vi.mock('@client/app/components/Session/SessionOwnerBadge', () => ({ default: () => null }));
vi.mock('@client/app/components/Session/SidenavItem', () => ({
  default: ({ session }: { session: ISessionDocument }) => (
    <span data-testid="header-session-name">{session.name}</span>
  ),
}));
vi.mock('@client/app/hooks/useMobileHeader', () => ({
  useMobileHeaderStore: (selector: (s: unknown) => unknown) => selector({ title: null, action: null }),
}));
vi.mock('@client/app/hooks/useVisibleGears', () => ({
  useGearsNavSignal: () => ({ startHere: false, claimableCount: 0 }),
  gearsMenuDot: () => null,
}));

import NotebookHeader from './Header';

const appTheme = extendTheme({ ...getThemeConfig() });
const Wrapper = ({ children }: { children: ReactNode }) => (
  <CssVarsProvider theme={appTheme}>{children}</CssVarsProvider>
);

describe('NotebookHeader (phone) session title', () => {
  beforeEach(() => {
    hoisted.currentSession = { id: 's1', name: 'New Notebook' };
    hoisted.cachedSession = undefined;
  });

  it('shows the auto-title from the session cache once it lands', () => {
    hoisted.cachedSession = { id: 's1', name: 'Sunken Crown NPCs' };
    render(<NotebookHeader />, { wrapper: Wrapper });
    expect(screen.getByTestId('header-session-name')).toHaveTextContent('Sunken Crown NPCs');
  });

  it('keeps the context name until the cache has the session', () => {
    render(<NotebookHeader />, { wrapper: Wrapper });
    expect(screen.getByTestId('header-session-name')).toHaveTextContent('New Notebook');
  });

  it('ignores a cached entry for a different session', () => {
    hoisted.cachedSession = { id: 'other', name: 'Other chat' };
    render(<NotebookHeader />, { wrapper: Wrapper });
    expect(screen.getByTestId('header-session-name')).toHaveTextContent('New Notebook');
  });
});

describe('NotebookHeader', () => {
  it('is the page banner landmark and holds the menu toggle', () => {
    hoisted.currentSession = null;
    render(<NotebookHeader />, { wrapper: Wrapper });
    const banner = screen.getByRole('banner');
    expect(within(banner).getByTestId('notebook-header-menu-btn')).toBeInTheDocument();
  });
});
