// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { CssVarsProvider } from '@mui/joy/styles';
import { initialUpdateState, reduceUpdate } from '@shared/update';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { desktopTheme } from '../theme';
import { ChatShell } from './ChatShell';
import { AppUpdateNotice } from './UpdateNotice';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

vi.mock('./CustomizePanel', () => ({ CustomizeNavItem: () => null, CustomizeScreen: () => null }));
vi.mock('./Composer', () => ({ Composer: () => null }));

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

window.ResizeObserver ??= class {
  observe() {}
  unobserve() {}
  disconnect() {}
} as unknown as typeof ResizeObserver;

const offered = reduceUpdate(initialUpdateState('0.1.10', true), { type: 'available', version: '0.2.0', at: 1 });

function quietBridge(overrides: Record<string, unknown>) {
  return new Proxy(overrides, {
    get(target, name: string | symbol) {
      if (typeof name !== 'string') return undefined;
      if (name in target) return target[name];
      if (name.startsWith('on')) return () => () => undefined;
      return async () => [];
    },
  });
}

let root: Root | null = null;
let host: HTMLElement | null = null;

beforeEach(() => {
  Element.prototype.scrollIntoView = () => undefined;
  vi.stubGlobal(
    'IntersectionObserver',
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
      takeRecords() {
        return [];
      }
    }
  );
  const namespaces: Record<string, unknown> = {
    chat: quietBridge({
      defaultsForNewSession: async () => ({ model: 'test-model', approvalMode: 'auto', reasoningEffort: 'default' }),
      listModels: async () => ({ models: [] }),
    }),
    sidebar: quietBridge({ getSections: async () => ({ sections: [], assignments: {} }) }),
    update: quietBridge({ getState: async () => offered }),
  };
  (window as unknown as { b4m: unknown }).b4m = new Proxy(namespaces, {
    get(target, name: string | symbol) {
      if (typeof name !== 'string') return undefined;
      return name in target ? target[name] : quietBridge({});
    },
  });
});

afterEach(() => {
  act(() => root?.unmount());
  host?.remove();
  root = null;
  host = null;
  vi.unstubAllGlobals();
});

async function mount() {
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
  await act(async () => {
    root?.render(
      <CssVarsProvider theme={desktopTheme}>
        <ChatShell account={() => <AppUpdateNotice placement="sidebar" />} />
      </CssVarsProvider>
    );
  });
  await act(async () => undefined);
}

const notices = () => Array.from(document.querySelectorAll<HTMLElement>('[data-testid="update-notice"]'));

describe('the update notice and the sidebar', () => {
  it('sits in the account footer while the sidebar is open, and floats lower-left while it is collapsed', async () => {
    await mount();
    expect(notices()).toHaveLength(1);
    expect(document.querySelector('[data-testid="sidebar"]')?.contains(notices()[0])).toBe(true);
    expect(getComputedStyle(notices()[0]).position).not.toBe('fixed');

    await act(async () => document.querySelector<HTMLElement>('[data-testid="sidebar-toggle-btn"]')?.click());
    await act(async () => undefined);
    expect(document.querySelector('[data-testid="sidebar-rail"]')).not.toBeNull();
    expect(notices()).toHaveLength(1);
    expect(getComputedStyle(notices()[0]).position).toBe('fixed');

    await act(async () => document.querySelector<HTMLElement>('[data-testid="sidebar-toggle-btn"]')?.click());
    await act(async () => undefined);
    expect(notices()).toHaveLength(1);
    expect(getComputedStyle(notices()[0]).position).not.toBe('fixed');
  });
});
