import React from 'react';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { CssVarsProvider, extendTheme } from '@mui/joy/styles';
import ReactMarkdown from 'react-markdown';
import { remarkGfmNoSingleTilde } from '../../utils/remarkPlugins';
import { getThemeConfig } from '../../utils/themes';
import { link } from './MarkdownLink';

const appTheme = extendTheme({ ...getThemeConfig() });

const TestWrapper = ({ children }: { children: React.ReactNode }) => (
  <CssVarsProvider theme={appTheme}>{children}</CssVarsProvider>
);

// Mirror PromptReplies' usage: `a: link` + per-message footnote id namespacing.
const Reply = ({ messageId, markdown }: { messageId: string; markdown: string }) => (
  <ReactMarkdown
    components={{ a: link }}
    remarkPlugins={[remarkGfmNoSingleTilde]}
    remarkRehypeOptions={{ clobberPrefix: `fn-${messageId}-` }}
  >
    {markdown}
  </ReactMarkdown>
);

const FOOTNOTE_MD = `A claim[^1] and another[^2].

[^1]: First source.
[^2]: Second source.`;

// jsdom does not implement scrollIntoView; record the id of the element it's called
// on so we can assert navigation lands on the correct target.
const originalScrollIntoView = Element.prototype.scrollIntoView;
let scrolledIds: string[];

beforeEach(() => {
  scrolledIds = [];
  Element.prototype.scrollIntoView = function (this: Element) {
    scrolledIds.push(this.id);
  };
});

afterEach(() => {
  Element.prototype.scrollIntoView = originalScrollIntoView;
});

describe('MarkdownLink — link', () => {
  it('opens external links in a new tab', () => {
    render(
      <TestWrapper>
        <Reply messageId="msg1" markdown="[example](https://example.com)" />
      </TestWrapper>
    );

    const anchor = screen.getByRole('link', { name: 'example' });
    expect(anchor).toHaveAttribute('href', 'https://example.com');
    expect(anchor).toHaveAttribute('target', '_blank');
    expect(anchor).toHaveAttribute('rel', 'noopener noreferrer');
  });

  it('renders footnote anchors as same-tab (no target="_blank")', () => {
    const { container } = render(
      <TestWrapper>
        <Reply messageId="msg1" markdown={FOOTNOTE_MD} />
      </TestWrapper>
    );

    // Every in-page (#) anchor - inline refs and back-refs - must stay same-tab.
    const inPageAnchors = container.querySelectorAll('a[href^="#"]');
    expect(inPageAnchors.length).toBeGreaterThan(0);
    inPageAnchors.forEach(a => expect(a).not.toHaveAttribute('target'));
  });

  it('preserves the inline-ref id so back-ref scroll targets exist', () => {
    const { container } = render(
      <TestWrapper>
        <Reply messageId="msg1" markdown={FOOTNOTE_MD} />
      </TestWrapper>
    );

    // The bug: forwarding only href/children stripped the id, so #...-fnref-N
    // (the back-ref's destination) did not exist in the DOM.
    expect(container.querySelector('#fn-msg1-fnref-1')).not.toBeNull();
    expect(container.querySelector('#fn-msg1-fnref-2')).not.toBeNull();
  });

  it('scrolls down to the footnote when an inline ref is clicked (no new tab)', () => {
    const { container } = render(
      <TestWrapper>
        <Reply messageId="msg1" markdown={FOOTNOTE_MD} />
      </TestWrapper>
    );

    const inlineRef = container.querySelector('#fn-msg1-fnref-1') as HTMLAnchorElement;
    expect(inlineRef).not.toBeNull();
    fireEvent.click(inlineRef);

    expect(scrolledIds).toEqual(['fn-msg1-fn-1']);
  });

  it('scrolls up to the originating ref when the back-ref is clicked', () => {
    const { container } = render(
      <TestWrapper>
        <Reply messageId="msg1" markdown={FOOTNOTE_MD} />
      </TestWrapper>
    );

    const backRef = container.querySelector('a[data-footnote-backref]') as HTMLAnchorElement;
    expect(backRef).not.toBeNull();
    expect(backRef.getAttribute('href')).toBe('#fn-msg1-fnref-1');
    fireEvent.click(backRef);

    expect(scrolledIds).toEqual(['fn-msg1-fnref-1']);
  });

  it('does not throw when an in-page href has malformed percent-encoding', () => {
    // ReactMarkdown URL-normalizes hrefs, so a malformed hash can only reach the
    // handler when `link` is reused directly on arbitrary content. Render it directly.
    const { container } = render(<TestWrapper>{React.createElement(link, { href: '#%' }, 'bad')}</TestWrapper>);

    const anchor = container.querySelector('a[href="#%"]') as HTMLAnchorElement;
    expect(anchor).not.toBeNull();
    // decodeURIComponent('%') throws URIError - the handler must swallow it.
    expect(() => fireEvent.click(anchor)).not.toThrow();
  });

  it('namespaces footnote ids per message so two replies target their own footnotes', () => {
    const { container } = render(
      <TestWrapper>
        <Reply messageId="msg1" markdown={FOOTNOTE_MD} />
        <Reply messageId="msg2" markdown={FOOTNOTE_MD} />
      </TestWrapper>
    );

    // Disjoint id namespaces - no collision on a shared user-content-fn-1.
    expect(container.querySelector('#fn-msg1-fn-1')).not.toBeNull();
    expect(container.querySelector('#fn-msg2-fn-1')).not.toBeNull();

    // Clicking msg2's inline ref scrolls to msg2's footnote, not msg1's.
    const msg2Ref = container.querySelector('#fn-msg2-fnref-1') as HTMLAnchorElement;
    fireEvent.click(msg2Ref);
    expect(scrolledIds).toEqual(['fn-msg2-fn-1']);
  });
});
