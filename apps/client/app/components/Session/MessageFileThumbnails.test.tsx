import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { CssVarsProvider, extendTheme } from '@mui/joy/styles';
import type { IFabFileDocument } from '@bike4mind/common';
import { getThemeConfig } from '@client/app/utils/themes';
import { MessageFileThumbnails } from './MessageFileThumbnails';

vi.mock('@client/app/hooks/data/settings', () => ({ useGetSettingsValue: () => undefined }));

const { renderPdfFirstPage } = vi.hoisted(() => ({ renderPdfFirstPage: vi.fn() }));
vi.mock('@client/app/utils/renderPdfFirstPage', () => ({ renderPdfFirstPage }));

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

  it('explains a failed image in a tooltip on its error mark', async () => {
    renderTiles([
      {
        fabFile: file('err', 'paste.png', 'image/png', 3),
        status: 'error',
        uploadProgress: 0,
        errorMessage: 'Storage is full',
      },
    ]);
    fireEvent.mouseOver(screen.getByTestId('message-file-error-err'));
    expect(await screen.findByRole('tooltip')).toHaveTextContent('Storage is full');
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

  describe('document previews', () => {
    beforeEach(() => {
      renderPdfFirstPage.mockReset().mockResolvedValue(document.createElement('canvas'));
    });

    const pdfFile = new File(['%PDF-1.7'], 'q3-report.pdf', { type: 'application/pdf' });

    it('draws a PDF as a square with its type badge, and names it on hover', async () => {
      renderTiles([
        {
          fabFile: file('pdf', 'q3-report.pdf', 'application/pdf', 8),
          status: 'complete',
          uploadProgress: 100,
          localFile: pdfFile,
        },
      ]);
      const tile = screen.getByTestId('message-file-thumbnail-pdf');
      expect(screen.getByTestId('message-file-local-preview')).toHaveAttribute('data-preview-kind', 'pdf');
      expect(tile).toHaveTextContent('PDF');
      expect(tile).toHaveAttribute('title', 'q3-report.pdf');
      await waitFor(() => expect(renderPdfFirstPage).toHaveBeenCalledWith(pdfFile, 100, expect.any(AbortSignal)));
    });

    it('falls back to the document chip when the PDF cannot be drawn', async () => {
      renderPdfFirstPage.mockRejectedValue(new Error('bad pdf'));
      renderTiles([
        {
          fabFile: file('pdf', 'q3-report.pdf', 'application/pdf', 8),
          status: 'complete',
          uploadProgress: 100,
          localFile: pdfFile,
        },
      ]);
      await waitFor(() => expect(screen.queryByTestId('message-file-local-preview')).toBeNull());
      expect(screen.getByTestId('message-file-thumbnail-pdf')).toHaveTextContent('PDF \u00b7 8 B');
    });

    it('keeps the drawn preview when the upload resolves and the temp id becomes the server id', async () => {
      const tiles = (id: string, status: 'uploading' | 'complete') => (
        <CssVarsProvider theme={appTheme}>
          <MessageFileThumbnails
            files={[
              {
                fabFile: file(id, 'q3-report.pdf', 'application/pdf', 8),
                status,
                uploadProgress: status === 'complete' ? 100 : 50,
                localFile: pdfFile,
                clientId: 'temp-1',
              },
            ]}
            onRemove={vi.fn()}
          />
        </CssVarsProvider>
      );
      const { rerender } = render(tiles('temp-1', 'uploading'));
      await waitFor(() => expect(renderPdfFirstPage).toHaveBeenCalledOnce());

      rerender(tiles('f1', 'complete'));

      expect(screen.getByTestId('message-file-thumbnail-f1')).toBeInTheDocument();
      expect(renderPdfFirstPage).toHaveBeenCalledOnce();
    });

    it('names a failed PDF only through its error tooltip', () => {
      renderTiles([
        {
          fabFile: file('pdf', 'q3-report.pdf', 'application/pdf', 8),
          status: 'error',
          uploadProgress: 0,
          localFile: pdfFile,
          errorMessage: 'Network error',
        },
      ]);
      expect(screen.getByTestId('message-file-thumbnail-pdf')).not.toHaveAttribute('title');
    });

    it('shows the opening lines of a text or code file', async () => {
      const code = new File(['<!doctype html>\n<h1>Hello</h1>'], 'index.html', { type: 'text/html' });
      renderTiles([
        {
          fabFile: file('html', 'index.html', 'text/html', 30),
          status: 'complete',
          uploadProgress: 100,
          localFile: code,
        },
      ]);
      expect(await screen.findByText(/<h1>Hello<\/h1>/)).toBeInTheDocument();
      expect(screen.getByTestId('message-file-thumbnail-html')).toHaveTextContent('HTML');
    });

    it('previews a video by its local type even when the server filed it as audio', () => {
      URL.createObjectURL = vi.fn(() => 'blob:clip');
      URL.revokeObjectURL = vi.fn();
      const clip = new File(['webm'], 'clip.webm', { type: 'video/webm' });
      renderTiles([
        {
          fabFile: file('vid', 'clip.webm', 'audio/webm', 4),
          status: 'complete',
          uploadProgress: 100,
          localFile: clip,
        },
      ]);
      expect(screen.getByTestId('message-file-local-preview')).toHaveAttribute('data-preview-kind', 'video');
    });

    it('keeps a chip for formats with no in-browser preview', () => {
      const docx = new File(['PK'], 'contract.docx', {
        type: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      });
      renderTiles([
        {
          fabFile: file('docx', 'contract.docx', docx.type, 2),
          status: 'complete',
          uploadProgress: 100,
          localFile: docx,
        },
      ]);
      expect(screen.queryByTestId('message-file-local-preview')).toBeNull();
      expect(screen.getByTestId('message-file-thumbnail-docx')).toHaveTextContent('contract.docx');
    });
  });

  describe('local image preview', () => {
    const localFile = new File(['png'], 'paste.png', { type: 'image/png' });

    beforeEach(() => {
      URL.createObjectURL = vi.fn(() => 'blob:local-paste');
      URL.revokeObjectURL = vi.fn();
    });

    it('shows the pasted image while it uploads and is scanned', () => {
      renderTiles([
        { fabFile: file('up', 'paste.png', 'image/png', 3), status: 'uploading', uploadProgress: 40, localFile },
        { fabFile: file('scan', 'paste.png', 'image/png', 3), status: 'scanning', uploadProgress: 100, localFile },
      ]);
      const previews = screen.getAllByTestId('message-file-local-preview');
      expect(previews).toHaveLength(2);
      expect(previews[0].querySelector('img')).toHaveAttribute('src', 'blob:local-paste');
      expect(screen.getByTestId('message-file-progress-up')).toBeInTheDocument();
    });

    it('keeps the local copy under the error mark when the image fails', () => {
      renderTiles([
        { fabFile: file('err', 'paste.png', 'image/png', 3), status: 'error', uploadProgress: 0, localFile },
      ]);
      expect(screen.getByTestId('message-file-local-preview')).toBeInTheDocument();
      expect(screen.queryByTestId('image-moderation-scanning')).toBeNull();
    });

    it('drops the local copy once the image is attached', () => {
      renderTiles([
        { fabFile: file('done', 'paste.png', 'image/png', 3), status: 'complete', uploadProgress: 100, localFile },
      ]);
      expect(screen.queryByTestId('message-file-local-preview')).toBeNull();
    });

    it('revokes the object URL when the tile goes away', () => {
      const { unmount } = render(
        <CssVarsProvider theme={appTheme}>
          <MessageFileThumbnails
            files={[
              { fabFile: file('up', 'paste.png', 'image/png', 3), status: 'uploading', uploadProgress: 0, localFile },
            ]}
            onRemove={vi.fn()}
          />
        </CssVarsProvider>
      );
      unmount();
      expect(URL.revokeObjectURL).toHaveBeenCalledWith('blob:local-paste');
    });
  });
});
