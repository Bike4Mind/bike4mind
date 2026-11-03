// @vitest-environment jsdom
import { CssVarsProvider } from '@mui/joy/styles';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ChatArtifactView } from '@shared/chat';
import { ArtifactBrowserContext, ArtifactCard, openArtifactInSessionBrowser } from './ArtifactCard';

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

const html: ChatArtifactView = { id: 'a1', type: 'html', title: 'Chart', content: '<p>hi</p>' };
const svg: ChatArtifactView = { id: 'a2', type: 'svg', title: 'Logo', content: '<svg></svg>' };

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

function renderCard(artifact: ChatArtifactView, open?: (artifact: { title: string; content: string }) => void) {
  act(() =>
    root.render(
      <CssVarsProvider>
        <ArtifactBrowserContext.Provider value={open}>
          <ArtifactCard artifact={artifact} />
        </ArtifactBrowserContext.Provider>
      </CssVarsProvider>
    )
  );
}

const button = () => container.querySelector<HTMLButtonElement>('[data-testid="artifact-open-in-browser-btn"]');

describe('ArtifactCard open in browser', () => {
  it('offers the button on an HTML artifact and hands the opener its title and content', () => {
    const open = vi.fn();
    renderCard(html, open);

    expect(button()?.getAttribute('aria-label')).toBe('Open in browser');
    act(() => button()!.click());

    expect(open).toHaveBeenCalledWith({ title: 'Chart', content: '<p>hi</p>' });
  });

  it('offers no button for other types, or where nothing can open one', () => {
    renderCard(svg, vi.fn());
    expect(button()).toBeNull();

    renderCard(html, undefined);
    expect(button()).toBeNull();
  });
});

describe('openArtifactInSessionBrowser', () => {
  it('shows the pane, then asks main to open the artifact in that conversation', async () => {
    const calls: string[] = [];
    const showPane = vi.fn(() => calls.push('show'));
    const open = vi.fn(async () => {
      calls.push('open');
      return { url: '', canGoBack: false, canGoForward: false, loading: false, error: '', tabs: [], activeTabId: 1 };
    });

    openArtifactInSessionBrowser({ title: 'Chart', content: '<p>hi</p>' }, 's1', showPane, open);

    expect(calls).toEqual(['show', 'open']);
    expect(open).toHaveBeenCalledWith({ sessionId: 's1', title: 'Chart', content: '<p>hi</p>' });
  });

  it('does nothing without a conversation, and swallows a refusal', async () => {
    const showPane = vi.fn();
    const refuse = vi.fn(() => Promise.reject(new Error('no')));

    openArtifactInSessionBrowser(html, null, showPane, refuse);
    expect(showPane).not.toHaveBeenCalled();
    expect(refuse).not.toHaveBeenCalled();

    openArtifactInSessionBrowser(html, 's1', showPane, refuse);
    await Promise.resolve();
    expect(refuse).toHaveBeenCalledTimes(1);
  });
});
