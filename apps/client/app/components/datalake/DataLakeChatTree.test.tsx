import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { CssVarsProvider, extendTheme } from '@mui/joy/styles';
import { getThemeConfig } from '@client/app/utils/themes';
import type { IFabFileDocument } from '@bike4mind/common';
import DataLakeChatTree from './DataLakeChatTree';

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
  selectedFileId: null,
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
  it('file rows are not buttons: clicking the row triggers no action', () => {
    const onAttachFile = vi.fn();
    const onViewFile = vi.fn();
    renderTree({ onAttachFile, onViewFile });
    fireEvent.click(screen.getByTestId('datalake-file-f1'));
    expect(onAttachFile).not.toHaveBeenCalled();
    expect(onViewFile).not.toHaveBeenCalled();
    // No ListItemButton semantics on the row itself.
    expect(screen.getByTestId('datalake-file-f1').closest('[role="button"]')).toBeNull();
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
