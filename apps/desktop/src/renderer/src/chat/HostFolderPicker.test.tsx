// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { CssVarsProvider } from '@mui/joy/styles';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { FolderListing } from '../host/hostChat';
import { desktopTheme } from '../theme';
import { HostFolderPicker, type FolderSource } from './HostFolderPicker';

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
window.getComputedStyle = ((element: Element) => (element as HTMLElement).style) as typeof getComputedStyle;

const listings: Record<string, FolderListing> = {
  '/home/me': {
    path: '/home/me',
    parent: '/home',
    entries: [
      { name: 'app', path: '/home/me/app', isGitRepository: true },
      { name: '.cache', path: '/home/me/.cache', isGitRepository: false, isHidden: true },
    ],
  },
  '/home/me/app': { path: '/home/me/app', parent: '/home/me', entries: [], truncated: true },
  '/home': { path: '/home', parent: null, entries: [{ name: 'me', path: '/home/me', isGitRepository: false }] },
};

const byTestId = (id: string) => document.querySelector<HTMLElement>(`[data-testid="${id}"]`);
const allByTestId = (id: string) => [...document.querySelectorAll<HTMLElement>(`[data-testid="${id}"]`)];
const flush = () => act(async () => undefined);

let root: Root | null = null;

async function mount(source: FolderSource) {
  const onPick = vi.fn();
  const onClose = vi.fn();
  root = createRoot(document.body.appendChild(document.createElement('div')));
  await act(async () =>
    root?.render(
      <CssVarsProvider theme={desktopTheme}>
        <HostFolderPicker hostId="devbox" hostLabel="Devbox" onPick={onPick} onClose={onClose} source={source} />
      </CssVarsProvider>
    )
  );
  await flush();
  return { onPick, onClose };
}

const fakeSource = (overrides: Partial<FolderSource> = {}): FolderSource => ({
  browse: vi.fn(async (_hostId: string, path?: string) => listings[path ?? '/home/me']),
  recent: vi.fn(async () => [{ path: '/srv/api', name: 'api' }]),
  ...overrides,
});

afterEach(() => {
  act(() => root?.unmount());
  root = null;
  document.body.innerHTML = '';
});

describe('HostFolderPicker', () => {
  it('starts at the host home, hides dot folders and offers recent folders first', async () => {
    const source = fakeSource();
    await mount(source);
    expect(source.browse).toHaveBeenCalledWith('devbox', undefined);
    expect(source.recent).toHaveBeenCalledWith('devbox');
    expect(byTestId('host-folder-picker-path')?.textContent).toBe('/home/me');
    expect(allByTestId('host-folder-picker-entry').map(entry => entry.textContent)).toEqual(['appgit']);
    expect(allByTestId('host-folder-picker-recent-item').map(item => item.textContent)).toEqual(['api']);
  });

  it('walks into a folder, back up, and picks the folder it is in', async () => {
    const { onPick } = await mount(fakeSource());
    await act(async () => allByTestId('host-folder-picker-entry')[0].click());
    expect(byTestId('host-folder-picker-path')?.textContent).toBe('/home/me/app');
    expect(byTestId('host-folder-picker-empty')).not.toBeNull();
    expect(byTestId('host-folder-picker-truncated')).not.toBeNull();
    await act(async () => byTestId('host-folder-picker-up-btn')?.click());
    expect(byTestId('host-folder-picker-path')?.textContent).toBe('/home/me');
    await act(async () => byTestId('host-folder-picker-choose-btn')?.click());
    expect(onPick).toHaveBeenCalledWith('/home/me');
  });

  it('picks a recent folder in one click', async () => {
    const { onPick } = await mount(fakeSource());
    await act(async () => allByTestId('host-folder-picker-recent-item')[0].click());
    expect(onPick).toHaveBeenCalledWith('/srv/api');
  });

  it('shows a browse failure and keeps working without the recent list', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    await mount(
      fakeSource({
        browse: vi.fn(async () => {
          throw new Error('Permission denied');
        }),
        recent: vi.fn(async () => {
          throw new Error('offline');
        }),
      })
    );
    expect(byTestId('host-folder-picker-error')?.textContent).toContain('Permission denied');
    expect(byTestId('host-folder-picker-choose-btn')?.hasAttribute('disabled')).toBe(true);
    expect(allByTestId('host-folder-picker-recent-item')).toHaveLength(0);
    warn.mockRestore();
  });

  it('cancels', async () => {
    const { onClose } = await mount(fakeSource());
    await act(async () => byTestId('host-folder-picker-cancel-btn')?.click());
    expect(onClose).toHaveBeenCalled();
  });
});
