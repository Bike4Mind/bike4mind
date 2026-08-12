import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor, act } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { CssVarsProvider, extendTheme } from '@mui/joy/styles';
import { ListItem, ListItemButton } from '@mui/joy';
import { getThemeConfig } from '@client/app/utils/themes';
import type { IFabFileDocument } from '@bike4mind/common';
import { buildTagTree } from '@client/app/components/Files/Browser/TagView/parseTagNamespace';
import DataLakeTreeView, { UNCATEGORIZED_KEY, type DataLakeTreeChrome } from './DataLakeTreeView';

// DataLakeTreeView always calls this (cross-tree article search, #1693), even when disabled
// (no `source` prop / query too short) - the hook itself still needs a stub since these tests
// render without a QueryClientProvider. Individual tests override the return value.
const { mockGetDataLakeArticles } = vi.hoisted(() => ({ mockGetDataLakeArticles: vi.fn() }));
vi.mock('@client/app/hooks/data/dataLakes', () => ({
  useGetDataLakeArticles: (params: unknown, source: unknown) => mockGetDataLakeArticles(params, source),
}));

const appTheme = extendTheme({ ...getThemeConfig() });
const Wrapper = ({ children }: { children: React.ReactNode }) => (
  <CssVarsProvider theme={appTheme}>{children}</CssVarsProvider>
);

/** Minimal chrome: enough structure to drive the logic; no styling opinions under test. */
const testChrome: DataLakeTreeChrome = {
  containerSx: {},
  toolbarSx: {},
  searchPlaceholder: 'Filter...',
  searchSx: {},
  renderSortButton: (sortBy, toggle) => (
    <button data-testid="datalake-sort-toggle" data-sort={sortBy} onClick={toggle}>
      sort
    </button>
  ),
  renderBackRow: (label, onBack) => (
    <ListItemButton data-testid="datalake-back" onClick={onBack}>
      {label}
    </ListItemButton>
  ),
  scrollSx: {},
  nodeListSx: {},
  fileListSx: {},
  renderNodeRow: (node, _depth, onOpen) => (
    <ListItem key={node.segment}>
      <ListItemButton data-testid={`datalake-node-${node.segment}`} onClick={onOpen}>
        {node.segment} ({node.fileCount})
      </ListItemButton>
    </ListItem>
  ),
  renderFileRow: (file, selected, onSelect) => (
    <ListItem key={file.id}>
      <ListItemButton data-testid={`datalake-file-${file.id}`} data-selected={selected} onClick={onSelect}>
        {file.fileName}
      </ListItemButton>
    </ListItem>
  ),
  humanize: (segment, depth) => `${segment}@${depth}`,
  allCategoriesLabel: 'All Categories',
  emptyFilesLabel: 'No articles found',
  errorLabel: 'Failed to load articles',
};

const file = (id: string, fileName: string, tags: string[]): IFabFileDocument =>
  ({ id, fileName, tags: tags.map(name => ({ name })) }) as unknown as IFabFileDocument;

// books:war (2 files), books:peace (1), news:today (1), zebra:x (5) - zebra's count rank (highest)
// disagrees with its alpha rank (last), so count-desc and alpha sorts produce different orders.
const ARTICLES = [
  file('f1', 'b-war-one.md', ['books:war']),
  file('f2', 'a-war-two.md', ['books:war']),
  file('f3', 'peace.md', ['books:peace']),
  file('f4', 'today.md', ['news:today']),
  file('f5', 'x1.md', ['zebra:x']),
  file('f6', 'x2.md', ['zebra:x']),
  file('f7', 'x3.md', ['zebra:x']),
  file('f8', 'x4.md', ['zebra:x']),
  file('f9', 'x5.md', ['zebra:x']),
];
const TREE = buildTagTree([
  { tag: 'books:war', count: 2 },
  { tag: 'books:peace', count: 1 },
  { tag: 'news:today', count: 1 },
  { tag: 'zebra:x', count: 5 },
]);

const EMPTY_SELECTED_IDS: ReadonlySet<string> = new Set();

beforeEach(() => {
  mockGetDataLakeArticles.mockReset();
  mockGetDataLakeArticles.mockReturnValue({ data: undefined, isLoading: false });
});

