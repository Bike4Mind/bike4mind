// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { CssVarsProvider } from '@mui/joy/styles';
import type { ClaudeImportState } from '@shared/claudeImport';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ClaudeImportSettings, useClaudeImport } from './ClaudeImportSettings';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
window.matchMedia ??= ((media: string) => ({
  matches: false,
  media,
  onchange: null,
  addListener: () => {},
  removeListener: () => {},
  addEventListener: () => {},
  removeEventListener: () => {},
  dispatchEvent: () => false,
})) as typeof window.matchMedia;
const ready: ClaudeImportState = {
  signedIn: true,
  code: {
    settings: { enabled: false, sourceFolder: null, projects: 'all', includeSubagents: false },
    sourceFolder: '/home/.claude/projects',
    running: false,
    lastSyncAt: null,
    lastSyncMs: null,
    counts: { found: 0, imported: 0, skipped: 0, failed: 0 },
    forked: 0,
    projects: [],
  },
  chat: { watchFolder: null, running: false, lastImport: null },
};
const getState = vi.fn<() => Promise<ClaudeImportState>>();
const listeners = new Set<(state: ClaudeImportState) => void>();
let root: Root;
let host: HTMLElement;
function Harness() {
  const [state, setState, error, retry] = useClaudeImport();
  return (
    <CssVarsProvider>
      <ClaudeImportSettings state={state} onState={setState} loadError={error} onRetry={retry} />
    </CssVarsProvider>
  );
}
async function mount() {
  await act(async () => root.render(<Harness />));
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => {
    resolve = done;
  });
  return { promise, resolve };
}
beforeEach(() => {
  getState.mockReset();
  listeners.clear();
  Object.assign(window, {
    b4m: {
      claudeImport: {
        getState,
        onStateChanged: (listener: (state: ClaudeImportState) => void) => {
          listeners.add(listener);
          return () => listeners.delete(listener);
        },
      },
    },
  });
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
});
afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
});
describe('reading import settings', () => {
  it('shows a failed read and lets the user retry successfully', async () => {
    getState.mockRejectedValueOnce(new Error('disk unavailable')).mockResolvedValueOnce(ready);
    await mount();
    expect(host.querySelector('[data-testid="claude-import-load-error"]')?.textContent).toContain('disk unavailable');
    expect(host.querySelector('[data-testid="claude-import-loading"]')).toBeNull();
    await act(async () => host.querySelector<HTMLButtonElement>('[data-testid="claude-import-retry-btn"]')?.click());
    expect(getState).toHaveBeenCalledTimes(2);
    expect(host.querySelector('[data-testid="claude-import-load-error"]')).toBeNull();
    expect(host.querySelector('[data-testid="claude-import-settings"]')).not.toBeNull();
  });
  it('keeps a pushed state when the older initial read finishes later', async () => {
    const pending = deferred<ClaudeImportState>();
    getState.mockReturnValue(pending.promise);
    await mount();
    await act(async () => {
      for (const listener of listeners) listener(ready);
    });
    await act(async () => pending.resolve({ ...ready, signedIn: false }));
    expect(host.querySelector('[data-testid="claude-import-signed-out-alert"]')).toBeNull();
    expect(host.querySelector('[data-testid="claude-import-settings"]')).not.toBeNull();
  });
  it('a state push clears an earlier load error', async () => {
    getState.mockRejectedValue(new Error('disconnected'));
    await mount();
    await act(async () => {
      for (const listener of listeners) listener(ready);
    });
    expect(host.querySelector('[data-testid="claude-import-load-error"]')).toBeNull();
    expect(host.querySelector('[data-testid="claude-import-settings"]')).not.toBeNull();
  });
});
