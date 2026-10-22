import { render, screen, fireEvent, cleanup } from '@testing-library/react';
import { CssVarsProvider, extendTheme } from '@mui/joy/styles';
import { vi, describe, it, expect, beforeEach } from 'vitest';
import { getThemeConfig } from '@client/app/utils/themes';
import NotebookGroupList from './NotebookGroupList';
import { useApiGroupExpansion } from './useApiGroupExpansion';
import type { CombinedItem } from './types';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (_k: string, fallback?: string, options?: { count?: number }) =>
      (fallback ?? _k).replace('{{count}}', String(options?.count ?? '')),
  }),
  initReactI18next: { type: '3rdParty', init: vi.fn() },
}));

// Every row lands in "Today" so one bucket holds them all.
vi.mock('@client/app/utils/dateUtils', () => ({ getDateLabel: () => 'Today' }));

vi.mock('./NotebookRow', () => ({
  default: ({ item }: { item: { id: string } }) => <div data-testid={`row-${item.id}`} />,
}));

const appTheme = extendTheme({ ...getThemeConfig() });
const TestWrapper = ({ children }: { children: React.ReactNode }) => (
  <CssVarsProvider theme={appTheme}>{children}</CssVarsProvider>
);

let minute = 0;
const session = (id: string, channel?: string) => {
  minute += 1;
  return {
    id,
    name: id,
    userId: 'u1',
    lastUpdated: new Date(Date.UTC(2026, 0, 1, 0, 60 - minute)),
    firstCreated: new Date(),
    ...(channel ? { origin: { channel } } : {}),
  } as unknown as CombinedItem;
};

const items = () => [session('w1', 'web'), session('a1', 'api'), session('l1'), session('a2', 'api')];

const renderList = (props: Partial<React.ComponentProps<typeof NotebookGroupList>> = {}) =>
  render(
    <NotebookGroupList
      items={items()}
      favoriteItems={[]}
      isEditMode={false}
      selectedItems={new Set()}
      showMessageCount={false}
      onNavigate={vi.fn()}
      onNotebookClick={vi.fn()}
      onToggle={vi.fn()}
      {...props}
    />,
    { wrapper: TestWrapper }
  );

describe('NotebookGroupList API grouping', () => {
  beforeEach(() => {
    minute = 0;
    useApiGroupExpansion.setState({ expanded: {} });
  });

  it('collapses API notebooks into one row, collapsed by default', () => {
    renderList();
    const toggle = screen.getByTestId('sidenav-api-group-toggle');
    expect(toggle).toHaveTextContent('API - 2 notebooks');
    expect(toggle).toHaveAttribute('aria-expanded', 'false');
    expect(screen.getByTestId('row-w1')).toBeInTheDocument();
    expect(screen.getByTestId('row-l1')).toBeInTheDocument();
    expect(screen.queryByTestId('row-a1')).toBeNull();
    expect(screen.queryByTestId('row-a2')).toBeNull();
  });

  it('expands on click and remembers the expansion per bucket across remounts', () => {
    renderList();
    fireEvent.click(screen.getByTestId('sidenav-api-group-toggle'));
    expect(screen.getByTestId('row-a1')).toBeInTheDocument();
    expect(screen.getByTestId('row-a2')).toBeInTheDocument();
    expect(useApiGroupExpansion.getState().expanded).toEqual({ Today: true });

    cleanup();
    minute = 0;
    renderList();
    expect(screen.getByTestId('sidenav-api-group-toggle')).toHaveAttribute('aria-expanded', 'true');
    expect(screen.getByTestId('row-a1')).toBeInTheDocument();
  });

  it('does not collapse when grouping is off (the "Only API" filter)', () => {
    renderList({ groupApiNotebooks: false });
    expect(screen.queryByTestId('sidenav-api-group-toggle')).toBeNull();
    expect(screen.getByTestId('row-a1')).toBeInTheDocument();
  });

  it('does not collapse in bulk-edit mode, so every row stays checkable', () => {
    renderList({ isEditMode: true });
    expect(screen.queryByTestId('sidenav-api-group-toggle')).toBeNull();
    expect(screen.getByTestId('row-a2')).toBeInTheDocument();
  });
});
