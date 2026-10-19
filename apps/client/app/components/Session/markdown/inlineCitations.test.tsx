import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { CssVarsProvider, extendTheme } from '@mui/joy/styles';
import ReactMarkdown from 'react-markdown';
import type { CitableSource } from '@bike4mind/common';
import { getThemeConfig } from '@client/app/utils/themes';
import { assistantReplyRemarkPlugins } from '@client/app/utils/remarkPlugins';
import useSessionLayout from '@client/app/hooks/useSessionLayout';
import { CitationInteractionProvider } from '../CitationInteractionContext';
import {
  CITATION_MARKER_TAG,
  CitationMarker,
  citationMarkersLinkable,
  ReplyCitablesContext,
  remarkCitationMarkers,
  resolveCitationMarker,
  shouldLinkCitationMarkers,
} from './inlineCitations';

// The marker link calls useNavigate, which needs a router context we don't set up here.
const navigate = vi.fn();
vi.mock('@tanstack/react-router', () => ({ useNavigate: () => navigate }));

const appTheme = extendTheme({ ...getThemeConfig() });

const lakeCitable = (fileId: string, citationIndex?: number): CitableSource => ({
  id: fileId,
  type: 'document',
  title: `${fileId}.pdf`,
  url: `/opti?mode=datalake&article=${fileId}`,
  status: 'complete',
  metadata: {
    sourceSystem: 'knowledge_base',
    chunkId: `${fileId}-chunk`,
    fullContext: `passage of ${fileId}`,
    ...(citationIndex !== undefined ? { citationIndex } : {}),
  },
});

const webCitable: CitableSource = {
  id: 'https://example.com/paper',
  type: 'web_url',
  title: 'A paper',
  url: 'https://example.com/paper',
  metadata: { citationIndex: 1 },
};

// The production plugin combination from PromptReplies, so GFM, math and line-break nodes
// reach the citation pass the same way they do in a real reply.
const Reply = ({ content, citables }: { content: string; citables: readonly CitableSource[] }) => (
  <CssVarsProvider theme={appTheme}>
    <ReplyCitablesContext.Provider value={citables}>
      <ReactMarkdown
        components={{ [CITATION_MARKER_TAG]: CitationMarker }}
        remarkPlugins={[...assistantReplyRemarkPlugins, remarkCitationMarkers]}
      >
        {content}
      </ReactMarkdown>
    </ReplyCitablesContext.Provider>
  </CssVarsProvider>
);

const markerLinks = () => screen.queryAllByTestId('citation-marker-link');

describe('citationMarkersLinkable', () => {
  it('holds only when every citable carries the stamp of its own position', () => {
    expect(citationMarkersLinkable([lakeCitable('a', 1), lakeCitable('b', 2)])).toBe(true);
    expect(citationMarkersLinkable([])).toBe(false);
    // Named style: nothing is stamped.
    expect(citationMarkersLinkable([lakeCitable('a'), lakeCitable('b')])).toBe(false);
    // A stamp that does not match its position.
    expect(citationMarkersLinkable([lakeCitable('a', 2)])).toBe(false);
  });

  it('does not hold on a turn where a tool appended sources after the numbered prefix', () => {
    // The tool numbers its own results 1., 2., so a [1] on this turn may mean the tool's result 1.
    expect(citationMarkersLinkable([lakeCitable('a', 1), lakeCitable('b', 2), lakeCitable('tool-hit')])).toBe(false);
  });
});

describe('shouldLinkCitationMarkers', () => {
  const linkable = [lakeCitable('a', 1), lakeCitable('b', 2)];

  it('links only a completed reply whose citables are all stamped', () => {
    expect(shouldLinkCitationMarkers(linkable, true)).toBe(true);
    expect(shouldLinkCitationMarkers(linkable, false)).toBe(false);
  });

  it('does not link an unlinkable reply even when completed', () => {
    expect(shouldLinkCitationMarkers([lakeCitable('a', 1), lakeCitable('tool-hit')], true)).toBe(false);
    expect(shouldLinkCitationMarkers([], true)).toBe(false);
  });
});

describe('resolveCitationMarker', () => {
  it('resolves [N] to citables[N-1] on a linkable turn, and nothing out of range', () => {
    const citables = [lakeCitable('a', 1), lakeCitable('b', 2)];
    expect(resolveCitationMarker(citables, 2)?.id).toBe('b');
    expect(resolveCitationMarker(citables, 0)).toBeUndefined();
    expect(resolveCitationMarker(citables, 3)).toBeUndefined();
  });

  it('resolves nothing on a mixed forced-retrieval and tool turn', () => {
    expect(resolveCitationMarker([lakeCitable('a', 1), lakeCitable('tool-hit')], 1)).toBeUndefined();
  });
});

