// @vitest-environment jsdom
import type { HostBridgeApi } from '@shared/hostBridge';
import { chatBackedHostBridge } from '../../__fixtures__/chatBackedHostBridge';
import { act } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ViewSnapshot } from '@shared/viewSnapshot';
import { MIN_PANE_FRACTION, singlePaneLayout, type OrchestratorLayout } from './orchestratorLayout';
import { OrchestratorStage, type OrchestratorViewProps } from './OrchestratorStage';
import { snapshotView, type SnapshotViewProps } from './snapshotView';
import { presenterAgentTitle } from './presenter';
import { RESIZE_KEY_STEP } from './StageLayout';
import { agentFixture, createThemedMount, el, query } from './testUtils';
import { sessionFixture } from './sessionFixture';

const chime = vi.hoisted(() => ({ playChime: vi.fn() }));
vi.mock('./chime', () => chime);

const AGENTS = [agentFixture('a1', 'working'), agentFixture('a2', 'needs-you')];
const SIDE_BY_SIDE: OrchestratorLayout = {
  split: 'row',
  panes: [
    { view: 'board', size: 0.5 },
    { view: 'transit', size: 0.5 },
  ],
};

const themed = createThemedMount();
const onLayoutChange = vi.fn();
const actions = { open: vi.fn(), stop: vi.fn(), archive: vi.fn() };

/** What each probe pane was handed, by the view id it was drawn for. */
const snapshotsByView = new Map<string, ViewSnapshot>();

function probeFor(viewId: string) {
  function Probe({ snapshot, onAction }: SnapshotViewProps) {
    snapshotsByView.set(viewId, snapshot);
    return (
      <div data-testid={`probe-${viewId}`}>
        {snapshot.agents.map(agent => (
          <button
            key={agent.id}
            type="button"
            data-testid={`probe-${viewId}-open-${agent.id}`}
            onClick={() => onAction({ kind: 'open-agent', agentId: agent.id })}
          >
            {agent.title}
          </button>
        ))}
      </div>
    );
  }
  return snapshotView(Probe, { displayName: `Probe-${viewId}` });
}
const PROBES = { board: probeFor('board'), transit: probeFor('transit'), table: probeFor('table') };

const renderProbeView = (view: string, props: OrchestratorViewProps) => {
  const Probe = PROBES[view as keyof typeof PROBES];
  return <Probe {...props} />;
};

const renderStage = (layout: OrchestratorLayout) =>
  themed.render(
    <OrchestratorStage
      agents={AGENTS}
      rootId="root"
      layout={layout}
      onLayoutChange={onLayoutChange}
      actions={actions}
      introPlaying={false}
      renderView={renderProbeView}
    />
  );

beforeEach(() => {
  Element.prototype.scrollIntoView = vi.fn();
  (window as unknown as { b4m: unknown }).b4m = {
    host: chatBackedHostBridge(),
    chat: {
      getSession: vi.fn().mockResolvedValue(null),
      getHeldRelays: vi.fn().mockResolvedValue([]),
      onStreamEvent: vi.fn(() => () => undefined),
      onQueueChanged: vi.fn(() => () => undefined),
      getRunSpend: vi.fn().mockResolvedValue({ status: 'unattributed' }),
    },
  };
});

afterEach(() => {
  themed.unmount();
  snapshotsByView.clear();
  vi.clearAllMocks();
});

