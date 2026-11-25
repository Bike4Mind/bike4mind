// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { CssVarsProvider } from '@mui/joy/styles';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { LibraryApi, LibraryItem, LibraryPage } from '@shared/library';
import { LibraryMain, LibrarySidebar } from './LibraryPlace';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

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

let root: Root | null = null;
let host: HTMLElement | null = null;

afterEach(() => {
  act(() => root?.unmount());
  host?.remove();
  root = null;
  host = null;
});

async function mount(node: React.ReactNode) {
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
  await act(async () => root?.render(<CssVarsProvider>{node}</CssVarsProvider>));
}

const byTestId = (id: string) => document.querySelector<HTMLElement>(`[data-testid="${id}"]`);
const flush = () => act(async () => {});

const image = (id: string, minute: number, extra: Partial<LibraryItem> = {}): LibraryItem => ({
  id,
  medium: 'image',
  prompt: `prompt ${id}`,
  model: 'img',
  createdAt: new Date(Date.UTC(2026, 0, 1, 0, minute)).toISOString(),
  availability: 'ready',
  contentType: 'image/png',
  ...extra,
});

function fakeApi(pages: Partial<Record<'image' | 'video', LibraryPage[]>>, overrides: Partial<LibraryApi> = {}) {
  const queues = { image: [...(pages.image ?? [])], video: [...(pages.video ?? [])] };
  const api: LibraryApi = {
    page: vi.fn<LibraryApi['page']>(async ({ medium }) => queues[medium].shift() ?? { items: [], nextCursor: null }),
    media: vi.fn<LibraryApi['media']>(async ({ id }) => ({
      url: `b4m-media://library-cache/${id}.png`,
      mimeType: 'image/png',
    })),
    locate: vi.fn(async () => null),
    ...overrides,
  };
  return api;
}

const main = (api: LibraryApi, extra: Partial<React.ComponentProps<typeof LibraryMain>> = {}) => (
  <LibraryMain filter="all" accountKey="a" api={api} onOpenSession={() => {}} onOpenStudio={() => {}} {...extra} />
);

describe('the Library place', () => {
  it('lists the filters in its sidebar and reports a pick', async () => {
    const onSelectFilter = vi.fn();
    await mount(
      <LibrarySidebar width={240} filter="all" onSelectFilter={onSelectFilter} onToggleCollapsed={() => {}} />
    );
    expect(byTestId('sidebar-place-title')?.textContent).toBe('Library');
    act(() => byTestId('library-filter-video-btn')?.click());
    expect(onSelectFilter).toHaveBeenCalledExactlyOnceWith('video');
  });

  it('shows both media merged newest first, with thumbnails from the local cache', async () => {
    const api = fakeApi({
      image: [{ items: [image('i2', 20), image('i1', 10)], nextCursor: null }],
      video: [
        {
          items: [{ ...image('v1', 15), medium: 'video', contentType: 'video/mp4', durationSeconds: 4 }],
          nextCursor: null,
        },
      ],
    });
    await mount(main(api));
    await flush();
    const tiles = [...document.querySelectorAll('[data-testid="library-grid"] > [data-testid^="library-tile-"]')];
    expect(tiles.map(node => node.getAttribute('data-testid'))).toEqual([
      'library-tile-image-i2',
      'library-tile-video-v1',
      'library-tile-image-i1',
    ]);
    expect(byTestId('library-tile-video-v1')?.textContent).toContain('4s video');
    // Thumbnails for images only: a video is downloaded when it is opened.
    expect(
      vi
        .mocked(api.media)
        .mock.calls.map(call => call[0].id)
        .sort()
    ).toEqual(['i1', 'i2']);
    expect(byTestId('library-load-more-btn')).toBeNull();
  });

  it('loads the next page only when asked', async () => {
    const api = fakeApi({
      image: [
        { items: [image('i2', 20)], nextCursor: 'c2' },
        { items: [image('i1', 10)], nextCursor: null },
      ],
    });
    await mount(main(api, { filter: 'image' }));
    await flush();
    expect(api.page).toHaveBeenCalledTimes(1);
    await act(async () => byTestId('library-load-more-btn')?.click());
    expect(api.page).toHaveBeenLastCalledWith({ medium: 'image', cursor: 'c2' });
    expect(byTestId('library-tile-image-i1')).not.toBeNull();
    expect(byTestId('library-load-more-btn')).toBeNull();
  });

  it('shows an empty state that leads to Studio', async () => {
    const onOpenStudio = vi.fn();
    await mount(main(fakeApi({}), { filter: 'video', onOpenStudio }));
    await flush();
    expect(byTestId('library-empty')?.textContent).toContain('No videos yet');
    act(() => byTestId('library-open-studio-btn')?.click());
    expect(onOpenStudio).toHaveBeenCalledTimes(1);
  });

  it('shows an error state, does not retry on its own, and retries on Try again', async () => {
    const page = vi
      .fn<LibraryApi['page']>()
      .mockRejectedValueOnce(
        new Error("Error invoking remote method 'library:page': Error: Sign in to see your Library.")
      )
      .mockResolvedValue({ items: [image('i1', 1)], nextCursor: null });
    const api = fakeApi({}, { page });
    await mount(main(api, { filter: 'image' }));
    await flush();
    await flush();
    expect(byTestId('library-error')?.textContent).toContain('Sign in to see your Library.');
    expect(page).toHaveBeenCalledTimes(1);
    await act(async () => byTestId('library-retry-btn')?.click());
    await flush();
    expect(byTestId('library-tile-image-i1')).not.toBeNull();
  });

  it('opens an item full size, with a jump to its Studio session when one is known', async () => {
    const onOpenSession = vi.fn();
    const api = fakeApi(
      { image: [{ items: [image('i1', 1)], nextCursor: null }] },
      { locate: vi.fn(async () => ({ sessionId: 'studio-1' })) }
    );
    await mount(main(api, { filter: 'image', onOpenSession }));
    await flush();
    await act(async () => byTestId('library-tile-image-i1')?.click());
    await flush();
    expect(byTestId('library-viewer-image')?.getAttribute('src')).toBe('b4m-media://library-cache/i1.png');
    await act(async () => byTestId('library-viewer-open-session-btn')?.click());
    expect(onOpenSession).toHaveBeenCalledExactlyOnceWith('studio-1');
    expect(byTestId('library-viewer')).toBeNull();
  });

  it('offers no jump for an item made elsewhere', async () => {
    const api = fakeApi({ image: [{ items: [image('i1', 1)], nextCursor: null }] });
    await mount(main(api, { filter: 'image' }));
    await flush();
    await act(async () => byTestId('library-tile-image-i1')?.click());
    await flush();
    expect(byTestId('library-viewer')).not.toBeNull();
    expect(byTestId('library-viewer-open-session-btn')).toBeNull();
  });
});