const renderTree = (over: Partial<React.ComponentProps<typeof DataLakeTreeView>> = {}) => {
  const onNavigate = vi.fn();
  const onSelectFile = vi.fn();
  const utils = render(
    <DataLakeTreeView
      tree={TREE}
      articles={ARTICLES}
      breadcrumb={[]}
      onNavigate={onNavigate}
      selectedFileIds={EMPTY_SELECTED_IDS}
      onSelectFile={onSelectFile}
      isLoading={false}
      chrome={testChrome}
      {...over}
    />,
    { wrapper: Wrapper }
  );
  return { ...utils, onNavigate, onSelectFile };
};

describe('DataLakeTreeView nodes', () => {
  it('renders root nodes sorted by count desc, toggling to alpha', () => {
    renderTree();
    const nodes = () => screen.getAllByTestId(/^datalake-node-/).map(el => el.dataset.testid);
    // count desc: zebra(5) > books(3) > news(1)
    expect(nodes()).toEqual(['datalake-node-zebra', 'datalake-node-books', 'datalake-node-news']);
    fireEvent.click(screen.getByTestId('datalake-sort-toggle'));
    expect(screen.getByTestId('datalake-sort-toggle').dataset.sort).toBe('alpha');
    // alpha: books < news < zebra - a genuinely different order than count desc
    expect(nodes()).toEqual(['datalake-node-books', 'datalake-node-news', 'datalake-node-zebra']);
  });

  it('search filters segments and shows No matches when nothing survives', async () => {
    renderTree();
    const searchInput = screen.getByTestId('datalake-search').querySelector('input')!;
    await userEvent.type(searchInput, 'new');
    expect(screen.queryByTestId('datalake-node-books')).toBeNull();
    expect(screen.getByTestId('datalake-node-news')).toBeTruthy();
    await userEvent.clear(searchInput);
    await userEvent.type(searchInput, 'zzz');
    expect(screen.getByText('No matches')).toBeTruthy();
  });

  it('navigates into a node via the chrome row', () => {
    const { onNavigate } = renderTree();
    fireEvent.click(screen.getByTestId('datalake-node-books'));
    expect(onNavigate).toHaveBeenCalledWith(['books']);
  });

  it('shows the sort toggle at a folder level, where it actually reorders something', () => {
    renderTree();
    expect(screen.getByTestId('datalake-sort-toggle')).toBeTruthy();
  });
});

describe('DataLakeTreeView leaf files', () => {
  it('lists files carrying the leaf tag, name-sorted, and selects through the chrome row', () => {
    const { onSelectFile } = renderTree({ breadcrumb: ['books', 'war'] });
    const files = screen.getAllByTestId(/^datalake-file-/).map(el => el.dataset.testid);
    expect(files).toEqual(['datalake-file-f2', 'datalake-file-f1']); // a-war-two before b-war-one
    fireEvent.click(screen.getByTestId('datalake-file-f1'));
    expect(onSelectFile).toHaveBeenCalledWith(ARTICLES[0]);
  });

  it('marks the selected file through the chrome flag', () => {
    renderTree({ breadcrumb: ['books', 'war'], selectedFileIds: new Set(['f1']) });
    expect(screen.getByTestId('datalake-file-f1').dataset.selected).toBe('true');
    expect(screen.getByTestId('datalake-file-f2').dataset.selected).toBe('false');
  });

  it('marks multiple selected files at once (files added to the prompt earlier stay highlighted)', () => {
    renderTree({ breadcrumb: ['books', 'war'], selectedFileIds: new Set(['f1', 'f2']) });
    expect(screen.getByTestId('datalake-file-f1').dataset.selected).toBe('true');
    expect(screen.getByTestId('datalake-file-f2').dataset.selected).toBe('true');
  });

  it('shows the chrome empty-files label at an empty leaf', () => {
    renderTree({ breadcrumb: ['books', 'war'], articles: [] });
    expect(screen.getByText('No articles found')).toBeTruthy();
  });

  it('hides the sort toggle at a leaf - it always sorts by category then title regardless, so a live toggle would visibly do nothing', () => {
    renderTree({ breadcrumb: ['books', 'war'] });
    expect(screen.queryByTestId('datalake-sort-toggle')).toBeNull();
  });

  it('filters the leaf file list locally by the search query (#1693)', async () => {
    renderTree({ breadcrumb: ['books', 'war'] });
    const searchInput = screen.getByTestId('datalake-search').querySelector('input')!;
    await userEvent.type(searchInput, 'a-war');
    expect(screen.getByTestId('datalake-file-f2')).toBeTruthy();
    expect(screen.queryByTestId('datalake-file-f1')).toBeNull();
  });

  it('sorts bracket-prefixed names by category then title, not the raw leading "["', () => {
    const bracketed = [
      file('b1', '[Marketing] Zebra Plan.md', ['briefs:x']),
      file('b2', '[Marketing] Apple Plan.md', ['briefs:x']),
      file('b3', '[Sales] Intro.md', ['briefs:x']),
    ];
    renderTree({ breadcrumb: ['briefs', 'x'], articles: bracketed });
    const files = screen.getAllByTestId(/^datalake-file-/).map(el => el.dataset.testid);
    // Marketing group (Apple before Zebra within it) sorts before Sales - a raw-name sort would
    // instead interleave/tiebreak on the shared "[" and give a different, meaningless order.
    expect(files).toEqual(['datalake-file-b2', 'datalake-file-b1', 'datalake-file-b3']);
  });
});

