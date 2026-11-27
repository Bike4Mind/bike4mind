// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { CssVarsProvider } from '@mui/joy/styles';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SettingsScreen } from './SettingsPanel';
import type { SettingsSection } from './settingsNavigation';

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

/**
 * Every preload call the page's settings make on mount, answered with a promise that never settles
 * and a no-op unsubscribe: what is under test is the screen's search and links, not each setting.
 */
function silentBridge(): unknown {
  const node: unknown = new Proxy(() => {}, {
    get: (_target, key) => (key === 'then' ? undefined : node),
    apply: () => pending,
  });
  const pending: unknown = new Proxy(() => {}, {
    get: (_target, key) => (key === 'then' ? () => pending : pending),
    apply: () => pending,
  });
  return node;
}

let root: Root | null = null;
let host: HTMLElement | null = null;

beforeEach(() => {
  Object.defineProperty(window, 'b4m', { value: silentBridge(), configurable: true });
});

afterEach(() => {
  act(() => root?.unmount());
  host?.remove();
  root = null;
  host = null;
});

function mount(props: { section?: SettingsSection; onSection?: (section: SettingsSection) => void } = {}) {
  const onOpenSetting = vi.fn();
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
  act(() =>
    root?.render(
      <CssVarsProvider>
        <SettingsScreen auth={null} onClose={() => {}} onOpenSetting={onOpenSetting} {...props} />
      </CssVarsProvider>
    )
  );
  return { onOpenSetting };
}

const q = (testId: string) => host?.querySelector(`[data-testid="${testId}"]`) ?? null;

function search(value: string) {
  const input = q('settings-search-input') as HTMLInputElement;
  const setValue = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
  act(() => {
    setValue?.call(input, value);
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
  return input;
}

describe('searching Settings', () => {
  it('shows matches from every page, grouped by page, with the real controls', () => {
    mount();
    search('sound');
    expect(q('settings-page-search')).not.toBeNull();
    expect(q('settings-results-notifications')?.textContent).toContain('Notifications and sounds');
    expect(q('settings-orchestrator-sound-switch')).not.toBeNull();
    expect(q('settings-search-count')?.textContent).toMatch(/^\d+ settings?$/);
    expect(host?.querySelector('[aria-current="page"], .Mui-selected')).toBeNull();
  });

  it('reaches About too', () => {
    mount();
    search('version');
    expect(q('settings-results-about')).not.toBeNull();
    expect(q('settings-result-open-updates-btn')?.textContent).toBe('Open in About and updates');
  });

  it('says so when nothing matches', () => {
    mount();
    search('zzzz nothing');
    expect(q('settings-search-empty')?.textContent).toBe('No settings match. Try "sound", "theme" or "version".');
  });

  it('opens a result on its own page and clears the query', () => {
    const { onOpenSetting } = mount();
    const input = search('theme');
    act(() => (q('settings-result-open-appearance-btn') as HTMLButtonElement).click());
    expect(onOpenSetting).toHaveBeenCalledWith({ section: 'general', setting: 'appearance' });
    expect(input.value).toBe('');
    expect(q('settings-page-general')).not.toBeNull();
  });

  it('clears on Escape', () => {
    mount();
    const input = search('theme');
    act(() => {
      input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    });
    expect(input.value).toBe('');
    expect(q('settings-page-search')).toBeNull();
  });

  it('focuses the box on Mod+F', () => {
    mount();
    act(() => {
      window.dispatchEvent(new KeyboardEvent('keydown', { code: 'KeyF', key: 'f', metaKey: true, bubbles: true }));
    });
    expect(document.activeElement).toBe(q('settings-search-input'));
  });

  it('clears the query when a page is picked from the nav', () => {
    const onSection = vi.fn();
    mount({ onSection });
    const input = search('theme');
    act(() => (q('settings-nav-models-btn') as HTMLElement).click());
    expect(onSection).toHaveBeenCalledWith('models');
    expect(input.value).toBe('');
  });
});
