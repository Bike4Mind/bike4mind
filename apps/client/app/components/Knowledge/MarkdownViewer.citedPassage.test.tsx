import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import React from 'react';
import { CssVarsProvider, extendTheme } from '@mui/joy/styles';
import { getThemeConfig } from '@client/app/utils/themes';
import MarkdownViewer from './MarkdownViewer';

vi.mock('../Charts/MermaidChart', () => ({ default: () => <div data-testid="mermaid" /> }));

const appTheme = extendTheme({ ...getThemeConfig() });
const TestWrapper = ({ children }: { children: React.ReactNode }) => (
  <CssVarsProvider theme={appTheme}>{children}</CssVarsProvider>
);

const DOC = [
  '# Leave policy',
  '',
  'Holidays accrue monthly.',
  '',
  'Unused days roll over once.',
  '',
  'Sabbaticals are separate.',
].join('\n');

const renderDoc = (citedPassage?: string) =>
  render(
    <TestWrapper>
      <MarkdownViewer content={DOC} citedPassage={citedPassage} />
    </TestWrapper>
  );

/** jsdom has no layout, so scrollIntoView is unimplemented; the spy is also the assertion. */
const scrollIntoView = vi.fn();

beforeEach(() => {
  scrollIntoView.mockClear();
  Element.prototype.scrollIntoView = scrollIntoView;
});

describe('MarkdownViewer cited-passage anchor (#3038)', () => {
  it('marks only the blocks the passage covers', () => {
    const { container } = renderDoc('Holidays accrue monthly.');
    const marked = Array.from(container.querySelectorAll('[data-cited]')).map(el => el.textContent);
    expect(marked).toEqual(['Holidays accrue monthly.']);
  });

  it('marks every block a multi-paragraph passage spans', () => {
    // The whole point of marking boundaries rather than one paragraph: a reader checking a claim
    // has to see where the cited extent ENDS.
    const { container } = renderDoc('Holidays accrue monthly.\n\nUnused days roll over once.');
    const marked = Array.from(container.querySelectorAll('[data-cited]')).map(el => el.textContent);
    expect(marked).toEqual(['Holidays accrue monthly.', 'Unused days roll over once.']);
  });

  it('leaves the document unmarked when no passage is given', () => {
    const { container } = renderDoc(undefined);
    expect(container.querySelectorAll('[data-cited]')).toHaveLength(0);
    expect(scrollIntoView).not.toHaveBeenCalled();
    expect(screen.queryByTestId('markdown-cited-passage-fallback')).toBeNull();
  });

  it('scrolls the first marked block into view', () => {
    const { container } = renderDoc('Unused days roll over once.');
    expect(scrollIntoView).toHaveBeenCalledTimes(1);
    // WHICH element was scrolled is the assertion that matters: a call count alone passes just as
    // happily if the viewer scrolls the container, or the wrong one of several marked blocks.
    const marked = container.querySelector('[data-cited]');
    expect(scrollIntoView.mock.instances[0]).toBe(marked);
    expect((scrollIntoView.mock.instances[0] as Element).textContent).toBe('Unused days roll over once.');
  });

  it('scrolls to the FIRST marked block when the passage spans several', () => {
    const { container } = renderDoc('Holidays accrue monthly.\n\nUnused days roll over once.');
    expect(scrollIntoView).toHaveBeenCalledTimes(1);
    expect(scrollIntoView.mock.instances[0]).toBe(container.querySelector('[data-cited]'));
    expect((scrollIntoView.mock.instances[0] as Element).textContent).toBe('Holidays accrue monthly.');
  });

  it('shows the passage as a callout when it is not in this document, and marks nothing', () => {
    // A re-chunk or an edit since the turn. Silently rendering a plain document would be
    // indistinguishable from a citation that never carried a passage, so the evidence is shown.
    const { container } = renderDoc('Parental leave is twelve weeks.');
    const fallback = screen.getByTestId('markdown-cited-passage-fallback');
    expect(fallback).toHaveTextContent('Parental leave is twelve weeks.');
    // The title is the only thing telling the reader WHY there is no highlight. "Not found" means
    // the document drifted; the other case (located, nothing rendered carries it) must not say so.
    expect(fallback).toHaveTextContent('no longer found in this document');
    expect(container.querySelectorAll('[data-cited]')).toHaveLength(0);
    expect(scrollIntoView).not.toHaveBeenCalled();
  });

  it('does not show the fallback callout when the passage WAS located', () => {
    renderDoc('Sabbaticals are separate.');
    expect(screen.queryByTestId('markdown-cited-passage-fallback')).toBeNull();
  });

  it('marks a passage that lands in a list item', () => {
    const { container } = render(
      <TestWrapper>
        <MarkdownViewer content={'Intro text.\n\n- first item\n- second item\n'} citedPassage={'second item'} />
      </TestWrapper>
    );
    expect(Array.from(container.querySelectorAll('[data-cited]')).map(el => el.textContent)).toEqual(['second item']);
  });

  it('keeps the props react-markdown computed on a list item it marks', () => {
    // The `li` override exists only to carry the cited attribute. Dropping the rest of the props
    // would silently strip GFM's task-list class - markup the default renderer produced and that
    // the checkbox styling keys on.
    const { container } = render(
      <TestWrapper>
        <MarkdownViewer content={'- [ ] renew the policy\n- [x] file the notice\n'} citedPassage={'file the notice'} />
      </TestWrapper>
    );
    const marked = container.querySelector('li[data-cited]');
    expect(marked).not.toBeNull();
    expect(marked).toHaveClass('task-list-item');
    expect(marked!.querySelector('input[type="checkbox"]')).not.toBeNull();
  });

  it('falls back to the callout when the passage is located but nothing rendered carries it', () => {
    // A table cell: located in the source, but no overridden block covers it. Without this the
    // reader would get an unmarked document and no sign the deep link went nowhere.
    const table = ['| Policy | Days |', '| --- | --- |', '| Holidays | twelve |'].join('\n');
    render(
      <TestWrapper>
        <MarkdownViewer content={table} citedPassage={'| Holidays | twelve |'} />
      </TestWrapper>
    );
    const fallback = screen.getByTestId('markdown-cited-passage-fallback');
    expect(fallback).toBeInTheDocument();
    // The OTHER title. The passage WAS located, so claiming it is gone from the document would be
    // wrong - this is the pair that makes the two fallback paths distinguishable to a reader.
    expect(fallback).toHaveTextContent('Cited passage');
    expect(fallback).not.toHaveTextContent('no longer found in this document');
  });

  it('marks the right blocks in a document the LaTeX promotion rewrites', () => {
    // promoteInlineLatexDollars runs before parsing, so offsets are into the PROMOTED string. A
    // document containing $...$ is where locating the passage in `content` instead would shift
    // every offset by what the transform inserted and mark a neighbouring block.
    const doc = [
      'Holidays accrue monthly.',
      '',
      'The accrual rate is $r = 1.5$ days.',
      '',
      'Sabbaticals are separate.',
    ].join('\n');
    const { container } = render(
      <TestWrapper>
        <MarkdownViewer content={doc} citedPassage={'The accrual rate is $r = 1.5$ days.'} />
      </TestWrapper>
    );

    const marked = Array.from(container.querySelectorAll('[data-cited]'));
    expect(marked).toHaveLength(1);
    expect(marked[0].textContent).toContain('The accrual rate is');
    expect(screen.queryByTestId('markdown-cited-passage-fallback')).toBeNull();
  });
});
