// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { CssVarsProvider } from '@mui/joy/styles';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ChatArtifactContent, ChatArtifactLibrary, ChatArtifactSummary } from '@shared/chat';
import { ArtifactLibraryPanel } from './ArtifactLibraryPanel';

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

const summaries: ChatArtifactSummary[] = [
  { id: 'a1', title: 'Beta chart', type: 'html', createdAt: '2025-12-02T00:00:00.000Z' },
  { id: 'a2', title: 'Alpha flow', type: 'mermaid', createdAt: '2026-01-05T00:00:00.000Z', description: 'Login steps' },
  { id: 'a3', title: 'Gamma page', type: 'html', createdAt: '2026-06-10T00:00:00.000Z' },
];

/**
 * A hand-driven IntersectionObserver: nothing is on screen until a test says so, which is what
 * lets these tests see which bodies the panel asks for and when.
 */
const observed: { element: Element; root: Element | Document | null; callback: IntersectionObserverCallback }[] = [];
class ManualObserver {
  constructor(
    private readonly callback: IntersectionObserverCallback,
    private readonly options: IntersectionObserverInit = {}
  ) {}
  observe(element: Element) {
    observed.push({ element, root: this.options.root ?? null, callback: this.callback });
  }
  unobserve() {}
  disconnect() {
    for (let i = observed.length - 1; i >= 0; i--) if (observed[i].callback === this.callback) observed.splice(i, 1);
  }
  takeRecords() {
    return [];
  }
}

async function bringNear(elements: readonly Element[], near = true): Promise<void> {
  await act(async () => {
    for (const { element, callback } of [...observed]) {
      if (!elements.includes(element)) continue;
      callback(
        [{ isIntersecting: near, target: element } as unknown as IntersectionObserverEntry],
        {} as IntersectionObserver
      );
    }
  });
}

const listArtifacts = vi.fn<() => Promise<ChatArtifactLibrary>>();
const readArtifact = vi.fn<(id: string) => Promise<ChatArtifactContent>>();

let root: Root | null = null;
let host: HTMLElement | null = null;

beforeEach(() => {
  observed.length = 0;
  vi.stubGlobal('IntersectionObserver', ManualObserver);
  listArtifacts.mockReset();
  readArtifact.mockReset();
  (window as unknown as { b4m: unknown }).b4m = {
    chat: {
      listArtifacts,
      readArtifact,
      readArtifactPublishState: vi.fn(async () => null),
      onArtifactPublishProgress: vi.fn(() => () => {}),
    },
  };
});

afterEach(() => {
  act(() => root?.unmount());
  host?.remove();
  root = null;
  host = null;
  vi.unstubAllGlobals();
});

async function mount(): Promise<void> {
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
  await act(async () => {
    root?.render(
      <CssVarsProvider>
        <ArtifactLibraryPanel onClose={() => {}} />
      </CssVarsProvider>
    );
  });
}

const byTestId = (id: string) => host?.querySelector<HTMLElement>(`[data-testid="${id}"]`) ?? null;
const allByTestId = (id: string) => [...(host?.querySelectorAll<HTMLElement>(`[data-testid="${id}"]`) ?? [])];
// A Joy Chip's click target is an overlay button beside its label, so the label is the parent's text.
const chipText = (id: string) => byTestId(id)?.parentElement?.textContent;
const titles = () => allByTestId('artifact-library-card-title').map(node => node.textContent);

