import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { CssVarsProvider, extendTheme } from '@mui/joy/styles';
import { getThemeConfig } from '@client/app/utils/themes';
import type { IFabFileDocument } from '@bike4mind/common';
import DataLakeChatTree from './DataLakeChatTree';

// DataLakeChatTree's underlying DataLakeTreeView always calls this (cross-tree search, #1693);
// no `source` is passed in these tests so the query stays disabled, but the hook itself still
// needs a stub since these tests render without a QueryClientProvider.
vi.mock('@client/app/hooks/data/dataLakes', () => ({
  useGetDataLakeArticles: () => ({ data: undefined, isLoading: false }),
}));

const appTheme = extendTheme({ ...getThemeConfig() });

const article = {
  id: 'f1',
  fileName: 'Deep Work.pdf',
  tags: [{ name: 'books' }, { name: 'datalake:lake-a' }],
} as unknown as IFabFileDocument;

// breadcrumb ['books'] with an empty tree resolves to a leaf tag, so the file list renders.
const baseProps = {
  tree: [],
  articles: [article],
  breadcrumb: ['books'],
  onNavigate: vi.fn(),
  selectedFileIds: new Set<string>(),
  isLoading: false,
  onAttachFile: vi.fn(),
  onViewFile: vi.fn(),
  canDeleteFile: () => true,
  onDeleteFile: vi.fn(),
};

const renderTree = (props: Partial<React.ComponentProps<typeof DataLakeChatTree>> = {}) =>
  render(
    <CssVarsProvider theme={appTheme}>
      <DataLakeChatTree {...baseProps} {...props} />
    </CssVarsProvider>
  );

describe('DataLakeChatTree file-row actions', () => {
  it('clicking a file row runs the View action and nothing else', () => {
    const onAttachFile = vi.fn();
    const onViewFile = vi.fn();
    const onDeleteFile = vi.fn();
    renderTree({ onAttachFile, onViewFile, onDeleteFile });
    fireEvent.click(screen.getByTestId('datalake-file-f1'));
    expect(onViewFile).toHaveBeenCalledWith(expect.objectContaining({ id: 'f1' }));
    expect(onAttachFile).not.toHaveBeenCalled();
    expect(onDeleteFile).not.toHaveBeenCalled();
  });

  it('opening the actions menu does not also run the row View', () => {
    const onViewFile = vi.fn();
    renderTree({ onViewFile });
    fireEvent.click(screen.getByTestId('datalake-row-menu-btn-f1'));
    // The trigger sits inside the row, so without stopPropagation this would open the file too.
    expect(onViewFile).not.toHaveBeenCalled();
  });

  it('the three-dots menu is the only direct row control', () => {
    renderTree();
    expect(screen.getByTestId('datalake-row-menu-btn-f1')).toBeInTheDocument();
    // No standalone action buttons outside the menu.
    expect(screen.queryByTestId('datalake-attach-btn-f1')).toBeNull();
    expect(screen.queryByTestId('datalake-delete-btn-f1')).toBeNull();
  });

  it('the menu trigger is frameless, not Joy MenuButton default outlined', () => {
    renderTree();
    // Joy's variant modifier classes are a stable public API (unlike its emotion hashes).
    // MenuButton emits its own variant class, so its outlined default would paint a border and
    // a hover fill on top of the plain IconButton slot.
    const trigger = screen.getByTestId('datalake-row-menu-btn-f1');
    expect(trigger.className).toMatch(/MuiMenuButton-variantPlain/);
    expect(trigger.className).not.toMatch(/variantOutlined/);
  });

  it('Add to chat lives in the row menu and calls onAttachFile', () => {
    const onAttachFile = vi.fn();
    renderTree({ onAttachFile });
    fireEvent.click(screen.getByTestId('datalake-row-menu-btn-f1'));
    fireEvent.click(screen.getByTestId('datalake-attach-item-f1'));
    expect(onAttachFile).toHaveBeenCalledWith(expect.objectContaining({ id: 'f1' }));
  });

  it('Remove shows in the menu only when canDeleteFile allows, and calls onDeleteFile', () => {
    const onDeleteFile = vi.fn();
    renderTree({ onDeleteFile });
    fireEvent.click(screen.getByTestId('datalake-row-menu-btn-f1'));
    fireEvent.click(screen.getByTestId('datalake-delete-item-f1'));
    expect(onDeleteFile).toHaveBeenCalledWith(expect.objectContaining({ id: 'f1' }));
  });

  it('hides the Remove item when canDeleteFile returns false', () => {
    renderTree({ canDeleteFile: () => false });
    fireEvent.click(screen.getByTestId('datalake-row-menu-btn-f1'));
    expect(screen.queryByTestId('datalake-delete-item-f1')).toBeNull();
    // The other menu items stay.
    expect(screen.getByTestId('datalake-attach-item-f1')).toBeInTheDocument();
    expect(screen.getByTestId('datalake-view-item-f1')).toBeInTheDocument();
  });

  it('View lives in the row menu and calls onViewFile', () => {
    const onViewFile = vi.fn();
    renderTree({ onViewFile });
    fireEvent.click(screen.getByTestId('datalake-row-menu-btn-f1'));
    fireEvent.click(screen.getByTestId('datalake-view-item-f1'));
    expect(onViewFile).toHaveBeenCalledWith(expect.objectContaining({ id: 'f1' }));
  });
});