describe('StageLayout in the stage', () => {
  it('draws a single pane bare, as the stage drew one view before layouts', async () => {
    await renderStage(singlePaneLayout('board'));
    expect(query('orchestrator-layout')).toBeNull();
    expect(el('probe-board')).toBeTruthy();
  });

  it('hands every pane the same snapshot', async () => {
    await renderStage(SIDE_BY_SIDE);
    expect(el('orchestrator-layout').dataset.split).toBe('row');
    expect(el('orchestrator-pane-0').contains(el('probe-board'))).toBe(true);
    expect(el('orchestrator-pane-1').contains(el('probe-transit'))).toBe(true);
    const board = snapshotsByView.get('board');
    expect(board?.agents.map(agent => agent.id).sort()).toEqual(['a1', 'a2']);
    expect(snapshotsByView.get('transit')).toEqual(board);
  });

  it('hands every pane the redacted snapshot in Presenter mode', async () => {
    const titled = [
      agentFixture('a1', 'working', { title: 'Secret one' }),
      agentFixture('a2', 'needs-you', { title: 'Secret two' }),
    ];
    await themed.render(
      <OrchestratorStage
        agents={titled}
        rootId="root"
        layout={SIDE_BY_SIDE}
        onLayoutChange={onLayoutChange}
        actions={actions}
        introPlaying={false}
        renderView={renderProbeView}
        presenter={{ on: true, onToggle: vi.fn() }}
      />
    );
    const board = snapshotsByView.get('board');
    const titles = board?.agents.map(agent => agent.title).sort();
    expect(titles).toEqual([presenterAgentTitle(1), presenterAgentTitle(2)]);
    expect(snapshotsByView.get('transit')).toEqual(board);
    expect(el('orchestrator-layout').textContent).not.toContain('Secret');
  });

  it.each([
    ['the first', 'board'],
    ['the second', 'transit'],
  ])('sends an action from %s pane through the stage, opening the agent', async (_label, viewId) => {
    await renderStage(SIDE_BY_SIDE);
    expect(query('orchestrator-peek-drawer')).toBeNull();
    await act(async () => el(`probe-${viewId}-open-a2`).click());
    expect(el('orchestrator-peek-drawer')).toBeTruthy();
  });

  it('labels each pane as a region named for its view', async () => {
    await renderStage(SIDE_BY_SIDE);
    const regions = [...document.querySelectorAll('[role="region"]')].map(region => region.getAttribute('aria-label'));
    expect(regions).toEqual(['Pane 1: Board', 'Pane 2: Transit']);
  });

  it('moves focus to the next pane on F6 and back on Shift+F6, wrapping', async () => {
    await renderStage({ ...SIDE_BY_SIDE, panes: [...SIDE_BY_SIDE.panes, { view: 'table', size: 0.5 }] });
    const button = el('probe-board-open-a1');
    button.focus();
    const press = (init: KeyboardEventInit) =>
      act(() => {
        (document.activeElement ?? document.body).dispatchEvent(
          new KeyboardEvent('keydown', { key: 'F6', bubbles: true, cancelable: true, ...init })
        );
      });
    await press({});
    expect(document.activeElement).toBe(el('orchestrator-pane-1'));
    await press({});
    expect(document.activeElement).toBe(el('orchestrator-pane-2'));
    await press({});
    expect(document.activeElement).toBe(el('orchestrator-pane-0'));
    await press({ shiftKey: true });
    expect(document.activeElement).toBe(el('orchestrator-pane-2'));
  });

  it('resizes with the arrow keys on the handle, stopping at the minimum', async () => {
    await renderStage(SIDE_BY_SIDE);
    const handle = el('orchestrator-pane-handle-0');
    expect(handle.getAttribute('role')).toBe('separator');
    expect(handle.getAttribute('aria-valuenow')).toBe('50');
    await act(async () => {
      handle.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }));
    });
    const grown = onLayoutChange.mock.lastCall?.[0] as OrchestratorLayout;
    expect(grown.panes[0].size).toBeCloseTo(0.5 + RESIZE_KEY_STEP);
    expect(grown.panes[1].size).toBeCloseTo(0.5 - RESIZE_KEY_STEP);

    onLayoutChange.mockClear();
    await renderStage({
      ...SIDE_BY_SIDE,
      panes: [
        { view: 'board', size: MIN_PANE_FRACTION },
        { view: 'transit', size: 1 - MIN_PANE_FRACTION },
      ],
    });
    await act(async () => {
      el('orchestrator-pane-handle-0').dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowLeft', bubbles: true }));
    });
    expect((onLayoutChange.mock.lastCall?.[0] as OrchestratorLayout).panes[0].size).toBe(MIN_PANE_FRACTION);
  });

  it('follows a drag and remembers the layout once, on release', async () => {
    await renderStage(SIDE_BY_SIDE);
    vi.spyOn(el('orchestrator-layout'), 'getBoundingClientRect').mockReturnValue(new DOMRect(0, 0, 1000, 600));
    const handle = el('orchestrator-pane-handle-0');
    await act(async () => {
      handle.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, button: 0, clientX: 500 }));
    });
    await act(async () => {
      window.dispatchEvent(new PointerEvent('pointermove', { clientX: 600 }));
    });
    expect(el('orchestrator-pane-handle-0').getAttribute('aria-valuenow')).toBe('60');
    expect(onLayoutChange).not.toHaveBeenCalled();
    await act(async () => {
      window.dispatchEvent(new PointerEvent('pointerup', { clientX: 600 }));
    });
    expect(onLayoutChange).toHaveBeenCalledTimes(1);
    expect((onLayoutChange.mock.lastCall?.[0] as OrchestratorLayout).panes[0].size).toBeCloseTo(0.6);
  });

  it('drops a drag in progress when the layout is changed from elsewhere', async () => {
    await renderStage(SIDE_BY_SIDE);
    vi.spyOn(el('orchestrator-layout'), 'getBoundingClientRect').mockReturnValue(new DOMRect(0, 0, 1000, 600));
    await act(async () => {
      el('orchestrator-pane-handle-0').dispatchEvent(
        new PointerEvent('pointerdown', { bubbles: true, button: 0, clientX: 500 })
      );
    });
    await act(async () => {
      window.dispatchEvent(new PointerEvent('pointermove', { clientX: 600 }));
    });
    await renderStage(singlePaneLayout('board'));
    expect(query('orchestrator-layout')).toBeNull();
    await act(async () => {
      window.dispatchEvent(new PointerEvent('pointerup', { clientX: 600 }));
    });
    expect(onLayoutChange).not.toHaveBeenCalled();
  });

  it('stacks a column split', async () => {
    await renderStage({ ...SIDE_BY_SIDE, split: 'column' });
    expect(el('orchestrator-layout').dataset.split).toBe('column');
    expect(el('orchestrator-pane-handle-0').getAttribute('aria-orientation')).toBe('horizontal');
  });
});

