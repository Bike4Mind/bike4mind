// @vitest-environment jsdom
import { describe, expect, it, afterEach, beforeEach, vi } from 'vitest';
import {
  ArtifactCard,
  ArtifactBrowserContext,
  openArtifactInSessionBrowser,
  RENDERED_TYPES,
  SOURCE_ONLY_NOTE,
  TYPE_LABEL,
} from './ArtifactCard';
import { CssVarsProvider } from '@mui/joy/styles';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { ChatArtifactView } from '@shared/chat';
import { DESKTOP_ARTIFACT_PROMPT } from '../../../main/chat/artifacts/prompt';

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

// The drawing yields space to an expanded source disclosure. Its footer must also be able
// to shrink and scroll when that source and the publish controls exceed the opened panel.
describe('ArtifactCard', () => {
  it('keeps source and share controls scrollable in a filled rendered card', () => {
    act(() =>
      root.render(
        <ArtifactCard
          fill
          artifact={{ id: 'long-svg', type: 'svg', title: 'Long SVG', content: '<svg>\n'.repeat(100) }}
        />
      )
    );
    const sheets = [...document.querySelectorAll('style')].map(style => style.textContent).join('');
    // The footer alone combines the rendered card's top border and a shrinking scroll area.
    expect(sheets).toMatch(/\.[\w-]+\{[^}]*min-height:0;overflow-y:auto;[^}]*border-top:1px solid/);
  });
});

describe('ArtifactCard open in browser', () => {
  it('offers the button on an HTML artifact and hands the opener its title and content', () => {
    const open = vi.fn();
    renderCard(html, open);

    expect(button()?.getAttribute('aria-label')).toBe('Open in browser');
    act(() => button()!.click());

    expect(open).toHaveBeenCalledWith({ title: 'Chart', content: '<p>hi</p>' });
  });

  it('hands the opener the model identifier of a reply artifact, so main can reload it on update', () => {
    const open = vi.fn();
    renderCard({ ...html, identifier: 'chart' } as ChatArtifactView, open);

    act(() => button()!.click());

    expect(open).toHaveBeenCalledWith({ title: 'Chart', content: '<p>hi</p>', identifier: 'chart' });
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

  it('names the artifact by its identifier, so main can reload its tab when a reply updates it', () => {
    const open = vi.fn(() => Promise.resolve({} as Awaited<ReturnType<typeof window.b4m.browser.openArtifact>>));

    openArtifactInSessionBrowser({ title: 'Chart', content: '<p>hi</p>', identifier: 'chart' }, 's1', vi.fn(), open);

    expect(open).toHaveBeenCalledWith({ sessionId: 's1', title: 'Chart', content: '<p>hi</p>', artifactKey: 'chart' });
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

/**
 * The list of types this app draws lives in three places that cannot import each other: the
 * card decides, the note explains the gap to the user, and the prompt tells the model. Any two
 * of them disagreeing is a bug the user sees - a wall of source where a picture was promised,
 * or a note pointing at the web app for something drawn right in front of them.
 */

/** The prompt's own claim, read back out of the sentence that makes it. */
function typesThePromptAdvertises(): Set<string> {
  const claim = /This app draws (.+?) artifacts as they will look/.exec(DESKTOP_ARTIFACT_PROMPT.replace(/\n/g, ' '));
  expect(claim).not.toBeNull();
  return new Set(claim![1].split(/,\s*|\s+and\s+/).map(name => name.trim()));
}

describe('what this app says it can draw', () => {
  it('promises the model exactly what the card renders', () => {
    expect(typesThePromptAdvertises()).toEqual(RENDERED_TYPES);
  });

  it('does not send the user to the web app for a type it renders here', () => {
    const overlap = [...RENDERED_TYPES].filter(type => type in SOURCE_ONLY_NOTE);
    expect(overlap).toEqual([]);
  });

  it('has a label for every type it has an opinion about', () => {
    for (const type of [...RENDERED_TYPES, ...Object.keys(SOURCE_ONLY_NOTE)]) {
      expect(TYPE_LABEL[type]).toBeTruthy();
    }
  });
});
