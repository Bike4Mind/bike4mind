import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { CssVarsProvider, extendTheme } from '@mui/joy/styles';
import { ListItem, ListItemButton } from '@mui/joy';
import { getThemeConfig } from '@client/app/utils/themes';
import type { IFabFileDocument } from '@bike4mind/common';
import { buildTagTree } from '@client/app/components/Files/Browser/TagView/parseTagNamespace';
import DataLakeTreeView, { UNCATEGORIZED_KEY, type DataLakeTreeChrome } from './DataLakeTreeView';

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
  backRowPlacement: 'above',
  scrollSx: {},
  nodeListSx: {},
  fileListSx: {},
  renderNodeRow: (node, _depth, onOpen) => (
    <ListItem>
      <ListItemButton data-testid={`datalake-node-${node.segment}`} onClick={onOpen}>
        {node.segment} ({node.fileCount})
      </ListItemButton>
    </ListItem>
  ),
  renderFileRow: (file, selected, onSelect) => (
    <ListItem>
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

const renderTree = (over: Partial<React.ComponentProps<typeof DataLakeTreeView>> = {}) => {
  const onNavigate = vi.fn();
  const onSelectFile = vi.fn();
  const utils = render(
    <DataLakeTreeView
      tree={TREE}
      articles={ARTICLES}
      breadcrumb={[]}
      onNavigate={onNavigate}
      selectedFileId={null}
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
    renderTree({ breadcrumb: ['books', 'war'], selectedFileId: 'f1' });
    expect(screen.getByTestId('datalake-file-f1').dataset.selected).toBe('true');
    expect(screen.getByTestId('datalake-file-f2').dataset.selected).toBe('false');
  });

  it('shows the chrome empty-files label at an empty leaf', () => {
    renderTree({ breadcrumb: ['books', 'war'], articles: [] });
    expect(screen.getByText('No articles found')).toBeTruthy();
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

  it('renders sticky-back inside the scroll pane when chrome.backRowPlacement is sticky', () => {
    const stickyChrome: DataLakeTreeChrome = {
      ...testChrome,
      backRowPlacement: 'sticky',
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

  it('keeps the back row outside the scroll pane when chrome.backRowPlacement is above', () => {
    renderTree({ breadcrumb: ['books'] });
    // Default chrome (backRowPlacement: 'above') renders the back row as a preceding sibling
    // of the scroll pane, so it is NOT contained within it - the inverse of the sticky case.
    const scrollPane = screen.getByTestId('datalake-node-war').closest('ul')!.parentElement!;
    expect(scrollPane.contains(screen.getByTestId('datalake-back'))).toBe(false);
  });

  it('alwaysShowBackRow renders the back row even at an empty breadcrumb, as an exit control', () => {
    const { onNavigate } = renderTree({ breadcrumb: [], alwaysShowBackRow: true });
    const backBtn = screen.getByTestId('datalake-back');
    expect(backBtn.textContent).toBe('All Categories');
    fireEvent.click(backBtn);
    // Popping an empty breadcrumb (slice(0, -1) of []) is still [] - the host's onNavigate([])
    // is what drives the actual exit.
    expect(onNavigate).toHaveBeenCalledWith([]);
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
      <ListItem>
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

describe('DataLakeTreeView v2 contract', () => {
  it('controlled search/sort: uses the props and reports changes instead of internal state', () => {
    const onSearchChange = vi.fn();
    const onSortChange = vi.fn();
    renderTree({ search: 'new', onSearchChange, sort: 'alpha', onSortChange });
    // 'new' filters to the news node; alpha mode is active on the toggle
    expect(screen.queryByTestId('datalake-node-books')).toBeNull();
    expect(screen.getByTestId('datalake-node-news')).toBeTruthy();
    expect(screen.getByTestId('datalake-sort-toggle').dataset.sort).toBe('alpha');
    fireEvent.change(screen.getByTestId('datalake-search').querySelector('input')!, { target: { value: 'x' } });
    expect(onSearchChange).toHaveBeenCalledWith('x');
    fireEvent.click(screen.getByTestId('datalake-sort-toggle'));
    expect(onSortChange).toHaveBeenCalledWith('count');
    // still controlled: the visible filter did not change on its own
    expect(screen.queryByTestId('datalake-node-books')).toBeNull();
  });

  it('uncontrolled search with only onSearchChange: reports the change AND still filters locally', async () => {
    // A host that passes onSearchChange without `search` must not lose typing (finding 2):
    // internal state has to keep driving the filter even though the callback also fires.
    const onSearchChange = vi.fn();
    renderTree({ onSearchChange });
    const searchInput = screen.getByTestId('datalake-search').querySelector('input')!;
    await userEvent.type(searchInput, 'new');
    expect(onSearchChange).toHaveBeenCalledWith('new');
    expect(screen.queryByTestId('datalake-node-books')).toBeNull();
    expect(screen.getByTestId('datalake-node-news')).toBeTruthy();
  });

  it('hideToolbar renders no search input', () => {
    renderTree({ hideToolbar: true });
    expect(screen.queryByTestId('datalake-search')).toBeNull();
    expect(screen.getByTestId('datalake-node-books')).toBeTruthy();
  });

  it('leafMinDepth keeps the folder view at the seeded root and starts leaves below it', () => {
    // tree has depth-1 'books' with children war/peace; seed the path at ['books'] with
    // leafMinDepth 1: 'books' is the ROOT here, so even though searching yields nodes,
    // an empty currentNodes at ['books'] must NOT flip to a file list.
    const { onNavigate } = renderTree({ breadcrumb: ['books'], leafMinDepth: 1 });
    expect(screen.getByTestId('datalake-node-war')).toBeTruthy(); // folder view at seeded root
    fireEvent.click(screen.getByTestId('datalake-node-war'));
    expect(onNavigate).toHaveBeenCalledWith(['books', 'war']);
    // below the seed, an empty node level IS a leaf: files of books:war render
    const leaf = renderTree({ breadcrumb: ['books', 'war'], leafMinDepth: 1 });
    expect(leaf.getAllByTestId(/^datalake-file-/).length).toBeGreaterThan(0);
  });

  it('leafMinDepth gates the bucket at the seeded root and the synthetic key works at depth', () => {
    const loose = [file('u1', 'loose.md', ['datalake:mine'])];
    const uncategorized = {
      files: loose,
      renderRow: (count: number, onOpen: () => void) => (
        <ListItem>
          <ListItemButton data-testid="datalake-node-uncategorized" onClick={onOpen}>
            Uncategorized ({count})
          </ListItemButton>
        </ListItem>
      ),
    };
    const { onNavigate } = renderTree({ breadcrumb: ['books'], leafMinDepth: 1, uncategorized });
    fireEvent.click(screen.getByTestId('datalake-node-uncategorized'));
    expect(onNavigate).toHaveBeenCalledWith(['books', UNCATEGORIZED_KEY]);
    const opened = renderTree({ breadcrumb: ['books', UNCATEGORIZED_KEY], leafMinDepth: 1, uncategorized });
    expect(opened.getAllByTestId(/^datalake-file-/).map(el => el.dataset.testid)).toEqual(['datalake-file-u1']);
  });

  it('testIds overrides rename the container and error nodes', () => {
    renderTree({ isError: true, testIds: { container: 'datalake-manager-tree', error: 'datalake-manager-error' } });
    expect(screen.getByTestId('datalake-manager-tree')).toBeTruthy();
    expect(screen.getByTestId('datalake-manager-error')).toBeTruthy();
    expect(screen.queryByTestId('datalake-tree')).toBeNull();
  });
});
