// @vitest-environment jsdom
import { act } from 'react';
import { CssVarsProvider } from '@mui/joy/styles';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { reloadReplyStatsPrefs } from './replyStatsPrefs';
import { SettingsScreen } from './SettingsPanel';
import { TurnStatus } from './TurnStatus';

vi.mock('./PermissionsSettings', () => ({
  PermissionsSettings: () => null,
  permissionsSummary: () => 'Default permissions',
  usePermissions: () => [null, () => undefined, null, () => undefined],
}));
vi.mock('./LocalContextSettings', () => ({
  LocalContextSettings: () => null,
  localContextSummary: () => 'Auto',
  useLocalContextSetting: () => [null, () => undefined, null],
}));
vi.mock('./ModelServersSettings', () => ({
  ModelServersSettings: () => null,
  modelServersSummary: () => 'Only this computer',
  useModelServers: () => [null, () => undefined, null],
}));
vi.mock('./CuratedListSettings', () => ({
  CuratedListSettings: () => null,
  curatedListSummary: () => 'Bundled',
  useCuratedListSettings: () => [null, () => undefined],
}));
vi.mock('./useAppUpdate', async () => {
  const { initialUpdateState } = await import('@shared/update');
  return { useAppUpdate: () => ({ state: initialUpdateState('', false), blockedBy: null }) };
});

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

describe('the reply stats settings', () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    vi.stubGlobal('matchMedia', (query: string) => ({
      matches: false,
      media: query,
      addListener: () => undefined,
      removeListener: () => undefined,
    }));
    window.localStorage.clear();
    reloadReplyStatsPrefs();
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    act(() =>
      root.render(
        <CssVarsProvider>
          <SettingsScreen auth={null} onClose={() => undefined} />
          <TurnStatus
            turn={{
              startedAt: Date.now(),
              tokens: 148,
              usage: { inputTokens: 100, outputTokens: 48, rate: { evalTokens: 48, evalMs: 2000 } },
            }}
            activity={{ kind: 'thinking', label: 'Thinking...' }}
          />
        </CssVarsProvider>
      )
    );
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    window.localStorage.clear();
    vi.unstubAllGlobals();
  });

  const input = (testId: string) => {
    const found = container.querySelector<HTMLInputElement>(`[data-testid="${testId}"]`);
    if (!found) throw new Error(`no ${testId}`);
    return found;
  };
  const statusLine = () => container.querySelector('[data-testid="chat-turn-status-text"]')?.textContent ?? '';
  const stored = () => JSON.parse(window.localStorage.getItem('b4m.chat.replyStats.shown') ?? '{}');

  it('ticks each stat that shows, and the switch while the rail is on', () => {
    expect(input('settings-reply-stat-speed-checkbox').checked).toBe(true);
    expect(input('settings-reply-stat-firstToken-checkbox').checked).toBe(false);
    expect(input('settings-reply-stats-rail-switch').checked).toBe(true);
  });

  it('hides the speed everywhere it shows, the turn line included, when unticked', () => {
    expect(statusLine()).toContain('24.0 tok/s');

    act(() => input('settings-reply-stat-speed-checkbox').click());
    expect(input('settings-reply-stat-speed-checkbox').checked).toBe(false);
    expect(statusLine()).not.toContain('tok/s');
    expect(stored()).toEqual({ speed: false });

    act(() => input('settings-reply-stat-firstToken-checkbox').click());
    expect(input('settings-reply-stat-firstToken-checkbox').checked).toBe(true);
    expect(stored()).toEqual({ speed: false, firstToken: true });
  });

  it('turns the rail off from its switch', () => {
    act(() => input('settings-reply-stats-rail-switch').click());

    expect(input('settings-reply-stats-rail-switch').checked).toBe(false);
    expect(window.localStorage.getItem('b4m.chat.replyStats.rail')).toBe('0');
  });
});
