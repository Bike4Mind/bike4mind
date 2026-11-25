// @vitest-environment jsdom
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CONTENT_MAX_WIDTH } from './layout';
import {
  parseReplyStatsPrefs,
  railFitsBesideThread,
  reloadReplyStatsPrefs,
  replyStatsSummary,
  replyStatsToggleTitle,
  REPLY_STATS_RAIL_INSET,
  REPLY_STATS_RAIL_WIDTH,
  setReplyStatShown,
  setReplyStatsRail,
  useReplyStatsPrefs,
} from './replyStatsPrefs';
import type { ChatMessage } from '@shared/chat';
import { MessageThread } from './MessageThread';
import { SettingsScreen } from './SettingsPanel';
import { TurnStatus } from './TurnStatus';
import { DEFAULT_WATCH_PREFERENCES } from '@shared/watch';
import { CssVarsProvider } from '@mui/joy/styles';

// SettingsScreen's other sections are stubbed: only its reply stats section is under test here.
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
vi.mock('./AutoFixAttemptsSettings', () => ({
  AutoFixAttemptsSettings: () => null,
  autoFixAttemptsSummary: () => 'Up to 5 attempts per pull request',
  useAutoFixAttempts: () => [null, () => undefined, null],
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

describe('replyStatsPrefs', () => {
  beforeEach(() => {
    window.localStorage.clear();
    reloadReplyStatsPrefs();
  });

  describe('a change made in another window', () => {
    it('reaches this one through the storage event', () => {
      let rail: boolean | null = null;
      function Probe() {
        rail = useReplyStatsPrefs().rail;
        return null;
      }
      const root = createRoot(document.createElement('div'));
      act(() => root.render(createElement(Probe)));
      expect(rail).toBe(true);

      window.localStorage.setItem('b4m.chat.replyStats.rail', '0');
      act(() => window.dispatchEvent(new StorageEvent('storage', { key: 'b4m.chat.replyStats.rail' })));
      expect(rail).toBe(false);

      window.localStorage.clear();
      act(() => window.dispatchEvent(new StorageEvent('storage', { key: null })));
      expect(rail).toBe(true);
      act(() => root.unmount());
    });

    it('follows a stat ticked or unticked there', () => {
      let hidden: ReadonlySet<string> = new Set();
      function Probe() {
        hidden = useReplyStatsPrefs().hidden;
        return null;
      }
      const root = createRoot(document.createElement('div'));
      act(() => root.render(createElement(Probe)));
      expect(hidden.has('speed')).toBe(false);

      window.localStorage.setItem('b4m.chat.replyStats.shown', JSON.stringify({ speed: false, load: true }));
      act(() => window.dispatchEvent(new StorageEvent('storage', { key: 'b4m.chat.replyStats.shown' })));
      expect(hidden.has('speed')).toBe(true);
      expect(hidden.has('load')).toBe(false);
      act(() => root.unmount());
    });
  });

  describe('railFitsBesideThread', () => {
    // Free on the left is half the region beyond the column, plus the column's 24px padding.
    const threshold = CONTENT_MAX_WIDTH + 2 * (REPLY_STATS_RAIL_WIDTH + 2 * REPLY_STATS_RAIL_INSET - 24);
    const sidebar = { collapsed: 45, standard: 281, widest: 481 };

    it('fits from a 1176px thread region', () => {
      expect(threshold).toBe(1176);
      expect(railFitsBesideThread(1176)).toBe(true);
      expect(railFitsBesideThread(1175)).toBe(false);
    });

    it('turns on at the 1280 default window only once the sidebar is collapsed', () => {
      expect(railFitsBesideThread(1280 - sidebar.standard)).toBe(false);
      expect(railFitsBesideThread(1280 - sidebar.collapsed)).toBe(true);
    });

    it('does not fit a thread region that has not been measured yet', () => {
      expect(railFitsBesideThread(null)).toBe(false);
    });

    it('needs a wider window for a wider sidebar', () => {
      expect(railFitsBesideThread(1657 - sidebar.widest)).toBe(true);
      expect(railFitsBesideThread(1656 - sidebar.widest)).toBe(false);
      expect(railFitsBesideThread(1457 - sidebar.standard)).toBe(true);
    });
  });

  describe('parseReplyStatsPrefs', () => {
    const offByDefault = ['promptSpeed', 'firstToken', 'draft'];

    it('starts with the rail on, and every stat shown but the server timings and the first token, model load included', () => {
      const prefs = parseReplyStatsPrefs(null, null, null);
      expect(prefs.rail).toBe(true);
      expect([...prefs.hidden]).toEqual(offByDefault);
    });

    it('carries the old tok/s switch over as the speed stat unticked', () => {
      expect([...parseReplyStatsPrefs(null, null, '0').hidden]).toEqual(['speed', ...offByDefault]);
      expect([...parseReplyStatsPrefs(null, null, '1').hidden]).toEqual(offByDefault);
      expect([...parseReplyStatsPrefs(null, '{}', '0').hidden]).toEqual(offByDefault);
    });

    it('takes a choice either way over the default, and drops what it cannot read or does not know', () => {
      expect([
        ...parseReplyStatsPrefs('0', '{"load":true,"total":false,"later":false,"speed":1}', null).hidden,
      ]).toEqual(['total', 'promptSpeed', 'firstToken', 'draft']);
      expect(parseReplyStatsPrefs('0', '{not json', null)).toEqual({ rail: false, hidden: new Set(offByDefault) });
      expect(parseReplyStatsPrefs(null, '["speed"]', null).hidden).toEqual(new Set(offByDefault));
    });
  });

  describe('the stored prefs', () => {
    it('remember the rail and each stat ticked or unticked across a relaunch', () => {
      setReplyStatsRail(false);
      setReplyStatShown('total', false);
      setReplyStatShown('firstToken', true);
      setReplyStatShown('thinking', false);
      setReplyStatShown('thinking', true);
      reloadReplyStatsPrefs();

      const stored = window.localStorage.getItem('b4m.chat.replyStats.shown');
      expect(JSON.parse(stored ?? 'null')).toEqual({ total: false, firstToken: true });
      expect(parseReplyStatsPrefs(window.localStorage.getItem('b4m.chat.replyStats.rail'), stored, null)).toEqual({
        rail: false,
        hidden: new Set(['total', 'promptSpeed', 'draft']),
      });
    });

    it('summarise both in one line', () => {
      expect(replyStatsSummary({ rail: true, hidden: new Set() })).toBe(
        'All stats, beside the conversation where there is room'
      );
      expect(replyStatsSummary({ rail: false, hidden: new Set(['load', 'speed']) })).toBe(
        '9 of 11 stats, under each reply on hover'
      );
      expect(replyStatsSummary(parseReplyStatsPrefs(null, null, null))).toBe(
        '8 of 11 stats, beside the conversation where there is room'
      );
    });
  });

  describe('replyStatsToggleTitle', () => {
    const state = { persisted: true, orchestratorShown: false, railFits: true, railOn: true };

    it('names the narrow window only where widening it brings the rail back', () => {
      expect(replyStatsToggleTitle({ ...state, railFits: false })).toBe(
        'Hide reply stats beside the conversation; the window is too narrow for them now'
      );
      expect(replyStatsToggleTitle({ ...state, railFits: false, railOn: false })).toBe(
        'Show reply stats beside the conversation once the window is wide enough'
      );
    });

    it('says what the toggle does in a wide chat window', () => {
      expect(replyStatsToggleTitle(state)).toBe('Hide reply stats');
      expect(replyStatsToggleTitle({ ...state, railOn: false })).toBe('Show reply stats');
    });

    it('says the stats show on hover while orchestrating, at any width', () => {
      for (const railFits of [true, false]) {
        const title = replyStatsToggleTitle({ ...state, orchestratorShown: true, railFits });
        expect(title).toBe(
          'Hide reply stats beside the conversation; while orchestrating they show under each reply on hover'
        );
        expect(title).not.toMatch(/narrow|wide enough/);
      }
      expect(replyStatsToggleTitle({ ...state, orchestratorShown: true, railOn: false })).toMatch(/^Show reply stats/);
    });

    it('asks for a conversation first', () => {
      expect(replyStatsToggleTitle({ ...state, persisted: false, orchestratorShown: true })).toBe(
        'Open a conversation to see reply stats.'
      );
    });
  });

  describe('storage that throws', () => {
    afterEach(() => vi.restoreAllMocks());

    const current = () => {
      let seen: ReturnType<typeof useReplyStatsPrefs> | null = null;
      function Probe() {
        seen = useReplyStatsPrefs();
        return null;
      }
      const root = createRoot(document.createElement('div'));
      act(() => root.render(createElement(Probe)));
      return { prefs: () => seen, unmount: () => act(() => root.unmount()) };
    };

    it('reads as the defaults when storage cannot be read', () => {
      window.localStorage.setItem('b4m.chat.replyStats.rail', '0');
      reloadReplyStatsPrefs();
      const before = current();
      expect(before.prefs()?.rail).toBe(false);
      before.unmount();
      vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
        throw new Error('denied');
      });
      expect(() => reloadReplyStatsPrefs()).not.toThrow();
      const probe = current();
      expect(probe.prefs()?.rail).toBe(true);
      expect(probe.prefs()?.hidden).toEqual(parseReplyStatsPrefs(null, null, null).hidden);
      probe.unmount();
    });

    it('keeps a change for this run when storage cannot be written', () => {
      vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
        throw new Error('quota');
      });
      const probe = current();
      expect(() => act(() => setReplyStatsRail(false))).not.toThrow();
      expect(probe.prefs()?.rail).toBe(false);
      expect(() => act(() => setReplyStatShown('speed', false))).not.toThrow();
      expect(probe.prefs()?.hidden.has('speed')).toBe(true);
      probe.unmount();
    });
  });
});

