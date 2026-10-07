// @vitest-environment jsdom
import React from 'react';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, cleanup, act } from '@testing-library/react';
import type { IFabFileDocument } from '@bike4mind/common';

const h = vi.hoisted(() => ({
  getContentFromFabfile: vi.fn(() => Promise.resolve('fetched content')),
}));

vi.mock('@client/app/utils/fabFileUtils', () => ({
  getContentFromFabfile: h.getContentFromFabfile,
}));

vi.mock('@client/app/hooks/useSessionLayout', () => ({
  default: (selector?: (s: { citedPassage: unknown }) => unknown) =>
    selector ? selector({ citedPassage: null }) : { citedPassage: null },
}));

// Shallow: none of these participate in the branch under test (PdfViewer is dynamic()-loaded,
// so it is stubbed out the same way next/dynamic is below).
vi.mock('next/dynamic', () => ({ default: () => () => null }));
vi.mock('react-syntax-highlighter', () => ({ Prism: () => null }));
vi.mock('react-syntax-highlighter/dist/esm/styles/prism', () => ({ oneDark: {} }));
vi.mock('../MarkdownViewer', () => ({
  default: () => <div data-testid="markdown-viewer" />,
  UnmarkedCitedPassage: () => null,
}));
vi.mock('@client/app/components/Charts/MermaidChart', () => ({ default: () => null }));
vi.mock('../TextViewer', () => ({ default: () => null }));
vi.mock('../DOCXViewer', () => ({ default: () => null }));
vi.mock('../CSVViewer', () => ({ default: () => null }));
vi.mock('../JSONViewer', () => ({ default: () => null }));
vi.mock('../XLSXViewer', () => ({ default: () => null }));
vi.mock('../DiffPreview', () => ({ default: () => null }));
vi.mock('../EditFileDialog', () => ({ default: () => null }));
vi.mock('@client/app/components/GenAI/QuestMasterReply', () => ({ default: () => null }));
vi.mock('@client/app/components/Charts/RechartsRenderer', () => ({ default: () => null }));
vi.mock('@client/app/components/Chess/ChessBoard', () => ({ default: () => null }));
vi.mock('@client/app/components/Chess/InteractiveChessBoard', () => ({ default: () => null }));
vi.mock('@client/app/components/common/DownloadMenu', () => ({
  default: () => null,
  downloadFile: vi.fn(),
  copyToClipboard: vi.fn(),
}));
vi.mock('@client/app/components/ProfileModal/ContentPreviewModal', () => ({ default: () => null }));
vi.mock('@client/app/contexts/ApiContext', () => ({ api: { get: vi.fn(), post: vi.fn(), put: vi.fn() } }));

import { FileContent } from '../KnowledgeViewer';

const pdfFile = {
  id: 'file-pdf',
  fileName: 'contract.pdf',
  mimeType: 'application/pdf',
  fileUrl: 'https://files.example.test/contract.pdf',
} as IFabFileDocument;

const markdownFile = {
  id: 'file-md',
  fileName: 'notes.md',
  mimeType: 'text/markdown',
  fileUrl: 'https://files.example.test/notes.md',
} as IFabFileDocument;

const renderFile = async (file: IFabFileDocument) => {
  const result = render(<FileContent file={file} signedUrl={file.fileUrl} fetching={false} />);
  // The (skipped-for-PDF) content fetch is async; let pending microtasks flush.
  await act(async () => {});
  return result;
};

/**
 * #3785 lazily loads unpdf's ~1.6 MB pdf.js bundle inside getContentFromFabfile. The PDF branch
 * of FileContent renders PdfViewer straight off the signed URL and never reads `content`, so
 * calling getContentFromFabfile for a PDF re-downloads the file and parses it on the main thread
 * for nothing. Guards against that regressing silently.
 */
describe('FileContent skips content fetch for PDFs', () => {
  beforeEach(() => {
    h.getContentFromFabfile.mockClear();
  });
  afterEach(() => cleanup());

  it('does NOT call getContentFromFabfile for a PDF', async () => {
    await renderFile(pdfFile);

    expect(h.getContentFromFabfile).not.toHaveBeenCalled();
  });

  it('still calls getContentFromFabfile for a non-PDF file (markdown)', async () => {
    await renderFile(markdownFile);

    expect(h.getContentFromFabfile).toHaveBeenCalledTimes(1);
    expect(h.getContentFromFabfile).toHaveBeenCalledWith(
      expect.objectContaining({ fileUrl: markdownFile.fileUrl, mimeType: 'text/markdown' })
    );
  });
});
