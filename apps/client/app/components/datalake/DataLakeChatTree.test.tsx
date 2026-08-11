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

  it('attach button calls onAttachFile with the file', () => {
    const onAttachFile = vi.fn();
    renderTree({ onAttachFile });
    fireEvent.click(screen.getByTestId('datalake-attach-btn-f1'));
    expect(onAttachFile).toHaveBeenCalledWith(expect.objectContaining({ id: 'f1' }));
  });

  it('delete button shows only when canDeleteFile allows, and calls onDeleteFile', () => {
    const onDeleteFile = vi.fn();
    renderTree({ onDeleteFile });
    fireEvent.click(screen.getByTestId('datalake-delete-btn-f1'));
    expect(onDeleteFile).toHaveBeenCalledWith(expect.objectContaining({ id: 'f1' }));
  });

  it('hides the delete button when canDeleteFile returns false', () => {
    renderTree({ canDeleteFile: () => false });
    expect(screen.queryByTestId('datalake-delete-btn-f1')).toBeNull();
    // The other actions stay.
    expect(screen.getByTestId('datalake-attach-btn-f1')).toBeInTheDocument();
  });

  it('View lives in the row menu and calls onViewFile', () => {
    const onViewFile = vi.fn();
    renderTree({ onViewFile });
    fireEvent.click(screen.getByTestId('datalake-row-menu-btn-f1'));
    fireEvent.click(screen.getByTestId('datalake-view-item-f1'));
    expect(onViewFile).toHaveBeenCalledWith(expect.objectContaining({ id: 'f1' }));
  });
});