describe('DataLakeTreeView back row', () => {
  it('is absent at root', () => {
    renderTree();
    expect(screen.queryByTestId('datalake-back')).toBeNull();
  });

  it('never calls humanize at root breadcrumb', () => {
    const humanizeSpy = vi.fn(() => 'x');
    const spyChrome: DataLakeTreeChrome = {
      ...testChrome,
      humanize: humanizeSpy,
    };
    renderTree({ chrome: spyChrome });
    expect(screen.queryByTestId('datalake-back')).toBeNull();
    expect(humanizeSpy).not.toHaveBeenCalled();
  });

  it('never calls humanize at depth 1 either (allCategoriesLabel path, not humanize(parent))', () => {
    const humanizeSpy = vi.fn(() => 'x');
    const spyChrome: DataLakeTreeChrome = {
      ...testChrome,
      humanize: humanizeSpy,
    };
    renderTree({ breadcrumb: ['books'], chrome: spyChrome });
    expect(screen.getByTestId('datalake-back').textContent).toBe('All Categories');
    expect(humanizeSpy).not.toHaveBeenCalled();
  });

  it('labels depth-1 with allCategoriesLabel and deeper with the humanized parent', () => {
    const first = renderTree({ breadcrumb: ['books'] });
    expect(screen.getByTestId('datalake-back').textContent).toBe('All Categories');
    first.unmount();
    const { onNavigate } = renderTree({ breadcrumb: ['books', 'war'] });
    expect(screen.getByTestId('datalake-back').textContent).toBe('books@0');
    fireEvent.click(screen.getByTestId('datalake-back'));
    expect(onNavigate).toHaveBeenCalledWith(['books']);
  });

  it('renders sticky-back inside the scroll pane when chrome.stickyBackSx is set', () => {
    const stickyChrome: DataLakeTreeChrome = {
      ...testChrome,
      stickyBackSx: { position: 'sticky', top: 0 },
    };
    const { onNavigate } = renderTree({ breadcrumb: ['books'], chrome: stickyChrome });
    const backBtn = screen.getByTestId('datalake-back');
    expect(backBtn.textContent).toBe('All Categories');
    fireEvent.click(backBtn);
    expect(onNavigate).toHaveBeenCalledWith([]);

    // Sticky chrome: the back row shares the scroll pane (the Box wrapping the node <ul>)
    // with the node rows - it is a descendant of that same container.
    const scrollPane = screen.getByTestId('datalake-node-war').closest('ul')!.parentElement!;
    expect(scrollPane.contains(screen.getByTestId('datalake-back'))).toBe(true);
  });

  it('keeps the back row outside the scroll pane under default chrome (no stickyBackSx)', () => {
    renderTree({ breadcrumb: ['books'] });
    // Default chrome renders the back row as a preceding sibling of the scroll pane, so it
    // is NOT contained within it - the inverse of the sticky-chrome case above.
    const scrollPane = screen.getByTestId('datalake-node-war').closest('ul')!.parentElement!;
    expect(scrollPane.contains(screen.getByTestId('datalake-back'))).toBe(false);
  });
});

describe('DataLakeTreeView states', () => {
  it('shows the chrome error label on error', () => {
    renderTree({ isError: true });
    expect(screen.getByTestId('datalake-error').textContent).toContain('Failed to load articles');
  });

  it('shows skeletons while loading', () => {
    const { container } = renderTree({ isLoading: true });
    expect(container.querySelectorAll('.MuiSkeleton-root').length).toBeGreaterThan(0);
  });
});

