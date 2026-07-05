import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { CssVarsProvider, extendTheme } from '@mui/joy/styles';
import { vi, describe, it, expect, beforeEach } from 'vitest';
import { getThemeConfig } from '@client/app/utils/themes';
import CombinedNotebooks from './CombinedNotebooks';
import { useBulkActions } from './useBulkActions';

// Module mocks
vi.mock('zustand/react/shallow', () => ({ useShallow: (sel: unknown) => sel }));

vi.mock('@tanstack/react-router', () => ({
  useNavigate: () => vi.fn(),
  useLocation: () => ({ pathname: '/' }),
}));

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (_k: string, fallback?: string) => fallback ?? _k }),
  initReactI18next: { type: '3rdParty', init: vi.fn() },
}));

vi.mock('@client/config/general', () => ({ APP_NAME: 'TestApp' }));

// Parent layout store (selector-aware)
const mockSetOpenSideNav = vi.fn();
const mockSetShowMessageCounts = vi.fn();
vi.mock('..', () => ({
  useNotebookLayout: vi.fn((sel: unknown) => {
    const state = {
      showMessageCounts: false,
      setShowMessageCounts: mockSetShowMessageCounts,
      setOpenSideNav: mockSetOpenSideNav,
    };
    return typeof sel === 'function' ? (sel as (s: typeof state) => unknown)(state) : state;
  }),
}));

// Data hooks
const mockUseGetOwnSessions = vi.fn();
const mockUseGetSharedSessions = vi.fn();
const mockUseGetFavoriteSessions = vi.fn();
vi.mock('@client/app/hooks/data/sessions', () => ({
  useGetOwnSessions: (...args: unknown[]) => mockUseGetOwnSessions(...args),
  useGetSharedSessions: (...args: unknown[]) => mockUseGetSharedSessions(...args),
  useGetFavoriteSessions: () => mockUseGetFavoriteSessions(),
}));

const mockUseSearchProjects = vi.fn();
vi.mock('@client/app/hooks/data/projects', () => ({
  useSearchProjects: (...args: unknown[]) => mockUseSearchProjects(...args),
}));

const mockUseGetAgents = vi.fn();
vi.mock('@client/app/hooks/data/agents', () => ({
  useGetAgents: (...args: unknown[]) => mockUseGetAgents(...args),
}));

vi.mock('@client/app/contexts/UserContext', () => ({
  useUser: () => ({ currentUser: { id: 'user-1', createdAt: '2020-01-01T00:00:00Z' } }),
}));

vi.mock('@client/app/hooks/useFeatureEnabled', () => ({
  useFeatureEnabled: () => ({ isFeatureEnabled: () => false }),
}));

vi.mock('@client/app/hooks/useIsMobile', () => ({
  useIsMobile: () => false,
}));

vi.mock('@client/app/hooks/useAdvancedSearch', () => ({
  useAdvancedSearch: () => ({
    openDrawer: vi.fn(),
    hasActiveFilters: () => false,
    getActiveFilterCount: () => 0,
  }),
}));

// useBulkActions - mocked so we can inspect the selectableSessions argument
vi.mock('./useBulkActions', () => ({
  useBulkActions: vi.fn(() => ({
    selectedItems: new Set<string>(),
    visibleSelectedIds: new Set<string>(),
    setSelectedItems: vi.fn(),
    isEditMode: false,
    bulkActionsOpen: false,
    setBulkActionsOpen: vi.fn(),
    bulkActionsPos: { top: 0, left: 0 },
    bulkPanelRef: { current: null },
    showDeleteConfirm: false,
    setShowDeleteConfirm: vi.fn(),
    deleteSessions: { isPending: false },
    handleToggleItemSelection: vi.fn(),
    handleToggleSelectAll: vi.fn(),
    handleFavoriteSelected: vi.fn(),
    handleDownloadSelected: vi.fn(),
    handleDeleteSelected: vi.fn(),
    handleDeleteConfirm: vi.fn(),
    openBulkActions: vi.fn(),
    closeBulkActions: vi.fn(),
  })),
}));

// Child-component stubs
vi.mock('./SidenavNav', () => ({ default: () => null }));
vi.mock('./BulkActionsPanel', () => ({ default: () => null }));
vi.mock('./NotebookRow', () => ({ default: () => null }));

// NotebookGroupList renders each item id so tests can assert membership
vi.mock('./NotebookGroupList', () => ({
  default: ({ items }: { items: Array<{ id: string }> }) => (
    <ul data-testid="notebook-group-list">
      {items.map(item => (
        <li key={item.id} data-testid={`loose-item-${item.id}`} />
      ))}
    </ul>
  ),
}));

