// @vitest-environment jsdom
import React from 'react';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, cleanup, act } from '@testing-library/react';
import type { IFabFileDocument } from '@bike4mind/common';

// Mutable harness state, read by the hoisted module mocks below.
const h = vi.hoisted(() => ({
  content: '' as string,
  citedPassage: null as { fileId: string; chunkId: string; passage: string } | null,
}));

vi.mock('@client/app/utils/fabFileUtils', () => ({
  getContentFromFabfile: vi.fn(() => Promise.resolve(h.content)),
}));

vi.mock('@client/app/hooks/useSessionLayout', () => ({
  default: (selector?: (s: { citedPassage: unknown }) => unknown) =>
    selector ? selector({ citedPassage: h.citedPassage }) : { citedPassage: h.citedPassage },
}));

// Both viewers are stubbed: this file is about WHICH branch FileContent takes and what it hands
// over, not about how either one renders. The real MarkdownViewer is covered separately.
vi.mock('../MarkdownViewer', () => ({
  default: ({ citedPassage }: { citedPassage?: string }) => (
    <div data-testid="markdown-viewer" data-cited-passage={citedPassage ?? ''} />
  ),
  UnmarkedCitedPassage: ({ passage, title }: { passage: string; title: string }) => (
    <div data-testid="markdown-cited-passage-fallback" data-title={title}>
      {passage}
    </div>
  ),
}));
vi.mock('@client/app/components/Charts/MermaidChart', () => ({ default: () => <div data-testid="mermaid" /> }));

// Shallow: none of these participate in the branch under test.
vi.mock('next/dynamic', () => ({ default: () => () => null }));
vi.mock('react-syntax-highlighter', () => ({ Prism: () => null }));
vi.mock('react-syntax-highlighter/dist/esm/styles/prism', () => ({ oneDark: {} }));
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

const MERMAID_DOC = 'graph TD\n  A[Accrual] --> B[Rollover]';
const PASSAGE = 'Holidays accrue monthly.';

const markdownFile = { id: 'file-a', fileName: 'diagram.md', mimeType: 'text/markdown' } as IFabFileDocument;

const renderFile = async (file: IFabFileDocument = markdownFile) => {
  const result = render(<FileContent file={file} signedUrl="https://files.example.test/a.md" fetching={false} />);
  // The content fetch is async; the viewer shows a spinner until it lands.
  await act(async () => {});
  return result;
};

/**
 * FileContent's Mermaid branch returns BEFORE the MarkdownViewer handoff that carries the anchor,
 * and this is the surface a citation chip opens. Without these, deleting the callout from that
 * branch leaves every other suite green while the reader silently loses the cited passage (#3038).
 */
describe('FileContent cited-passage handoff', () => {
  beforeEach(() => {
    h.content = '';
    h.citedPassage = null;
  });
  afterEach(() => cleanup());

  it('shows the passage above a Mermaid document, which has no prose to mark', async () => {
    h.content = MERMAID_DOC;
    h.citedPassage = { fileId: 'file-a', chunkId: 'chunk-1', passage: PASSAGE };

    await renderFile();

    const fallback = screen.getByTestId('markdown-cited-passage-fallback');
    expect(fallback).toHaveTextContent(PASSAGE);
    // Not "no longer found": nothing drifted, a diagram just is not markable.
    expect(fallback.getAttribute('data-title')).toBe('Cited passage');
    expect(screen.getByTestId('mermaid')).toBeInTheDocument();
  });

  it('shows the passage above a FENCED Mermaid document too', async () => {
    h.content = '```mermaid\n' + MERMAID_DOC + '\n```';
    h.citedPassage = { fileId: 'file-a', chunkId: 'chunk-1', passage: PASSAGE };

    await renderFile();

    expect(screen.getByTestId('markdown-cited-passage-fallback')).toHaveTextContent(PASSAGE);
    expect(screen.getByTestId('mermaid')).toBeInTheDocument();
  });

  it('renders a Mermaid document alone when no citation is anchored', async () => {
    h.content = MERMAID_DOC;

    await renderFile();

    expect(screen.getByTestId('mermaid')).toBeInTheDocument();
    expect(screen.queryByTestId('markdown-cited-passage-fallback')).toBeNull();
  });

  it('does NOT show the passage on a Mermaid document anchored to a DIFFERENT file', async () => {
    // The id guard is the only thing stopping an anchor for one document from surfacing in another.
    h.content = MERMAID_DOC;
    h.citedPassage = { fileId: 'other-file', chunkId: 'chunk-1', passage: PASSAGE };

    await renderFile();

    expect(screen.getByTestId('mermaid')).toBeInTheDocument();
    expect(screen.queryByTestId('markdown-cited-passage-fallback')).toBeNull();
  });

  it('hands a prose document to MarkdownViewer to MARK, not to the callout', async () => {
    // The other side of the branch: prose must still take the marking path, so a callout here
    // would mean the Mermaid detection had swallowed an ordinary document.
    h.content = '# Leave policy\n\n' + PASSAGE;
    h.citedPassage = { fileId: 'file-a', chunkId: 'chunk-1', passage: PASSAGE };

    await renderFile();

    expect(screen.getByTestId('markdown-viewer').getAttribute('data-cited-passage')).toBe(PASSAGE);
    expect(screen.queryByTestId('markdown-cited-passage-fallback')).toBeNull();
  });

  it('passes no anchor to MarkdownViewer when the anchor is for another file', async () => {
    h.content = '# Leave policy\n\n' + PASSAGE;
    h.citedPassage = { fileId: 'other-file', chunkId: 'chunk-1', passage: PASSAGE };

    await renderFile();

    expect(screen.getByTestId('markdown-viewer').getAttribute('data-cited-passage')).toBe('');
  });
});
