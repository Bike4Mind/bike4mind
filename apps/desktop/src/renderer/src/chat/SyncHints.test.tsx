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
const openExternal = vi.fn(async () => undefined);
const onOpenSettings = vi.fn();
let root: Root;
let host: HTMLElement;

async function mount(state: ClaudeImportState, empty: boolean) {
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
      },
    },
  });
  await act(async () =>
    root.render(
      <CssVarsProvider theme={extendTheme({})}>
        <SidebarSyncHints
          empty={empty}
          fallback={<span data-testid="chat-sessions-empty">No conversations yet.</span>}
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
    await click('sidebar-empty-sync-web-btn');
    expect(onOpenSettings.mock.calls).toEqual([['claude-code'], ['claude-chat'], ['b4m-web']]);

    await click('sidebar-empty-sync-export-help-link');
    expect(openExternal).toHaveBeenCalledWith(expect.stringContaining('export'));
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