// FiltersPanel stub exposes filter buttons via the real data-testid convention
vi.mock('./FiltersPanel', () => ({
  default: ({
    setTypeFilter,
    typeOptions,
  }: {
    setTypeFilter: (v: string) => void;
    typeOptions: Array<{ value: string; label: string }>;
    [key: string]: unknown;
  }) => (
    <div data-testid="filters-panel-stub">
      {typeOptions.map(opt => (
        <button key={opt.value} data-testid={`sidenav-filter-${opt.value}`} onClick={() => setTypeFilter(opt.value)} />
      ))}
    </div>
  ),
}));

vi.mock('@client/app/components/Project/SidenavItem', () => ({
  default: ({ project }: { project: { id: string; name: string } }) => (
    <div data-testid={`project-item-${project.id}`}>{project.name}</div>
  ),
}));

vi.mock('./ProjectSessionList', () => ({
  default: ({ project }: { project: { id: string } }) => <div data-testid={`project-sessions-${project.id}`} />,
}));

vi.mock('./ProjectModal', () => ({ default: () => null }));
vi.mock('./TagModal', () => ({ default: () => null }));
vi.mock('@client/app/components/common/ShareModal', () => ({ default: () => null }));
vi.mock('@client/app/components/ConfirmActionModal', () => ({ default: () => null }));
vi.mock('@client/app/components/Session/SearchBar', () => ({ default: () => null }));
vi.mock('@client/app/components/Notebook/Search/AdvancedSearchDrawer', () => ({ default: () => null }));

// Test wrapper
const appTheme = extendTheme({ ...getThemeConfig() });
const TestWrapper = ({ children }: { children: React.ReactNode }) => (
  <CssVarsProvider theme={appTheme}>{children}</CssVarsProvider>
);

// Test data factories
const makeSession = (id: string) => ({
  id,
  userId: 'user-1',
  name: `Session ${id}`,
  title: `Session ${id}`,
  type: 'session',
  lastUpdated: new Date('2024-01-01').toISOString(),
  updatedAt: new Date('2024-01-01').toISOString(),
  createdAt: new Date('2024-01-01').toISOString(),
  ownerId: 'user-1',
});

const makeProject = (id: string, sessionIds: string[]) => ({
  id,
  name: `Project ${id}`,
  description: '',
  sessionIds,
  createdAt: new Date('2024-01-01').toISOString(),
  updatedAt: new Date('2024-01-01').toISOString(),
  ownerId: 'user-1',
});

const emptyInfiniteQuery = {
  data: undefined,
  fetchNextPage: vi.fn(),
  hasNextPage: false,
  isFetching: false,
};

// Setup
beforeEach(() => {
  vi.clearAllMocks();
  mockUseGetSharedSessions.mockReturnValue(emptyInfiniteQuery);
  mockUseGetFavoriteSessions.mockReturnValue({ data: undefined, isFetching: false });
  mockUseGetAgents.mockReturnValue({ data: undefined, isLoading: false });
  mockUseSearchProjects.mockReturnValue({ data: undefined, isLoading: false });
  mockUseGetOwnSessions.mockReturnValue(emptyInfiniteQuery);
});

const renderComponent = () => render(<CombinedNotebooks />, { wrapper: TestWrapper });

const openFiltersPanel = async () => {
  fireEvent.click(screen.getByTestId('sidenav-filters-btn'));
  await waitFor(() => screen.getByTestId('filters-panel-stub'));
};

// Tests
describe('CombinedNotebooks — project-session deduplication', () => {
  const projectSession = makeSession('session-p1');
  const looseSession = makeSession('session-loose');
  const project = makeProject('project-1', ['session-p1']);

  beforeEach(() => {
    mockUseGetOwnSessions.mockReturnValue({
      data: { pages: [{ data: [projectSession, looseSession], hasMore: false }] },
      fetchNextPage: vi.fn(),
      hasNextPage: false,
      isFetching: false,
    });
    mockUseSearchProjects.mockReturnValue({
      data: { pages: [{ data: [project], hasMore: false }] },
      isLoading: false,
    });
  });

  it('excludes project-member sessions from the loose list when typeFilter is all', () => {
    renderComponent();

    expect(screen.queryByTestId('loose-item-session-p1')).toBeNull();
    expect(screen.getByTestId('loose-item-session-loose')).toBeInTheDocument();
  });

  it('includes project-member sessions in the loose list when typeFilter is notebooks', async () => {
    renderComponent();

    await openFiltersPanel();
    fireEvent.click(screen.getByTestId('sidenav-filter-notebooks'));

    await waitFor(() => {
      expect(screen.getByTestId('loose-item-session-p1')).toBeInTheDocument();
    });
    expect(screen.getByTestId('loose-item-session-loose')).toBeInTheDocument();
  });

  it('excludes project-member sessions from selectableSessions passed to useBulkActions', () => {
    renderComponent();

    const calls = vi.mocked(useBulkActions).mock.calls;
    const lastArgs = calls[calls.length - 1][0];
    const selectableIds = lastArgs.selectableSessions.map((s: { id: string }) => s.id);

    expect(selectableIds).not.toContain('session-p1');
    expect(selectableIds).toContain('session-loose');
  });
});