async function type(value: string): Promise<void> {
  const input = byTestId('artifact-library-search-input') as HTMLInputElement;
  const setValue = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
  await act(async () => {
    setValue?.call(input, value);
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
}

async function click(node: HTMLElement | null): Promise<void> {
  await act(async () => node?.click());
}

describe('ArtifactLibraryPanel states', () => {
  it('shows loading until the first list arrives', async () => {
    listArtifacts.mockReturnValue(new Promise(() => {}));
    await mount();
    expect(byTestId('artifact-library-loading')).not.toBeNull();
    expect(byTestId('artifact-library-empty')).toBeNull();
  });

  it('tells an empty library apart from a failed read, and offers no toolbar on it', async () => {
    listArtifacts.mockResolvedValue({ artifacts: [], total: 0 });
    await mount();
    expect(byTestId('artifact-library-empty')).not.toBeNull();
    expect(byTestId('artifact-library-error')).toBeNull();
    expect(byTestId('artifact-library-search-input')).toBeNull();
  });

  it('shows a failed read with a retry that reloads the list', async () => {
    listArtifacts.mockResolvedValueOnce({ artifacts: [], total: 0, error: 'Sign in to see your artifacts.' });
    await mount();
    expect(byTestId('artifact-library-error')?.textContent).toContain('Sign in to see your artifacts.');
    expect(byTestId('artifact-library-empty')).toBeNull();

    listArtifacts.mockResolvedValueOnce({ artifacts: summaries, total: 3 });
    await click(byTestId('artifact-library-retry-btn'));
    expect(listArtifacts).toHaveBeenCalledTimes(2);
    expect(byTestId('artifact-library-error')).toBeNull();
    expect(titles()).toHaveLength(3);
  });

  it('keeps the previous list and cached body when a refresh fails', async () => {
    listArtifacts.mockResolvedValueOnce({ artifacts: [summaries[0]], total: 1 });
    readArtifact.mockResolvedValueOnce({
      artifact: { id: 'a1', type: 'code', title: 'Beta chart', content: 'cached body' },
    });
    await mount();
    await bringNear(allByTestId('artifact-library-card'));

    const settleRefresh: Array<(result: ChatArtifactLibrary) => void> = [];
    listArtifacts.mockReturnValueOnce(new Promise(resolve => settleRefresh.push(resolve)));
    await click(byTestId('artifact-library-refresh-btn'));
    await click(allByTestId('artifact-library-card')[0]);
    await act(async () => {
      settleRefresh[0]({ artifacts: [], total: 0, error: 'The server could not be reached.' });
    });
    expect(byTestId('artifact-library-error')?.textContent).toContain('The server could not be reached.');
    expect(titles()).toEqual(['Beta chart']);
    expect(byTestId('artifact-library-thumb-source')?.textContent).toBe('cached body');
    expect(byTestId('artifact-library-detail')).not.toBeNull();
    expect(byTestId('chat-artifact-card')?.textContent).toContain('cached body');
    expect(readArtifact).toHaveBeenCalledTimes(1);
  });

  it('says when the server holds more than the page that was loaded', async () => {
    listArtifacts.mockResolvedValue({ artifacts: summaries, total: 250 });
    await mount();
    expect(byTestId('artifact-library-truncated')?.textContent).toContain('newest 3 of 250');
  });
});

describe('ArtifactLibraryPanel list', () => {
  beforeEach(() => {
    listArtifacts.mockResolvedValue({ artifacts: summaries, total: 3 });
  });

  it('lays the cards out newest first, each with a placeholder thumbnail and a type label', async () => {
    await mount();
    expect(byTestId('artifact-library-grid')).not.toBeNull();
    expect(titles()).toEqual(['Gamma page', 'Alpha flow', 'Beta chart']);
    expect(allByTestId('artifact-library-card-avatar').map(node => node.textContent)).toEqual(['G', 'A', 'B']);
    expect(allByTestId('artifact-library-card-type').map(node => node.textContent)).toEqual([
      'HTML',
      'Diagram',
      'HTML',
    ]);
    expect(byTestId('artifact-library-truncated')).toBeNull();
  });

  it('counts each type on its chip and filters by it, toggling off on a second click', async () => {
    await mount();
    expect(chipText('artifact-library-filter-html-chip')).toBe('HTML 2');
    expect(chipText('artifact-library-filter-mermaid-chip')).toBe('Diagram 1');

    await click(byTestId('artifact-library-filter-mermaid-chip'));
    expect(titles()).toEqual(['Alpha flow']);
    expect(chipText('artifact-library-filter-html-chip')).toBe('HTML 2');

    await click(byTestId('artifact-library-filter-mermaid-chip'));
    expect(titles()).toHaveLength(3);
  });

  it('keeps the selected type chip when a refresh drops its last row', async () => {
    await mount();
    await click(byTestId('artifact-library-filter-mermaid-chip'));
    listArtifacts.mockResolvedValueOnce({ artifacts: summaries.filter(row => row.type !== 'mermaid'), total: 2 });
    await click(byTestId('artifact-library-refresh-btn'));
    expect(chipText('artifact-library-filter-mermaid-chip')).toBe('Diagram 0');
    expect(byTestId('artifact-library-no-matches')).not.toBeNull();

    await click(byTestId('artifact-library-filter-mermaid-chip'));
    expect(titles()).toHaveLength(2);
    expect(byTestId('artifact-library-filter-mermaid-chip')).toBeNull();
  });

  it('searches titles and descriptions, and clears to the whole list', async () => {
    await mount();
    await type('login');
    expect(titles()).toEqual(['Alpha flow']);

    await type('nothing like this');
    expect(titles()).toEqual([]);
    expect(byTestId('artifact-library-no-matches')).not.toBeNull();

    await click(byTestId('artifact-library-clear-btn'));
    expect(titles()).toHaveLength(3);
    expect(byTestId('artifact-library-clear-btn')).toBeNull();
  });

  it('re-sorts oldest first and by title from the sort select', async () => {
    await mount();
    const pick = async (value: string) => {
      await click(byTestId('artifact-library-sort-select'));
      await click(document.querySelector<HTMLElement>(`[data-testid="artifact-library-sort-${value}"]`));
    };
    await pick('oldest');
    expect(titles()).toEqual(['Beta chart', 'Alpha flow', 'Gamma page']);
    await pick('title');
    expect(titles()).toEqual(['Alpha flow', 'Beta chart', 'Gamma page']);
    await pick('newest');
    expect(titles()).toEqual(['Gamma page', 'Alpha flow', 'Beta chart']);
  });

  it('fetches a thumbnail body only once its card nears the viewport, and only once', async () => {
    readArtifact.mockResolvedValue({
      artifact: { id: 'a3', type: 'code', title: 'Gamma page', content: 'const x = 1;' },
    });
    await mount();
    expect(readArtifact).not.toHaveBeenCalled();
    // Rooted at the grid's own scroller, or the prefetch margin would be clipped away.
    expect(observed.map(entry => entry.root)).toEqual(observed.map(() => byTestId('artifact-library-grid-scroller')));

    const [first] = allByTestId('artifact-library-card');
    await bringNear([first]);
    expect(readArtifact).toHaveBeenCalledTimes(1);
    expect(readArtifact).toHaveBeenCalledWith('a3');
    expect(byTestId('artifact-library-thumb-source')?.textContent).toBe('const x = 1;');

    await bringNear([first]);
    expect(readArtifact).toHaveBeenCalledTimes(1);
  });

  it('refreshes a prefetched body before its first explicit open', async () => {
    listArtifacts.mockResolvedValue({ artifacts: [summaries[0]], total: 1 });
    readArtifact.mockResolvedValueOnce({
      artifact: { id: 'a1', type: 'code', title: 'Before edit', content: 'old body' },
    });
    await mount();
    await bringNear(allByTestId('artifact-library-card'));
    expect(byTestId('artifact-library-thumb-source')?.textContent).toBe('old body');

    listArtifacts.mockResolvedValueOnce({ artifacts: [{ ...summaries[0], title: 'After edit' }], total: 1 });
    readArtifact.mockResolvedValueOnce({
      artifact: { id: 'a1', type: 'code', title: 'After edit', content: 'new body' },
    });
    await click(byTestId('artifact-library-refresh-btn'));
    expect(readArtifact).toHaveBeenCalledTimes(2);
    expect(titles()).toEqual(['After edit']);
    expect(byTestId('artifact-library-thumb-source')?.textContent).toBe('new body');

    await click(allByTestId('artifact-library-card')[0]);
    expect(byTestId('chat-artifact-card')?.textContent).toContain('new body');
    expect(byTestId('chat-artifact-card')?.textContent).not.toContain('old body');
  });

  it.each(['success', 'failure'] as const)(
    'ignores a thumbnail %s from before the last successful refresh',
    async outcome => {
      listArtifacts.mockResolvedValue({ artifacts: [summaries[0]], total: 1 });
      const pending: Array<{
        resolve: (result: ChatArtifactContent) => void;
        reject: (cause: Error) => void;
      }> = [];
      readArtifact.mockImplementation(() => new Promise((resolve, reject) => pending.push({ resolve, reject })));
      await mount();
      await bringNear(allByTestId('artifact-library-card'));
      expect(readArtifact).toHaveBeenCalledTimes(1);

      await click(byTestId('artifact-library-refresh-btn'));
      expect(readArtifact).toHaveBeenCalledTimes(2);
      await act(async () => {
        if (outcome === 'success') {
          pending[0].resolve({ artifact: { id: 'a1', type: 'code', title: 'Before edit', content: 'old body' } });
        } else {
          pending[0].reject(new Error('Old read failed.'));
        }
      });
      expect(byTestId('artifact-library-thumb-source')).toBeNull();
      expect(byTestId('artifact-library-card-thumb')?.getAttribute('data-state')).toBe('loading');

      await act(async () => {
        pending[1].resolve({ artifact: { id: 'a1', type: 'code', title: 'After edit', content: 'new body' } });
      });
      expect(byTestId('artifact-library-thumb-source')?.textContent).toBe('new body');
    }
  );

  it('counts reads from before a refresh toward the thumbnail concurrency limit', async () => {
    const many: ChatArtifactSummary[] = Array.from({ length: 6 }, (_, index) => ({
      id: `m${index}`,
      title: `Card ${index}`,
      type: 'code',
      createdAt: '2026-01-01T00:00:00.000Z',
    }));
    listArtifacts.mockResolvedValue({ artifacts: many, total: 6 });
    const settle: Array<(result: ChatArtifactContent) => void> = [];
    readArtifact.mockImplementation(() => new Promise(resolve => settle.push(resolve)));
    await mount();
    await bringNear(allByTestId('artifact-library-card'));
    expect(readArtifact).toHaveBeenCalledTimes(4);

    await click(byTestId('artifact-library-refresh-btn'));
    expect(readArtifact).toHaveBeenCalledTimes(4);
    await act(async () => settle[0]({ error: 'Old read failed.' }));
    expect(readArtifact).toHaveBeenCalledTimes(5);
    expect(readArtifact).toHaveBeenLastCalledWith('m0');
  });

  it('reads at most four bodies at once and starts the next as one lands', async () => {
    const many: ChatArtifactSummary[] = Array.from({ length: 6 }, (_, i) => ({
      id: `m${i}`,
      title: `Card ${i}`,
      type: 'code',
      createdAt: `2026-0${i + 1}-01T00:00:00.000Z`,
    }));
    listArtifacts.mockResolvedValue({ artifacts: many, total: 6 });
    const settle: Array<() => void> = [];
    readArtifact.mockImplementation(
      id =>
        new Promise(resolve => settle.push(() => resolve({ artifact: { id, type: 'code', title: id, content: id } })))
    );
    await mount();
    await bringNear(allByTestId('artifact-library-card'));
    expect(readArtifact).toHaveBeenCalledTimes(4);

    await act(async () => settle[0]());
    expect(readArtifact).toHaveBeenCalledTimes(5);
  });

  it('drops a queued thumbnail when its card leaves the viewport before a slot opens', async () => {
    const many: ChatArtifactSummary[] = Array.from({ length: 5 }, (_, index) => ({
      id: `m${index}`,
      title: `Card ${index}`,
      type: 'code',
      createdAt: '2026-01-01T00:00:00.000Z',
    }));
    listArtifacts.mockResolvedValue({ artifacts: many, total: 5 });
    const settle: Array<(result: ChatArtifactContent) => void> = [];
    readArtifact.mockImplementation(() => new Promise(resolve => settle.push(resolve)));
    await mount();
    const cards = allByTestId('artifact-library-card');
    await bringNear(cards);
    expect(readArtifact).toHaveBeenCalledTimes(4);
    await bringNear([cards[4]], false);
    await act(async () => settle[0]({ error: 'Unavailable.' }));
    expect(readArtifact).toHaveBeenCalledTimes(4);

    await bringNear([cards[4]]);
    expect(readArtifact).toHaveBeenLastCalledWith('m4');
    expect(readArtifact).toHaveBeenCalledTimes(5);
  });

  it('retries a failed thumbnail read when its card is opened', async () => {
    readArtifact.mockResolvedValueOnce({ error: 'Unavailable.' });
    await mount();
    const card = allByTestId('artifact-library-card')[0];
    await bringNear([card]);
    expect(byTestId('artifact-library-card-thumb')?.getAttribute('data-state')).toBe('error');
    readArtifact.mockResolvedValueOnce({
      artifact: { id: 'a3', type: 'code', title: 'Gamma page', content: 'retried body' },
    });
    await click(card);
    expect(readArtifact).toHaveBeenCalledTimes(2);
    expect(byTestId('chat-artifact-card')?.textContent).toContain('retried body');
  });

  it('opens a card over the grid, and goes back to the same, never-remounted cards', async () => {
    readArtifact.mockResolvedValue({ artifact: { id: 'a2', type: 'code', title: 'Alpha flow', content: 'body' } });
    await mount();
    const card = allByTestId('artifact-library-card')[1] ?? null;
    await click(card);

    expect(readArtifact).toHaveBeenCalledWith('a2');
    expect(byTestId('artifact-library-browse')?.hasAttribute('inert')).toBe(true);
    expect(byTestId('artifact-library-detail-title')?.textContent).toBe('Alpha flow');
    expect(byTestId('artifact-library-detail-description')?.textContent).toBe('Login steps');
    expect(byTestId('chat-artifact-card')).not.toBeNull();
    expect(document.activeElement).toBe(byTestId('artifact-library-detail-back-btn'));

    await click(byTestId('artifact-library-detail-back-btn'));
    expect(byTestId('artifact-library-detail')).toBeNull();
    expect(byTestId('artifact-library-browse')?.hasAttribute('inert')).toBe(false);
    expect(titles()).toHaveLength(3);
    expect(allByTestId('artifact-library-card')[1]).toBe(card);
    expect(document.activeElement).toBe(card);

    // Opened again from what it already fetched.
    await click(allByTestId('artifact-library-card')[1] ?? null);
    expect(readArtifact).toHaveBeenCalledTimes(1);
  });

  it('goes back to the grid on Escape', async () => {
    readArtifact.mockResolvedValue({ artifact: { id: 'a3', type: 'code', title: 'Gamma page', content: 'body' } });
    await mount();
    await click(allByTestId('artifact-library-card')[0] ?? null);
    expect(byTestId('artifact-library-detail')).not.toBeNull();

    await act(async () => {
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
    });
    expect(byTestId('artifact-library-detail')).toBeNull();
  });

  it('shows an opened card that cannot be read, with a retry', async () => {
    readArtifact.mockResolvedValueOnce({ error: 'Gone.' });
    await mount();
    await click(allByTestId('artifact-library-card')[0] ?? null);
    expect(byTestId('artifact-library-detail-error')?.textContent).toContain('Gone.');

    readArtifact.mockResolvedValueOnce({ artifact: { id: 'a3', type: 'code', title: 'Gamma page', content: 'body' } });
    await click(byTestId('artifact-library-detail-retry-btn'));
    expect(readArtifact).toHaveBeenCalledTimes(2);
    expect(byTestId('chat-artifact-card')).not.toBeNull();
  });
});