describe('inline citation markers in a reply', () => {
  beforeEach(() => {
    navigate.mockClear();
    useSessionLayout.setState({ citedPassage: null });
  });

  it('opens a lake source at its cited passage, exactly as its chip does', () => {
    render(<Reply content="Holidays accrue monthly [1]." citables={[lakeCitable('file-1', 1)]} />);

    const marker = screen.getByTestId('citation-marker-link');
    expect(marker.tagName).toBe('BUTTON');
    expect(marker).toHaveTextContent('[1]');
    expect(marker).toHaveAccessibleName('[1] file-1.pdf');

    fireEvent.click(marker);
    expect(useSessionLayout.getState().citedPassage).toEqual({
      fileId: 'file-1',
      chunkId: 'file-1-chunk',
      passage: 'passage of file-1',
    });
    expect(navigate).toHaveBeenCalledWith({ to: '/opti', search: { mode: 'datalake', article: 'file-1' } });
  });

  it('opens a web source in a new tab', () => {
    render(<Reply content="See [1]." citables={[webCitable]} />);
    const marker = screen.getByTestId('citation-marker-link');
    expect(marker.tagName).toBe('A');
    expect(marker).toHaveAttribute('href', 'https://example.com/paper');
    expect(marker).toHaveAttribute('target', '_blank');
    expect(marker).toHaveAttribute('rel', 'noopener noreferrer');
  });

  it('defers to a host override, like the chip', () => {
    const onCitationClick = vi.fn();
    const source = lakeCitable('file-1', 1);
    render(
      <CitationInteractionProvider value={{ onCitationClick }}>
        <Reply content="Cited [1]." citables={[source]} />
      </CitationInteractionProvider>
    );
    fireEvent.click(screen.getByTestId('citation-marker-link'));
    expect(onCitationClick).toHaveBeenCalledWith(source);
    expect(navigate).not.toHaveBeenCalled();
  });

  it('skips navigation when the internal-click override handles the source', () => {
    const onInternalCitationClick = vi.fn(() => true);
    const source = lakeCitable('file-1', 1);
    render(
      <CitationInteractionProvider value={{ onInternalCitationClick }}>
        <Reply content="Cited [1]." citables={[source]} />
      </CitationInteractionProvider>
    );
    fireEvent.click(screen.getByTestId('citation-marker-link'));
    expect(onInternalCitationClick).toHaveBeenCalledWith(source);
    expect(navigate).not.toHaveBeenCalled();
  });

  it('falls through to navigation when the internal-click override declines', () => {
    const onInternalCitationClick = vi.fn(() => false);
    render(
      <CitationInteractionProvider value={{ onInternalCitationClick }}>
        <Reply content="Cited [1]." citables={[lakeCitable('file-1', 1)]} />
      </CitationInteractionProvider>
    );
    fireEvent.click(screen.getByTestId('citation-marker-link'));
    expect(onInternalCitationClick).toHaveBeenCalledTimes(1);
    expect(navigate).toHaveBeenCalledWith({ to: '/opti', search: { mode: 'datalake', article: 'file-1' } });
  });

  it('links each number of a comma-listed marker and keeps the text intact', () => {
    const { container } = render(
      <Reply content="Both agree [1, 2]." citables={[lakeCitable('a', 1), lakeCitable('b', 2)]} />
    );
    expect(markerLinks().map(link => link.textContent)).toEqual(['1', '2']);
    expect(container).toHaveTextContent('Both agree [1, 2].');
  });

  it('links markers at a line end and keeps the line break between them', () => {
    const { container } = render(
      <Reply content={'Fact one [1]\nFact two [2]'} citables={[lakeCitable('a', 1), lakeCitable('b', 2)]} />
    );
    expect(markerLinks().map(link => link.textContent)).toEqual(['[1]', '[2]']);
    const html = container.innerHTML;
    expect(container.querySelectorAll('br')).toHaveLength(1);
    expect(html.indexOf('<br')).toBeGreaterThan(html.indexOf('Fact one'));
    expect(html.indexOf('<br')).toBeLessThan(html.indexOf('Fact two'));
  });

  it('leaves dangling and non-citation brackets as plain text', () => {
    const { container } = render(
      <Reply
        content="Dangling [3], a year [2016], and zero [0]."
        citables={[lakeCitable('a', 1), lakeCitable('b', 2)]}
      />
    );
    expect(markerLinks()).toHaveLength(0);
    expect(container).toHaveTextContent('Dangling [3], a year [2016], and zero [0].');
  });

  it('leaves every marker plain on a turn where a tool appended sources', () => {
    render(<Reply content="Forced [1] and searched [2]." citables={[lakeCitable('a', 1), lakeCitable('tool-hit')]} />);
    expect(markerLinks()).toHaveLength(0);
  });

  it('never links inside code spans, code blocks or an existing link', () => {
    const content = ['Inline `arr[1]` here.', '', '```', 'x = arr[1]', '```', '', 'A [link [1]](https://x.test).'].join(
      '\n'
    );
    render(<Reply content={content} citables={[lakeCitable('a', 1)]} />);
    expect(markerLinks()).toHaveLength(0);
    expect(screen.getAllByRole('link')).toHaveLength(1);
  });

  it('turns a marker into a link once its citable merges in mid-stream', () => {
    const { rerender } = render(<Reply content="Streaming [1]" citables={[]} />);
    expect(markerLinks()).toHaveLength(0);
    expect(screen.getByText(/Streaming \[1\]/)).toBeInTheDocument();

    rerender(<Reply content="Streaming [1]" citables={[lakeCitable('a', 1)]} />);
    expect(markerLinks()).toHaveLength(1);
  });
});
