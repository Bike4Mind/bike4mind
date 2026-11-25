// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { CssVarsProvider, extendTheme } from '@mui/joy/styles';
import type { ClaudeImportState, SyncHintId } from '@shared/claudeImport';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SidebarSyncHints } from './SyncHints';

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

const counts = { found: 0, imported: 0, skipped: 0, failed: 0 };

function stateWith({
  signedIn = true,
  code = false,
  web = false,
  codeSessions = 12 as number | null,
  webNotebooks = 30 as number | null,
  dismissed = [] as SyncHintId[],
} = {}): ClaudeImportState {
  return {
    signedIn,
    hints: { dismissed, codeSessions, webNotebooks },
    code: {
      settings: { enabled: code, sourceFolder: null, projects: 'all', includeSubagents: false },
      sourceFolder: '/home/.claude/projects',
      running: false,
      lastSyncAt: null,
      lastSyncMs: null,
      counts,
      forked: 0,
      projects: [],
    },
    chat: { watchFolder: null, running: false, lastImport: null },
    web: { settings: { enabled: web }, running: false, lastSyncAt: null, lastSyncMs: null, counts, forked: 0 },
  };
}

let current: ClaudeImportState;
const dismissHint = vi.fn(async (id: SyncHintId) => {
  current = { ...current, hints: { ...current.hints, dismissed: [...current.hints.dismissed, id] } };
  return current;
});
const setCodeSettings = vi.fn(async (patch: { enabled?: boolean }) => {
  current = { ...current, code: { ...current.code, settings: { ...current.code.settings, ...patch } } };
  return current;
});
const setWebSettings = vi.fn(async (patch: { enabled?: boolean }) => {
  current = { ...current, web: { ...current.web, settings: { enabled: patch.enabled === true } } };
  return current;
});
const syncWeb = vi.fn(async () => {
  current = { ...current, web: { ...current.web, lastSyncAt: new Date().toISOString() } };
  return current;
});
const openExternal = vi.fn(async () => undefined);
const onOpenSettings = vi.fn();
let root: Root;
let host: HTMLElement;

const theme = extendTheme({});

async function mount(state: ClaudeImportState, empty: boolean, showWebSync = false) {
  current = state;
  Object.assign(window, {
    b4m: {
      shell: { openExternal },
      claudeImport: {
        getState: async () => current,
        onStateChanged: () => () => undefined,
        dismissHint,
        setCodeSettings,
        setWebSettings,
        syncWeb,
      },
    },
  });
  await act(async () =>
    root.render(
      <CssVarsProvider theme={theme}>
        <SidebarSyncHints
          empty={empty}
          fallback={<span data-testid="chat-sessions-empty">No conversations yet.</span>}
          showWebSync={showWebSync}
          onOpenSettings={onOpenSettings}
        />
      </CssVarsProvider>
    )
  );
}

const query = (testId: string) => host.querySelector<HTMLElement>(`[data-testid="${testId}"]`);
const click = (testId: string) => act(async () => query(testId)?.click());

beforeEach(() => {
  vi.clearAllMocks();
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
});

afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
});

describe('empty sidebar card', () => {
  it('replaces the empty line and opens Settings at each source', async () => {
    await mount(stateWith(), true);
    expect(query('sidebar-empty-sync-card')).not.toBeNull();
    expect(query('chat-sessions-empty')).toBeNull();
    expect(query('sync-hint-claude-code')).toBeNull();
    expect(query('sync-hint-web')).toBeNull();

    await click('sidebar-empty-sync-code-btn');
    await click('sidebar-empty-sync-chat-btn');
    await click('sidebar-empty-sync-web-settings-link');
    expect(onOpenSettings.mock.calls).toEqual([['claude-code'], ['claude-chat'], ['b4m-web']]);
    expect(setWebSettings).not.toHaveBeenCalled();

    await click('sidebar-empty-sync-export-help-link');
    expect(openExternal).toHaveBeenCalledWith(expect.stringContaining('export'));
  });

  it('turns web sync on from the card, which then hands the sidebar to the status line', async () => {
    await mount(stateWith(), true, true);
    await click('sidebar-empty-sync-web-btn');
    expect(setWebSettings).toHaveBeenCalledExactlyOnceWith({ enabled: true });
    expect(onOpenSettings).not.toHaveBeenCalled();
    expect(query('sidebar-empty-sync-web-btn')).toBeNull();
    expect(query('sidebar-web-sync-status')?.dataset.kind).not.toBe('off');
  });

  it('offers only what there is to bring in', async () => {
    await mount(stateWith({ codeSessions: 0, webNotebooks: 0 }), true);
    expect(query('sidebar-empty-sync-chat-btn')).not.toBeNull();
    expect(query('sidebar-empty-sync-code-btn')).toBeNull();
    expect(query('sidebar-empty-sync-web-btn')).toBeNull();
  });

  it('leaves out a source whose sync is already on', async () => {
    await mount(stateWith({ code: true, web: true }), true);
    expect(query('sidebar-empty-sync-code-btn')).toBeNull();
    expect(query('sidebar-empty-sync-web-btn')).toBeNull();
  });

  it('is gone for good once closed without revealing another prompt', async () => {
    await mount(stateWith(), true);
    await click('sidebar-empty-sync-card-close-btn');
    expect(dismissHint).toHaveBeenCalledWith('sidebar-empty');
    expect(query('sidebar-empty-sync-card')).toBeNull();
    expect(query('chat-sessions-empty')).not.toBeNull();
    expect(query('sync-hint-claude-code')).toBeNull();
    expect(query('sync-hint-web')).toBeNull();
  });

  it('is not shown while signed out', async () => {
    await mount(stateWith({ signedIn: false }), true);
    expect(query('sidebar-empty-sync-card')).toBeNull();
    expect(query('chat-sessions-empty')).not.toBeNull();
  });
});

