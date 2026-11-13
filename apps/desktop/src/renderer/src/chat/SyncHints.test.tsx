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

  it('is gone for good once closed, making way for a source hint', async () => {
    await mount(stateWith(), true);
    await click('sidebar-empty-sync-card-close-btn');
    expect(dismissHint).toHaveBeenCalledWith('sidebar-empty');
    expect(query('sidebar-empty-sync-card')).toBeNull();
    expect(query('chat-sessions-empty')).not.toBeNull();
    expect(query('sync-hint-claude-code')).not.toBeNull();
  });

  it('is not shown while signed out', async () => {
    await mount(stateWith({ signedIn: false }), true);
    expect(query('sidebar-empty-sync-card')).toBeNull();
    expect(query('chat-sessions-empty')).not.toBeNull();
  });
});

describe('Claude Code hint', () => {
  it('shows the session count when sync is off', async () => {
    await mount(stateWith(), false);
    expect(query('sync-hint-claude-code')?.textContent).toContain('Found 12 Claude Code sessions');
    expect(query('sync-hint-web')).toBeNull();
  });

  it('turns sync on and does not come back', async () => {
    await mount(stateWith(), false);
    await click('sync-hint-claude-code-enable-btn');
    expect(setCodeSettings).toHaveBeenCalledWith({ enabled: true });
    expect(dismissHint).toHaveBeenCalledWith('claude-code');
    expect(query('sync-hint-claude-code')).toBeNull();
  });

  it('keeps the hint and says so when turning sync on fails', async () => {
    setCodeSettings.mockRejectedValueOnce(new Error('write failed'));
    await mount(stateWith(), false);
    await click('sync-hint-claude-code-enable-btn');
    expect(dismissHint).not.toHaveBeenCalled();
    expect(query('sync-hint-claude-code')).not.toBeNull();
    expect(query('sync-hint-claude-code-error')).not.toBeNull();
  });

  it('does not report a failed "Not now" as a failure to turn sync on', async () => {
    await mount(stateWith({ webNotebooks: 0 }), false);
    dismissHint.mockRejectedValueOnce(new Error('write failed'));
    await click('sync-hint-claude-code-dismiss-btn');
    expect(query('sync-hint-claude-code')).not.toBeNull();
    expect(query('sync-hint-claude-code-error')).toBeNull();
  });

  it('"Not now" hides it for good', async () => {
    await mount(stateWith({ webNotebooks: 0 }), false);
    await click('sync-hint-claude-code-dismiss-btn');
    expect(dismissHint).toHaveBeenCalledWith('claude-code');
    expect(setCodeSettings).not.toHaveBeenCalled();
    expect(query('sync-hint-claude-code')).toBeNull();
  });

  it.each([
    ['sync is on', { code: true }],
    ['no history was found', { codeSessions: 0 }],
    ['the folder was not looked at', { codeSessions: null }],
    ['it was dismissed', { dismissed: ['claude-code'] as SyncHintId[] }],
    ['signed out', { signedIn: false }],
  ])('is hidden when %s', async (_label, options) => {
    await mount(stateWith({ ...options, webNotebooks: 0 }), false);
    expect(query('sync-hint-claude-code')).toBeNull();
  });
});

describe('web hint', () => {
  it('keeps compact single-line buttons and wraps the actions instead of their labels', async () => {
    host.style.width = '220px';
    await mount(stateWith({ codeSessions: 0 }), false);
    const enable = query('sync-hint-web-enable-btn')!;
    const dismiss = query('sync-hint-web-dismiss-btn')!;
    for (const button of [enable, dismiss]) {
      const style = getComputedStyle(button);
      expect(style.whiteSpace).toBe('nowrap');
      expect(style.flexShrink).toBe('0');
      expect(style.minHeight).toBe('24px');
      expect(style.fontSize).toBe('12px');
    }
    const actions = getComputedStyle(enable.parentElement!);
    expect(actions.flexWrap).toBe('wrap');
    expect(actions.alignItems).toBe('flex-start');
  });

  it('shows when the Claude Code hint does not apply, and turns web sync on', async () => {
    await mount(stateWith({ codeSessions: 0 }), false);
    expect(query('sync-hint-web')?.textContent).toContain('You have 30 chats on Bike4Mind web');
    await click('sync-hint-web-enable-btn');
    expect(setWebSettings).toHaveBeenCalledWith({ enabled: true });
    expect(dismissHint).toHaveBeenCalledWith('web');
    expect(query('sync-hint-web')).toBeNull();
  });

  it('waits behind the Claude Code hint, one hint at a time', async () => {
    await mount(stateWith(), false);
    expect(query('sync-hint-claude-code')).not.toBeNull();
    expect(query('sync-hint-web')).toBeNull();
    await click('sync-hint-claude-code-dismiss-btn');
    expect(query('sync-hint-web')).not.toBeNull();
  });

  it.each([
    ['sync is on', { web: true }],
    ['the account has no notebooks', { webNotebooks: 0 }],
    ['it was dismissed', { dismissed: ['web'] as SyncHintId[] }],
    ['signed out', { signedIn: false }],
  ])('is hidden when %s', async (_label, options) => {
    await mount(stateWith({ ...options, codeSessions: 0 }), false);
    expect(query('sync-hint-web')).toBeNull();
  });
});

describe('hint card accessibility', () => {
  it('labels the card as a region by its heading', async () => {
    await mount(stateWith(), false);
    const card = query('sync-hint-claude-code');
    expect(card?.getAttribute('role')).toBe('region');
    const heading = document.getElementById(card?.getAttribute('aria-labelledby') ?? '');
    expect(heading?.textContent).toContain('Claude Code session');
  });
});