describe('DataLakeChatTree chrome slots (#1943)', () => {
  it('gives Create the primary treatment and Manage the secondary one', () => {
    renderTree({ onManage: vi.fn(), onCreateLake: vi.fn() });

    // Joy's variant/color modifier classes are a stable public API (unlike its emotion
    // hashes), so they are the only way to assert visual hierarchy without a snapshot.
    const createBtn = screen.getByTestId('datalake-create-btn');
    expect(createBtn.className).toMatch(/MuiButton-variantSolid/);
    expect(createBtn.className).toMatch(/MuiButton-colorPrimary/);

    const manageBtn = screen.getByTestId('datalake-manage-btn');
    expect(manageBtn.className).toMatch(/MuiButton-variantOutlined/);
    expect(manageBtn.className).toMatch(/MuiButton-colorNeutral/);
  });

  it('wires each footer button to its own handler', () => {
    const onManage = vi.fn();
    const onCreateLake = vi.fn();
    renderTree({ onManage, onCreateLake });

    fireEvent.click(screen.getByTestId('datalake-create-btn'));
    expect(onCreateLake).toHaveBeenCalledTimes(1);
    expect(onManage).not.toHaveBeenCalled();

    fireEvent.click(screen.getByTestId('datalake-manage-btn'));
    expect(onManage).toHaveBeenCalledTimes(1);
  });

  it('advertises drag-to-ingest at rest, which the drop overlay alone cannot do', () => {
    renderTree({ dropHint: 'Drag files here to add' });
    expect(screen.getByTestId('datalake-drop-hint')).toHaveTextContent(/drag files here to add/i);
  });

  it('renders the sub-header between the title bar and the search toolbar', () => {
    renderTree({ subHeader: <div data-testid="sub-header" /> });

    const subHeader = screen.getByTestId('sub-header');
    const search = screen.getByTestId('datalake-search');
    expect(subHeader.compareDocumentPosition(search) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it('prefers the host empty slot over the bare "No categories" line', () => {
    // Root breadcrumb + empty tree: the node list is empty and nothing is being searched.
    renderTree({ breadcrumb: [], articles: [], emptySlot: <div data-testid="host-empty" /> });

    expect(screen.getByTestId('host-empty')).toBeInTheDocument();
    expect(screen.queryByText('No categories')).not.toBeInTheDocument();
  });

  it('keeps "No matches" over the empty slot while searching - that is a fact about the query', () => {
    renderTree({ breadcrumb: [], articles: [], emptySlot: <div data-testid="host-empty" /> });

    // The testid sits on Joy's Input root; the value setter lives on the inner <input>.
    fireEvent.change(screen.getByTestId('datalake-search').querySelector('input')!, {
      target: { value: 'zzz' },
    });

    expect(screen.getByText('No matches')).toBeInTheDocument();
    expect(screen.queryByTestId('host-empty')).not.toBeInTheDocument();
  });
});
