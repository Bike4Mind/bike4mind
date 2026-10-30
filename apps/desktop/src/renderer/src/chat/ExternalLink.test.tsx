// @vitest-environment jsdom
import { CssVarsProvider } from '@mui/joy/styles';
import { act, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ExternalLink, LinkifiedText } from './ExternalLink';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

// jsdom ships no matchMedia, and Joy's colour-scheme provider asks for one on mount.
window.matchMedia ??= ((query: string) => ({
  matches: false,
  media: query,
  onchange: null,
  addListener: () => {},
  removeListener: () => {},
  addEventListener: () => {},
  removeEventListener: () => {},
  dispatchEvent: () => false,
})) as typeof window.matchMedia;

let container: HTMLDivElement;
let root: Root;
const openExternal = vi.fn(async () => undefined);

beforeEach(() => {
  openExternal.mockClear();
  vi.stubGlobal('b4m', { shell: { openExternal } });
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});

const render = (node: ReactNode) => act(() => root.render(<CssVarsProvider>{node}</CssVarsProvider>));
const anchors = () => [...container.querySelectorAll<HTMLAnchorElement>('[data-testid="chat-message-link"]')];

/** A real click event, so the test sees whether the window itself would have navigated. */
function click(anchor: HTMLAnchorElement): MouseEvent {
  const event = new MouseEvent('click', { bubbles: true, cancelable: true });
  act(() => {
    anchor.dispatchEvent(event);
  });
  return event;
}

describe('ExternalLink', () => {
  it('opens the url through the bridge and never navigates the window', () => {
    render(<ExternalLink href="https://example.com/a">docs</ExternalLink>);

    const event = click(anchors()[0]!);

    expect(event.defaultPrevented).toBe(true);
    expect(openExternal).toHaveBeenCalledExactlyOnceWith('https://example.com/a');
  });

  it('keeps the href on the anchor and asks for no new window', () => {
    render(<ExternalLink href="https://example.com/a">docs</ExternalLink>);

    expect(anchors()[0]?.getAttribute('href')).toBe('https://example.com/a');
    expect(anchors()[0]?.hasAttribute('target')).toBe(false);
  });

  it('hands nothing to the bridge for a scheme main would refuse', () => {
    render(<ExternalLink href="#user-content-fn-1">1</ExternalLink>);

    const event = click(anchors()[0]!);

    expect(event.defaultPrevented).toBe(true);
    expect(openExternal).not.toHaveBeenCalled();
  });
});

describe('LinkifiedText', () => {
  it('links the urls in plain text and leaves the rest as it was written', () => {
    const text = 'see https://x.com/a. and (https://y.com/b) but not javascript:alert(1) or some_file_name';
    render(<LinkifiedText text={text} />);

    expect(anchors().map(anchor => anchor.getAttribute('href'))).toEqual(['https://x.com/a', 'https://y.com/b']);
    expect(container.textContent).toBe(text);
  });

  it('opens a linked url from a prompt through the same bridge', () => {
    render(<LinkifiedText text="go to https://example.com/page now" />);

    click(anchors()[0]!);

    expect(openExternal).toHaveBeenCalledExactlyOnceWith('https://example.com/page');
  });
});
