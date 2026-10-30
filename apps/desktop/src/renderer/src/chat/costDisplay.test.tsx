// @vitest-environment jsdom
import { act } from 'react';
import { CssVarsProvider } from '@mui/joy/styles';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SettingsScreen } from './SettingsPanel';
import { TurnStatus } from './TurnStatus';
import { MessageThread } from './MessageThread';
import { Composer } from './Composer';
import { useCostDisplayPreference } from './costDisplay';

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

const usage = { creditsUsed: 54, usdCost: 0.027, inputTokens: 1200 };

function CostSurfaces() {
  return (
    <>
      <SettingsScreen auth={null} onClose={() => undefined} />
      <TurnStatus
        turn={{ startedAt: Date.now(), tokens: 1200, usage }}
        activity={{ kind: 'thinking', label: 'Thinking...' }}
      />
      <Composer
        sessionId="s1"
        disabled={false}
        streaming={false}
        usage={{ contextTokens: 1200, contextLimit: 200000, credits: 1000, lastTurn: usage }}
        attachments={{
          attachments: [],
          busy: false,
          rejected: [],
          dismissRejected: () => undefined,
          add: async () => undefined,
          attachImage: async () => undefined,
          pick: async () => undefined,
          remove: () => undefined,
          clear: () => undefined,
        }}
        onSend={() => undefined}
        onStop={() => undefined}
      />
      <MessageThread
        sessionId="s1"
        messages={[{ id: 'm1', role: 'assistant', content: 'done', createdAt: '2026-01-01', usage }]}
        streaming={false}
        onRespond={() => undefined}
        onContinue={() => undefined}
      />
    </>
  );
}

describe('developer dollar cost preference', () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    vi.stubEnv('DEV', true);
    vi.stubGlobal('matchMedia', (query: string) => ({
      matches: false,
      media: query,
      addListener: () => undefined,
      removeListener: () => undefined,
    }));
    window.localStorage.clear();
    useCostDisplayPreference.setState({ showDollarCosts: false });
    Element.prototype.scrollIntoView = () => undefined;
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    useCostDisplayPreference.setState({ showDollarCosts: false });
    window.localStorage.clear();
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  const render = () =>
    act(() =>
      root.render(
        <CssVarsProvider>
          <CostSurfaces />
        </CssVarsProvider>
      )
    );
  const status = () => container.querySelector('[data-testid="chat-turn-status-text"]')?.textContent;
  const reply = () => container.querySelector('[data-testid="chat-message-cost"]');

  it('defaults to credits and updates all mounted readers when the developer flips the setting', () => {
    render();
    expect(status()).toContain('54 credits');
    expect(status()).not.toContain('$');
    expect(reply()?.getAttribute('title')).not.toContain('$');
    const toggle = container.querySelector<HTMLInputElement>('[data-testid="settings-dollar-costs-switch"]');
    expect(toggle?.checked).toBe(false);

    act(() => toggle?.click());
    expect(status()).toContain('$0.03');
    expect(reply()?.textContent).toBe('54 credits');
    expect(reply()?.getAttribute('title')).toContain('$0.03');
    expect(JSON.parse(window.localStorage.getItem('b4m.chat.costDisplay') ?? '{}').state.showDollarCosts).toBe(true);

    act(() => toggle?.click());
    expect(status()).toContain('54 credits');
    expect(reply()?.getAttribute('title')).not.toContain('$');
  });

  it('hides the setting and dollars in production even with a saved opt-in', () => {
    useCostDisplayPreference.getState().setShowDollarCosts(true);
    vi.stubEnv('DEV', false);
    render();
    expect(container.querySelector('[data-testid="settings-dollar-costs-switch"]')).toBeNull();
    expect(status()).toContain('54 credits');
    expect(status()).not.toContain('$');
    expect(reply()?.getAttribute('title')).not.toContain('$');
  });

  it('updates the composer usage tooltip when the developer preference changes', async () => {
    vi.useFakeTimers();
    render();
    const ring = container.querySelector('[data-testid="composer-status-ring"]');
    act(() => ring?.dispatchEvent(new MouseEvent('mouseover', { bubbles: true })));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1000);
    });
    expect(document.querySelector('[role="tooltip"]')?.textContent).toContain('54 credits');
    expect(document.querySelector('[role="tooltip"]')?.textContent).not.toContain('$');
    act(() => useCostDisplayPreference.getState().setShowDollarCosts(true));
    expect(document.querySelector('[role="tooltip"]')?.textContent).toContain('$0.03');
    act(() => useCostDisplayPreference.getState().setShowDollarCosts(false));
    expect(document.querySelector('[role="tooltip"]')?.textContent).toContain('54 credits');
    act(() => {
      vi.stubEnv('DEV', false);
      useCostDisplayPreference.getState().setShowDollarCosts(true);
    });
    expect(document.querySelector('[role="tooltip"]')?.textContent).toContain('54 credits');
    expect(document.querySelector('[role="tooltip"]')?.textContent).not.toContain('$');
  });

  it('restores a valid saved preference and ignores invalid stored values', async () => {
    window.localStorage.setItem(
      'b4m.chat.costDisplay',
      JSON.stringify({ state: { showDollarCosts: true }, version: 0 })
    );
    await useCostDisplayPreference.persist.rehydrate();
    expect(useCostDisplayPreference.getState().showDollarCosts).toBe(true);
    useCostDisplayPreference.getState().setShowDollarCosts(false);
    window.localStorage.setItem(
      'b4m.chat.costDisplay',
      JSON.stringify({ state: { showDollarCosts: 'true' }, version: 0 })
    );
    await useCostDisplayPreference.persist.rehydrate();
    expect(useCostDisplayPreference.getState().showDollarCosts).toBe(false);
  });
});
