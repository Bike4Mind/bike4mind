import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
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

const FRONTMATTER = '---\ndate: 2015-06-01\ntitle: Leave policy\n---\n\n';
const BODY = 'Holidays accrue monthly.\n\nUnused days roll over once.';

const renderDoc = (content: string, citedPassage?: string, stripFrontmatter = true) =>
  render(
    <TestWrapper>
      <MarkdownViewer content={content} citedPassage={citedPassage} stripFrontmatter={stripFrontmatter} />
    </TestWrapper>
  );

const originalScrollIntoView = Element.prototype.scrollIntoView;

beforeEach(() => {
  Element.prototype.scrollIntoView = vi.fn();
});

afterEach(() => {
  Element.prototype.scrollIntoView = originalScrollIntoView;
});

describe('MarkdownViewer frontmatter', () => {
  it('does not render frontmatter as a setext heading', () => {
    const { container } = renderDoc(FRONTMATTER + BODY);
    expect(container.querySelector('h1, h2')).toBeNull();
    expect(container.textContent).not.toContain('date: 2015-06-01');
    expect(container.textContent).toContain('Holidays accrue monthly.');
  });

  it('still marks the cited blocks when the document opens with frontmatter', () => {
    const { container } = renderDoc(FRONTMATTER + BODY, 'Unused days roll over once.');
    const marked = Array.from(container.querySelectorAll('[data-cited]')).map(el => el.textContent);
    expect(marked).toEqual(['Unused days roll over once.']);
    expect(screen.queryByTestId('markdown-cited-passage-fallback')).toBeNull();
  });

  it('marks the cited block after inline math that the dollar promotion rewrites', () => {
    const { container } = renderDoc(
      `${FRONTMATTER}Energy scales as $x^2$ here.\n\n${BODY}`,
      'Unused days roll over once.'
    );
    const marked = Array.from(container.querySelectorAll('[data-cited]')).map(el => el.textContent);
    expect(marked).toEqual(['Unused days roll over once.']);
    expect(screen.queryByTestId('markdown-cited-passage-fallback')).toBeNull();
  });

  it('hides frontmatter keys with spaces and a leading @', () => {
    const { container } = renderDoc('---\nLast Updated: 2026-01-05\n"@context": x\n---\n\n' + BODY);
    expect(container.querySelector('h1, h2')).toBeNull();
    expect(container.textContent).not.toContain('Last Updated');
    expect(container.textContent).toContain('Holidays accrue monthly.');
  });

  it('leaves a leading --- pair around prose untouched when the prop is not set', () => {
    const { container } = renderDoc('---\nNote: read this first\n---\n\nBody text', undefined, false);
    expect(container.textContent).toContain('Note: read this first');
    expect(container.textContent).toContain('Body text');
  });
});
