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

const listArtifacts = vi.fn<() => Promise<ChatArtifactLibrary>>();
const readArtifact = vi.fn<(id: string) => Promise<ChatArtifactContent>>();

let root: Root | null = null;
let host: HTMLElement | null = null;

beforeEach(() => {
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
const titles = () => allByTestId('artifact-library-row-title').map(node => node.textContent);

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

  it('lists newest first with an initial avatar and a type label per row', async () => {
    await mount();
    expect(titles()).toEqual(['Gamma page', 'Alpha flow', 'Beta chart']);
    expect(allByTestId('artifact-library-row-avatar').map(node => node.textContent)).toEqual(['G', 'A', 'B']);
    expect(allByTestId('artifact-library-row-type').map(node => node.textContent)).toEqual(['HTML', 'Diagram', 'HTML']);
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

  it('fetches a body only when its row is opened, and only once', async () => {
    readArtifact.mockResolvedValue({ artifact: { id: 'a3', type: 'code', title: 'Gamma page', content: 'body' } });
    await mount();
    expect(readArtifact).not.toHaveBeenCalled();

    const [first] = allByTestId('artifact-library-row-summary');
    await click(first ?? null);
    expect(readArtifact).toHaveBeenCalledTimes(1);
    expect(readArtifact).toHaveBeenCalledWith('a3');
    expect(byTestId('artifact-library-row-detail')).not.toBeNull();

    await click(first ?? null);
    expect(byTestId('artifact-library-row-detail')).toBeNull();
    await click(allByTestId('artifact-library-row-expand-btn')[0] ?? null);
    expect(byTestId('artifact-library-row-detail')).not.toBeNull();
    expect(readArtifact).toHaveBeenCalledTimes(1);
  });

  it('keeps an opened row open and fetched when a filter hides it and brings it back', async () => {
    readArtifact.mockResolvedValue({ artifact: { id: 'a2', type: 'code', title: 'Alpha flow', content: 'body' } });
    await mount();
    await click(allByTestId('artifact-library-row-summary')[1] ?? null);
    expect(readArtifact).toHaveBeenCalledWith('a2');

    await click(byTestId('artifact-library-filter-html-chip'));
    expect(byTestId('artifact-library-row-detail')).toBeNull();
    await click(byTestId('artifact-library-filter-html-chip'));
    expect(byTestId('artifact-library-row-description')?.textContent).toBe('Login steps');
    expect(readArtifact).toHaveBeenCalledTimes(1);
  });

  it('shows a row-level error when a body cannot be read', async () => {
    readArtifact.mockResolvedValue({ error: 'Gone.' });
    await mount();
    await click(allByTestId('artifact-library-row-summary')[0] ?? null);
    expect(byTestId('artifact-library-row-error')?.textContent).toBe('Gone.');
  });
});