describe('panes pinned to another session', () => {
  // root (the active session) has the stage's agents; other is a separate orchestration with one agent.
  const SESSIONS = [
    sessionFixture('root'),
    sessionFixture('a1', 'root'),
    sessionFixture('other', undefined, { orchestrate: true, title: 'Other run' }),
    sessionFixture('o1', 'other', { title: 'Secret other agent' }),
  ];
  const paneSessions = { sessions: SESSIONS, statuses: new Map(), prSummaries: new Map() };
  const pinnedSplit = (sessionId: string): OrchestratorLayout => ({
    split: 'row',
    panes: [
      { view: 'board', size: 0.5 },
      { view: 'transit', size: 0.5, sessionId },
    ],
  });
  const renderPinned = (layout: OrchestratorLayout, presenting = false) =>
    themed.render(
      <OrchestratorStage
        agents={AGENTS}
        rootId="root"
        layout={layout}
        onLayoutChange={onLayoutChange}
        actions={actions}
        introPlaying={false}
        renderView={renderProbeView}
        paneSessions={paneSessions}
        presenter={presenting ? { on: true, onToggle: vi.fn() } : undefined}
      />
    );

  it("draws the pinned session's roster in its pane and the active roster in the others", async () => {
    await renderPinned(pinnedSplit('other'));
    expect(
      snapshotsByView
        .get('board')
        ?.agents.map(agent => agent.id)
        .sort()
    ).toEqual(['a1', 'a2']);
    expect(snapshotsByView.get('transit')?.root.id).toBe('other');
    expect(snapshotsByView.get('transit')?.agents.map(agent => agent.id)).toEqual(['o1']);
    const pane = el('orchestrator-pane-1');
    expect(pane.contains(el('orchestrator-pinned-pane'))).toBe(true);
    expect(el('orchestrator-pinned-pane-label').textContent).toBe('Other run');
  });

  it("opens a clicked agent's session instead of selecting it on the active stage", async () => {
    await renderPinned(pinnedSplit('other'));
    act(() => el('probe-transit-open-o1').click());
    expect(actions.open).toHaveBeenCalledWith('o1');
    expect(query('orchestrator-peek-drawer-region')).toBeNull();
  });

  it.each([
    ['a session no longer listed', 'deleted'],
    ['the active session itself', 'root'],
  ])('falls back to the active roster for a pin to %s', async (_label, sessionId) => {
    await renderPinned(pinnedSplit(sessionId));
    expect(query('orchestrator-pinned-pane')).toBeNull();
    expect(snapshotsByView.get('transit')).toEqual(snapshotsByView.get('board'));
  });

  it('ignores the pin on a single pane', async () => {
    await renderPinned({ split: 'row', panes: [{ view: 'transit', size: 1, sessionId: 'other' }] });
    expect(query('orchestrator-pinned-pane')).toBeNull();
    expect(snapshotsByView.get('transit')?.root.id).toBe('root');
  });

  it('redacts the pinned pane in Presenter mode too', async () => {
    await renderPinned(pinnedSplit('other'), true);
    const titles = snapshotsByView.get('transit')?.agents.map(agent => agent.title);
    expect(titles).toEqual([presenterAgentTitle(1)]);
    expect(el('orchestrator-pinned-pane-label').textContent).toBe('Session 1');
    expect(document.body.textContent).not.toMatch(/Secret other agent|Other run/);
  });

  it('subscribes to activity only while a pane is pinned, and re-subscribes when the pin moves', async () => {
    const bridge = (window as unknown as { b4m: { host: HostBridgeApi } }).b4m.host;
    const request = vi.spyOn(bridge, 'request');
    // The sessions this window holds a subscription to, from the subscribe and unsubscribe requests.
    const live = () => {
      const held = new Set<string>();
      for (const [, method, params] of request.mock.calls) {
        const sessionId = (params as { sessionId: string }).sessionId;
        if (method === 'session/subscribe') held.add(sessionId);
        if (method === 'session/unsubscribe') held.delete(sessionId);
      }
      return held;
    };

    await renderPinned(pinnedSplit('follow-active'));
    expect(query('orchestrator-pinned-pane')).toBeNull();
    const baseline = live();

    await renderPinned(pinnedSplit('other'));
    const pinnedOther = live();
    expect(pinnedOther.size).toBeGreaterThan(baseline.size);

    const sessions = [...SESSIONS, sessionFixture('third', undefined, { orchestrate: true, title: 'Third run' })];
    await themed.render(
      <OrchestratorStage
        agents={AGENTS}
        rootId="root"
        layout={pinnedSplit('third')}
        onLayoutChange={onLayoutChange}
        actions={actions}
        introPlaying={false}
        renderView={renderProbeView}
        paneSessions={{ ...paneSessions, sessions }}
      />
    );
    expect(live()).not.toEqual(pinnedOther);
    expect(live().has('third')).toBe(true);

    await renderPinned({ ...SIDE_BY_SIDE });
    expect(live()).toEqual(baseline);
  });
});
