import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { CssVarsProvider, extendTheme } from '@mui/joy/styles';
import type { IFabFileDocument } from '@bike4mind/common';
import { getThemeConfig } from '@client/app/utils/themes';
import { MessageFileThumbnails } from './MessageFileThumbnails';

vi.mock('@client/app/hooks/data/settings', () => ({ useGetSettingsValue: () => undefined }));

const appTheme = extendTheme({ ...getThemeConfig() });

const file = (id: string, fileName: string, mimeType: string, fileSize: number) =>
  ({ id, fileName, mimeType, fileSize, moderationStatus: 'clean' }) as unknown as IFabFileDocument;

const renderTiles = (
  files: React.ComponentProps<typeof MessageFileThumbnails>['files'],
  onRemove = vi.fn(),
  onClick = vi.fn()
) => {
  render(
    <CssVarsProvider theme={appTheme}>
      <MessageFileThumbnails files={files} onRemove={onRemove} onClick={onClick} />
    </CssVarsProvider>
  );
  return { onRemove, onClick };
};

describe('MessageFileThumbnails', () => {
  it('renders nothing without files', () => {
    renderTiles([]);
    expect(screen.queryByTestId('message-file-thumbnails')).toBeNull();
  });

  it('labels a document with its name, type and size', () => {
    renderTiles([
      { fabFile: file('pdf', 'q3-report.pdf', 'application/pdf', 1_250_000), status: 'complete', uploadProgress: 100 },
    ]);
    const tile = screen.getByTestId('message-file-thumbnail-pdf');
    expect(tile).toHaveTextContent('q3-report.pdf');
    expect(tile).toHaveTextContent('PDF \u00b7 1.2 MB');
  });

  it('says a failed upload failed', () => {
    renderTiles([{ fabFile: file('err', 'broken.txt', 'text/plain', 900), status: 'error', uploadProgress: 0 }]);
    expect(screen.getByTestId('message-file-thumbnail-err')).toHaveTextContent('Upload failed');
  });

  it('shows upload progress and opens only finished files', () => {
    const { onClick } = renderTiles([
      { fabFile: file('up', 'contract.docx', 'application/msword', 48_000), status: 'uploading', uploadProgress: 70 },
    ]);
    expect(screen.getByTestId('message-file-progress-up')).toBeInTheDocument();
    fireEvent.click(screen.getByTestId('message-file-thumbnail-up'));
    expect(onClick).not.toHaveBeenCalled();
  });

  it('removes a file without opening it', () => {
    const { onRemove, onClick } = renderTiles([
      { fabFile: file('pdf', 'q3-report.pdf', 'application/pdf', 1_250_000), status: 'complete', uploadProgress: 100 },
    ]);
    fireEvent.click(screen.getByTestId('remove-message-file-pdf'));
    expect(onRemove).toHaveBeenCalledWith('pdf');
    expect(onClick).not.toHaveBeenCalled();
  });
});
