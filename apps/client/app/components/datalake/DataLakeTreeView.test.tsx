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

// books:war (2 files), books:peace (1), news:today (1)
const ARTICLES = [
  file('f1', 'b-war-one.md', ['books:war']),
  file('f2', 'a-war-two.md', ['books:war']),
  file('f3', 'peace.md', ['books:peace']),
  file('f4', 'today.md', ['news:today']),
];
const TREE = buildTagTree([
  { tag: 'books:war', count: 2 },
  { tag: 'books:peace', count: 1 },
  { tag: 'news:today', count: 1 },
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
    expect(nodes()).toEqual(['datalake-node-books', 'datalake-node-news']);
    fireEvent.click(screen.getByTestId('datalake-sort-toggle'));
    // alpha: books < news (same order here); assert the mode flag flipped
    expect(screen.getByTestId('datalake-sort-toggle').dataset.sort).toBe('alpha');
  });

  it('search filters segments and shows No matches when nothing survives', async () => {
    renderTree();
    const searchInput = screen.getByTestId('datalake-search').querySelector('input');
    if (searchInput) {
      await userEvent.type(searchInput, 'new');
      expect(screen.queryByTestId('datalake-node-books')).toBeNull();
      expect(screen.getByTestId('datalake-node-news')).toBeTruthy();
      await userEvent.clear(searchInput);
      await userEvent.type(searchInput, 'zzz');
      expect(screen.getByText('No matches')).toBeTruthy();
    }
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

  it('labels depth-1 with allCategoriesLabel and deeper with the humanized parent', () => {
    const first = renderTree({ breadcrumb: ['books'] });
    expect(screen.getByTestId('datalake-back').textContent).toBe('All Categories');
    first.unmount();
    const { onNavigate } = renderTree({ breadcrumb: ['books', 'war'] });
    expect(screen.getByTestId('datalake-back').textContent).toBe('books@0');
    fireEvent.click(screen.getByTestId('datalake-back'));
    expect(onNavigate).toHaveBeenCalledWith(['books']);
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
    const searchInput = screen.getByTestId('datalake-search').querySelector('input');
    if (searchInput) {
      await userEvent.type(searchInput, 'x');
      expect(screen.queryByTestId('datalake-node-uncategorized')).toBeNull();
    }
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