describe('single sidebar prompt', () => {
  it.each([
    ['both sources', {}],
    ['Claude Code only', { webNotebooks: 0 }],
    ['web only', { codeSessions: 0 }],
  ])('does not prompt in a populated sidebar with %s', async (_label, options) => {
    await mount(stateWith(options), false);
    expect(query('sidebar-empty-sync-card')).toBeNull();
    expect(query('sync-hint-claude-code')).toBeNull();
    expect(query('sync-hint-web')).toBeNull();
    expect(setCodeSettings).not.toHaveBeenCalled();
    expect(setWebSettings).not.toHaveBeenCalled();
  });

  it('does not replace a previously dismissed card with source prompts', async () => {
    await mount(stateWith({ dismissed: ['sidebar-empty'] }), true);
    expect(query('sidebar-empty-sync-card')).toBeNull();
    expect(query('sync-hint-claude-code')).toBeNull();
    expect(query('sync-hint-web')).toBeNull();
    expect(query('chat-sessions-empty')).not.toBeNull();
  });
});

describe('hint card accessibility', () => {
  it('labels the card as a region by its heading', async () => {
    await mount(stateWith(), true);
    const card = query('sidebar-empty-sync-card');
    expect(card?.getAttribute('role')).toBe('region');
    const heading = document.getElementById(card?.getAttribute('aria-labelledby') ?? '');
    expect(heading?.textContent).toContain('Bring your chats along');
  });
});

describe('web sync status line', () => {
  const synced = (lastSyncAt: string | null, extra: Partial<ClaudeImportState['web']> = {}) => {
    const state = stateWith({ web: true });
    return { ...state, web: { ...state.web, lastSyncAt, ...extra } };
  };
  const text = () => query('sidebar-web-sync-text')?.textContent;

  it('stays out of lists that are not chat lists', async () => {
    await mount(synced(new Date().toISOString()), false, false);
    expect(query('sidebar-web-sync-status')).toBeNull();
  });

  it('says when the web last synced, above the list, and syncs again on demand', async () => {
    await mount(synced(new Date(Date.now() - 5 * 60_000).toISOString()), false, true);
    expect(text()).toBe('Synced from web - 5m ago');
    await click('sidebar-web-sync-now-btn');
    expect(syncWeb).toHaveBeenCalledOnce();
    expect(text()).toBe('Synced from web - just now');
  });

  it('explains a sync that has never run and offers Sync now', async () => {
    await mount(synced(null), false, true);
    expect(text()).toBe('Not synced from web yet');
    await click('sidebar-web-sync-now-btn');
    expect(syncWeb).toHaveBeenCalledOnce();
  });

  it('shows a running sync without a second trigger', async () => {
    await mount(synced(null, { running: true }), false, true);
    expect(text()).toBe('Syncing from web...');
    expect(query('sidebar-web-sync-now-btn')).toBeNull();
  });

  it('counts a long first sync through the notebooks it has to read', async () => {
    await mount(synced(null, { running: true, progress: { done: 125, total: 1274 } }), false, true);
    expect(text()).toBe(`Syncing from web - 125 of ${(1274).toLocaleString()}`);
  });

  it('says only "Syncing" while the run is still listing notebooks', async () => {
    await mount(synced(null, { running: true, progress: { done: 0, total: 0 } }), false, true);
    expect(text()).toBe('Syncing from web...');
  });

  it('shows a failed sync, with a retry', async () => {
    await mount(
      synced(new Date().toISOString(), { error: 'Could not read your notebooks from Bike4Mind web.' }),
      false,
      true
    );
    expect(text()).toBe('Could not sync from web');
    await click('sidebar-web-sync-now-btn');
    expect(syncWeb).toHaveBeenCalledOnce();
  });

  it('offers Turn on to a user with web notebooks but sync off', async () => {
    await mount(stateWith({ webNotebooks: 30 }), false, true);
    expect(text()).toBe('Web conversations not synced');
    await click('sidebar-web-sync-turn-on-btn');
    expect(setWebSettings).toHaveBeenCalledExactlyOnceWith({ enabled: true });
    expect(onOpenSettings).not.toHaveBeenCalled();
    expect(query('sidebar-web-sync-status')?.dataset.kind).not.toBe('off');
  });

  it('keeps offering Turn on after the empty-sidebar card was dismissed', async () => {
    await mount(stateWith({ dismissed: ['sidebar-empty'] }), true, true);
    expect(query('sidebar-empty-sync-card')).toBeNull();
    expect(query('sidebar-web-sync-turn-on-btn')).not.toBeNull();
  });

  it.each([
    ['the web has no notebooks', stateWith({ webNotebooks: 0 })],
    ['the user is signed out', stateWith({ signedIn: false })],
  ])('says nothing when %s', async (_, state) => {
    await mount(state, false, true);
    expect(query('sidebar-web-sync-status')).toBeNull();
  });

  it('leaves the "not synced" pointer to the empty-sidebar card when the card offers web', async () => {
    await mount(stateWith(), true, true);
    expect(query('sidebar-empty-sync-web-btn')).not.toBeNull();
    expect(query('sidebar-web-sync-status')).toBeNull();
  });

  it('keeps the status above the empty-sidebar card once sync is on', async () => {
    await mount(synced(new Date().toISOString()), true, true);
    expect(text()).toBe('Synced from web - just now');
    const status = query('sidebar-web-sync-status');
    const card = query('sidebar-empty-sync-card');
    expect(card).not.toBeNull();
    expect(status!.compareDocumentPosition(card!) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });
});