describe('DataLakeTreeView uncategorized bucket', () => {
  const loose = [file('u1', 'loose.md', ['datalake:mine'])];
  const uncategorized = {
    files: loose,
    renderRow: (count: number, onOpen: () => void) => (
      <ListItem key={UNCATEGORIZED_KEY}>
        <ListItemButton data-testid="datalake-node-uncategorized" onClick={onOpen}>
          Uncategorized ({count})
        </ListItemButton>
      </ListItem>
    ),
  };

  it('renders the bucket row at root and hides it while searching', async () => {
    renderTree({ uncategorized });
    expect(screen.getByTestId('datalake-node-uncategorized').textContent).toBe('Uncategorized (1)');
    const searchInput = screen.getByTestId('datalake-search').querySelector('input')!;
    await userEvent.type(searchInput, 'x');
    expect(screen.queryByTestId('datalake-node-uncategorized')).toBeNull();
    // The bucket is the only root content once searching hides it: no other node matches
    // "x" either, so the empty state must re-show rather than leave a blank pane.
    expect(screen.getByText('No matches')).toBeTruthy();
  });

  it('opens the bucket via the synthetic breadcrumb key and lists its files', () => {
    const { onNavigate } = renderTree({ uncategorized });
    fireEvent.click(screen.getByTestId('datalake-node-uncategorized'));
    expect(onNavigate).toHaveBeenCalledWith([UNCATEGORIZED_KEY]);
    const opened = renderTree({ uncategorized, breadcrumb: [UNCATEGORIZED_KEY] });
    expect(opened.getAllByTestId(/^datalake-file-/).map(el => el.dataset.testid)).toEqual(['datalake-file-u1']);
  });

  it('suppresses the node empty-state while the bucket is visible at an empty root', () => {
    renderTree({ uncategorized, tree: [] });
    expect(screen.queryByText('No categories')).toBeNull();
    expect(screen.getByTestId('datalake-node-uncategorized')).toBeTruthy();
  });
});

describe('DataLakeTreeView cross-tree article search (#1693)', () => {
  const deepMatch = file('s1', 'Deep Match.md', ['zebra:x']);

  it("searches article titles across the whole tree (not just this level's segment names), given a source", async () => {
    mockGetDataLakeArticles.mockImplementation((params: { search?: string } | null) =>
      params?.search === 'deep'
        ? { data: { data: [deepMatch] }, isLoading: false }
        : { data: undefined, isLoading: false }
    );
    renderTree({ source: 'datalakes' });
    const searchInput = screen.getByTestId('datalake-search').querySelector('input')!;
    await userEvent.type(searchInput, 'deep');
    await waitFor(() => expect(screen.getByTestId('datalake-search-articles')).toBeTruthy());
    expect(screen.getByTestId('datalake-file-s1')).toBeTruthy();
  });

  it('shows a loading spinner in the search box while a cross-tree search is in flight', async () => {
    mockGetDataLakeArticles.mockImplementation((params: { search?: string } | null) =>
      params?.search === 'deep' ? { data: undefined, isLoading: true } : { data: undefined, isLoading: false }
    );
    const { container } = renderTree({ source: 'datalakes' });
    const searchInput = screen.getByTestId('datalake-search').querySelector('input')!;
    await userEvent.type(searchInput, 'deep');
    await waitFor(() => expect(container.querySelectorAll('.MuiCircularProgress-root').length).toBeGreaterThan(0));
  });

  it('selects a matched article through the normal onSelectFile callback', async () => {
    mockGetDataLakeArticles.mockReturnValue({ data: { data: [deepMatch] }, isLoading: false });
    const { onSelectFile } = renderTree({ source: 'datalakes' });
    const searchInput = screen.getByTestId('datalake-search').querySelector('input')!;
    await userEvent.type(searchInput, 'deep');
    await waitFor(() => expect(screen.getByTestId('datalake-file-s1')).toBeTruthy());
    fireEvent.click(screen.getByTestId('datalake-file-s1'));
    expect(onSelectFile).toHaveBeenCalledWith(deepMatch);
  });

  it('never searches without a source (e.g. a single-lake browser) - stays local-only', async () => {
    renderTree({ source: undefined });
    const searchInput = screen.getByTestId('datalake-search').querySelector('input')!;
    await userEvent.type(searchInput, 'anything');
    await act(() => new Promise(resolve => setTimeout(resolve, 350)));
    for (const call of mockGetDataLakeArticles.mock.calls) {
      expect(call[0]).toBeNull();
    }
  });

  it('does not search below the minimum query length', async () => {
    renderTree({ source: 'datalakes' });
    const searchInput = screen.getByTestId('datalake-search').querySelector('input')!;
    await userEvent.type(searchInput, 'a');
    await act(() => new Promise(resolve => setTimeout(resolve, 350)));
    for (const call of mockGetDataLakeArticles.mock.calls) {
      expect(call[0]).toBeNull();
    }
  });

  it('clears the results immediately on an empty query, without waiting out the debounce', async () => {
    mockGetDataLakeArticles.mockReturnValue({ data: { data: [deepMatch] }, isLoading: false });
    renderTree({ source: 'datalakes' });
    const searchInput = screen.getByTestId('datalake-search').querySelector('input')!;
    await userEvent.type(searchInput, 'deep');
    await waitFor(() => expect(screen.getByTestId('datalake-search-articles')).toBeTruthy());
    await userEvent.clear(searchInput);
    // No debounce wait here - clearing bypasses it, so the stale section must be gone right away.
    expect(screen.queryByTestId('datalake-search-articles')).toBeNull();
  });

  it('clears the results immediately when the query shrinks below the minimum length, without waiting out the debounce', async () => {
    mockGetDataLakeArticles.mockReturnValue({ data: { data: [deepMatch] }, isLoading: false });
    renderTree({ source: 'datalakes' });
    const searchInput = screen.getByTestId('datalake-search').querySelector('input')!;
    await userEvent.type(searchInput, 'deep');
    await waitFor(() => expect(screen.getByTestId('datalake-search-articles')).toBeTruthy());
    await userEvent.clear(searchInput);
    await userEvent.type(searchInput, 'd');
    // No debounce wait here - dropping below MIN_SEARCH_LENGTH bypasses it too, same as clearing.
    expect(screen.queryByTestId('datalake-search-articles')).toBeNull();
  });
});