describe('replyCost', () => {
  function message(id: string, fields: Partial<ChatMessage> = {}): ChatMessage {
    return { id, role: 'assistant', content: 'done', createdAt: '2026-01-01T00:00:00.000Z', ...fields };
  }

  /**
   * The hover figure says what a reply cost. The cases that matter are the ones where there is
   * no figure: rendering those as "0 credits" would tell the user a turn was free.
   */
  describe('the cost on a reply', () => {
    let container: HTMLDivElement;
    let root: Root;

    beforeEach(() => {
      window.localStorage.clear();
      reloadReplyStatsPrefs();
      Element.prototype.scrollIntoView = () => undefined;
      container = document.createElement('div');
      document.body.appendChild(container);
      root = createRoot(container);
    });

    afterEach(() => {
      act(() => root.unmount());
      container.remove();
    });

    const render = (messages: ChatMessage[]) =>
      act(() => {
        root.render(
          <MessageThread
            messages={messages}
            sessionId="s1"
            streaming={false}
            onRespond={() => undefined}
            onContinue={() => undefined}
          />
        );
      });

    const costs = () => Array.from(container.querySelectorAll('[data-testid="chat-message-cost"]'));

    it('states the credits the reply spent, with token details and no dollars', () => {
      render([message('m1', { usage: { inputTokens: 1200, outputTokens: 300, creditsUsed: 54, usdCost: 0.027 } })]);

      const row = costs()[0];
      expect(row?.textContent).toBe('54 credits');
      expect(row?.getAttribute('title')).toBe(
        '1.2k new input, 300 output\nTotal tokens: 300 (thinking and any sub-agents included)'
      );
    });

    // jsdom cannot hover, so the half worth pinning is that the turn's rule reached this row at
    // all: hidden at rest is what makes the reveal CSS rather than a render per mouse move.
    it('is hidden until the turn around it is hovered', () => {
      render([message('m1', { usage: { creditsUsed: 54 } })]);

      const row = costs()[0] as HTMLElement;
      expect(getComputedStyle(row).opacity).toBe('0');
    });

    it.each([
      ['an object', { loadMs: 1 }],
      ['a number', 5],
      ['null', null],
      ['a string', 'loadMs'],
    ])('renders the thread of a reply whose stored stats hold derived as %s', (_, derived) => {
      render([
        message('m1', {
          usage: { outputTokens: 40, rate: { evalTokens: 40, evalMs: 1250 } },
          stats: { totalMs: 6000, modelMs: 6000, toolMs: 0, derived } as unknown as ChatMessage['stats'],
        }),
      ]);

      expect(costs()[0]?.textContent).toBe('32.0 tok/s \xb7 6.0s total');
    });

    it('shows nothing on a reply the server reported no credits for', () => {
      render([
        message('m1'),
        message('m2', { usage: { inputTokens: 900 } }),
        message('m3', { error: 'The turn failed' }),
      ]);

      expect(costs()).toHaveLength(0);
    });

    describe('on a self-hosted model reply', () => {
      const usage = { inputTokens: 300, outputTokens: 48, rate: { evalTokens: 48, evalMs: 2000, loadMs: 40 } };

      it('shows the generation rate where credits would be, with details in the title', () => {
        render([message('m1', { usage })]);

        const row = costs()[0];
        expect(row?.textContent).toBe('24.0 tok/s');
        expect(row?.querySelector('[data-testid="chat-message-stat-speed"]')).not.toBeNull();
        expect(row?.getAttribute('title')).toBe(
          '300 new input, 48 output\nTotal tokens: 48 (thinking and any sub-agents included)\nSpeed: 24.0 tok/s'
        );
      });

      it('names a cold model load apart from the total, which leaves it out', () => {
        render([
          message('m1', {
            usage: { outputTokens: 40, rate: { evalTokens: 40, evalMs: 1250, promptMs: 500, loadMs: 28_000 } },
            stats: {
              totalMs: 34_000,
              modelMs: 34_000,
              toolMs: 0,
              loadMs: 28_000,
              outputMs: 5200,
              firstTokenMs: 28_800,
            },
          }),
        ]);

        expect(costs()[0]?.textContent).toBe('32.0 tok/s \xb7 6.0s total + 28.0s model load');
        expect(costs()[0]?.getAttribute('title')).toContain('Total time: 6.0s (leaves out 28.0s of model load)');
      });

      it('lists a model load like any other stat where the total is unticked in Settings', () => {
        act(() => setReplyStatShown('total', false));
        render([
          message('m1', {
            usage: { outputTokens: 40, rate: { evalTokens: 40, evalMs: 1250, promptMs: 500, loadMs: 28_000 } },
            stats: {
              totalMs: 34_000,
              modelMs: 34_000,
              toolMs: 0,
              loadMs: 28_000,
              outputMs: 5200,
              firstTokenMs: 28_800,
            },
          }),
        ]);

        expect(costs()[0]?.textContent).toBe('32.0 tok/s \xb7 28.0s model load');
      });

      it('names a wait worked out from llama-server timings as a server wait, in the footer and the title', () => {
        render([
          message('m1', {
            usage: { outputTokens: 40, rate: { evalTokens: 40, evalMs: 1250, promptMs: 500 } },
            stats: {
              totalMs: 34_000,
              modelMs: 34_000,
              toolMs: 0,
              waitMs: 28_000,
              outputMs: 5200,
              firstTokenMs: 28_800,
            },
          }),
        ]);

        expect(costs()[0]?.textContent).toBe('32.0 tok/s \xb7 34.0s total \xb7 28.0s server wait included');
        expect(costs()[0]?.getAttribute('title')).toContain('Total time: 34.0s (includes 28.0s of server wait)');
        expect(costs()[0]?.getAttribute('title')).toContain('Server wait: 28.0s (load, queue or connection)');
      });

      it('leaves out a stat unticked in Settings, keeps it in the title, and shows nothing with no other', () => {
        act(() => setReplyStatShown('speed', false));
        render([message('m1', { usage })]);

        expect(costs()).toHaveLength(0);
        render([message('m1', { usage: { ...usage, creditsUsed: 2 } })]);
        expect(costs()[0]?.textContent).toBe('2 credits');
        expect(costs()[0]?.getAttribute('title')).toContain('Speed: 24.0 tok/s');
      });
    });

    it('names speed, total and thinking time only, speed first and credits last, each with its kind', () => {
      render([
        message('m1', {
          usage: { inputTokens: 100, outputTokens: 400, cacheReadInputTokens: 900, creditsUsed: 12 },
          stats: {
            totalMs: 10_000,
            modelMs: 10_000,
            toolMs: 0,
            firstTokenMs: 1500,
            reasoningMs: 1500,
            generation: { tokens: 400, ms: 8000 },
            derived: ['reasoningMs'],
          },
        }),
      ]);

      expect(costs()[0]?.textContent).toBe('~50.0 tok/s \xb7 10.0s total \xb7 ~1.5s thinking \xb7 12 credits');
      // Thinking timed from the wait before the first output takes in prompt processing: no share from it.
      expect(costs()[0]?.getAttribute('title')).not.toContain('Thinking share');
    });

    it('leaves the user, relay and system turns alone', () => {
      render([
        message('u1', { role: 'user', content: 'hello' }),
        message('r1', {
          relay: { fromSessionId: 's2', fromTitle: 'Another conversation', hops: 1 },
          usage: { creditsUsed: 12 },
        }),
        message('y1', { system: true, usage: { creditsUsed: 12 } }),
      ]);

      expect(costs()).toHaveLength(0);
    });
  });
});

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
    // SettingsScreen's menu-bar switch reads its preference from main.
    vi.stubGlobal('b4m', {
      watch: {
        getPreferences: async () => DEFAULT_WATCH_PREFERENCES,
        setPreferences: async () => DEFAULT_WATCH_PREFERENCES,
        onPreferences: () => () => undefined,
      },
      attention: {
        getNotifyScope: async () => 'agents',
        setNotifyScope: async () => 'agents',
        onNotifyScope: () => () => undefined,
      },
      chat: {
        getSpawnLocation: async () => 'worktree',
        setSpawnLocation: async () => 'worktree',
        onSpawnLocation: () => () => undefined,
        getTurnExtensions: async () => 3,
        setTurnExtensions: async (extensions: number) => extensions,
      },
    });
    window.localStorage.clear();
    reloadReplyStatsPrefs();
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    act(() =>
      root.render(
        <CssVarsProvider>
          <SettingsScreen auth={null} section="models" onClose={() => undefined} />
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