// "books" is tagged directly on one file AND is the parent of "books:war"/"books:peace" - that
// file would otherwise be unreachable from any breadcrumb path once "books" had children. It
// renders as an ordinary file row mixed into the folder list, not behind a separate route.
describe('DataLakeTreeView own-tagged files mixed into the folder list', () => {
  const directArticles = [...ARTICLES, file('d1', 'own-books.md', ['books'])];
  const directTree = buildTagTree([
    { tag: 'books:war', count: 2 },
    { tag: 'books:peace', count: 1 },
    { tag: 'books', count: 1 },
    { tag: 'news:today', count: 1 },
    { tag: 'zebra:x', count: 5 },
  ]);

  it('lists the directly-tagged file alongside its subfolders, reconciling the branch total', () => {
    renderTree({ tree: directTree, articles: directArticles, breadcrumb: ['books'] });
    expect(screen.getByTestId('datalake-node-war')).toBeTruthy();
    expect(screen.getByTestId('datalake-node-peace')).toBeTruthy();
    expect(screen.getByTestId('datalake-file-d1')).toBeTruthy();
    // Reachable from this one folder: war(2) + peace(1) + d1(1) = 4, matching "books".fileCount.
    const books = directTree[0];
    expect(books.fileCount).toBe(4);
  });

  it('selects the file directly on click - no extra navigation hop', () => {
    const { onNavigate, onSelectFile } = renderTree({
      tree: directTree,
      articles: directArticles,
      breadcrumb: ['books'],
    });
    fireEvent.click(screen.getByTestId('datalake-file-d1'));
    expect(onSelectFile).toHaveBeenCalledWith(directArticles.find(f => f.id === 'd1'));
    expect(onNavigate).not.toHaveBeenCalled();
  });

  it('omits any own-file rows for a branch with none of its own', () => {
    renderTree({ tree: directTree, articles: directArticles, breadcrumb: ['news'] });
    expect(screen.getByTestId('datalake-node-today')).toBeTruthy();
    expect(screen.queryAllByTestId(/^datalake-file-/)).toHaveLength(0);
  });

  it('hides own files while searching, alongside the filtered-out subfolder', async () => {
    renderTree({ tree: directTree, articles: directArticles, breadcrumb: ['books'] });
    const searchInput = screen.getByTestId('datalake-search').querySelector('input')!;
    await userEvent.type(searchInput, 'war');
    expect(screen.getByTestId('datalake-node-war')).toBeTruthy();
    expect(screen.queryByTestId('datalake-node-peace')).toBeNull();
    expect(screen.queryByTestId('datalake-file-d1')).toBeNull();
  });
});
