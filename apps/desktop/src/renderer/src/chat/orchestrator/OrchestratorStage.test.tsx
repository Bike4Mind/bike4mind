// @vitest-environment jsdom
import { MANAGER_ART } from './office/officeArt';
import { KEEPER_ART } from './aquarium/aquariumArt';
import { chatBackedHostBridge, chatStubs } from '../../__fixtures__/chatBackedHostBridge';
import type { ChatSession } from '@shared/chat';
import { act } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ambientHeld } from './ambient';
import { OrchestratorStage, type OrchestratorViewProps } from './OrchestratorStage';
import { singlePaneLayout } from './orchestratorLayout';
import type { AgentView } from './roster';
import { sceneView } from './scene/SceneStage';
import { TAVERN_SCENE } from './tavern/tavernScene';
import { AQUARIUM_SCENE } from './aquarium/aquariumScene';

const TavernView = sceneView(TAVERN_SCENE);
const AquariumView = sceneView(AQUARIUM_SCENE);
import { agentFixture, createThemedMount, el, query, typeInto } from './testUtils';

const sessionReads = () =>
  chatStubs().getSession as (sessionId: string, viewed?: boolean) => Promise<ChatSession | null>;

const FIXTURE = [
  agentFixture('n', 'needs-you', { credits: 10 }),
  agentFixture('w1', 'working', { credits: 10 }),
  agentFixture('w2', 'working', { credits: 10 }),
  agentFixture('d', 'done'),
];

const chime = vi.hoisted(() => ({ playChime: vi.fn(), playSoundEvent: vi.fn() }));
vi.mock('./chime', () => chime);

const onLayoutChange = vi.fn();
const actions = { open: vi.fn(), stop: vi.fn(), archive: vi.fn() };
const themed = createThemedMount();

const renderStage = (agents: AgentView[]) =>
  themed.render(
    <OrchestratorStage
      agents={agents}
      layout={singlePaneLayout('table')}
      onLayoutChange={onLayoutChange}
      actions={actions}
      introPlaying={false}
    />
  );

const pressEscape = (init: KeyboardEventInit = {}) =>
  act(() => {
    document.body.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true, ...init })
    );
  });

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
  vi.clearAllMocks();
});

describe('OrchestratorStage', () => {
  it('shows an empty state instead of a view while there are no agents', async () => {
    await renderStage([]);
    expect(el('orchestrator-empty-state').textContent).toContain(
      'No agents yet. Describe the work and it will be split across agents.'
    );
    expect(query('orchestrator-table')).toBeNull();
    expect(el('orchestrator-summary-strip').textContent, 'no "0 agents" beside the empty state').toBe('');

    await renderStage([agentFixture('w', 'working')]);
    expect(query('orchestrator-empty-state')).toBeNull();
    expect(query('orchestrator-table-row-w')).not.toBeNull();
  });

  describe('empty stage', () => {
    const renderEmpty = (
      view: 'tavern' | 'office',
      extra: { archivedAgents?: Array<{ id: string; title: string }>; presenting?: boolean } = {}
    ) =>
      themed.render(
        <OrchestratorStage
          agents={[]}
          archivedAgents={extra.archivedAgents}
          presenter={extra.presenting ? { on: true, onToggle: vi.fn() } : undefined}
          layout={singlePaneLayout(view)}
          onLayoutChange={onLayoutChange}
          actions={actions}
          introPlaying={false}
          renderView={(id, props: OrchestratorViewProps) =>
            id === 'tavern' ? <TavernView {...props} /> : <div data-testid={`fake-${id}`} />
          }
        />
      );

    it('welcomes an empty tavern with the Innkeeper idle behind the bar', async () => {
      await renderEmpty('tavern');
      const empty = el('orchestrator-empty-state');
      expect(empty.querySelector('[data-testid="orchestrator-tavern"]')).not.toBeNull();
      expect(el('orchestrator-tavern-host').getAttribute('data-pose')).toBe('idle');
      expect(empty.textContent).toContain(
        'No quests yet. Describe the work and the Innkeeper will split it across agents.'
      );
    });

    it('keeps the Tavern once every agent is archived, with a way back to each one', async () => {
      await renderEmpty('tavern', {
        archivedAgents: [
          { id: 'a2', title: 'Fix the parser' },
          { id: 'a1', title: 'Write the docs' },
        ],
      });
      const empty = el('orchestrator-empty-state');
      expect(empty.querySelector('[data-testid="orchestrator-tavern"]')).not.toBeNull();
      expect(empty.textContent).toContain('Every quest is done and its agent archived.');
      expect(el('orchestrator-archived-agents').textContent).toContain('2 archived agents');
      const buttons = empty.querySelectorAll<HTMLButtonElement>('[data-testid="orchestrator-archived-agent-open-btn"]');
      expect([...buttons].map(button => button.textContent)).toEqual(['Fix the parser', 'Write the docs']);
      act(() => buttons[1].click());
      expect(actions.open).toHaveBeenCalledWith('a1');
    });

    it('lists no archived agent titles while presenting', async () => {
      await renderEmpty('tavern', { archivedAgents: [{ id: 'a1', title: 'Secret task' }], presenting: true });
      expect(el('orchestrator-archived-agents').textContent).toBe('1 archived agent');
      expect(el('orchestrator-empty-state').textContent).not.toContain('Secret task');
    });

    it("says the Office's own archived line once every agent is archived", async () => {
      await renderEmpty('office', { archivedAgents: [{ id: 'a1', title: 'Write the docs' }] });
      expect(el('orchestrator-empty-state').textContent).toContain(
        'Every task is done and its agent archived. Describe more work and the Manager will hand it out.'
      );
      expect(el('orchestrator-archived-agents').textContent).toContain('1 archived agent');
    });

    it("renders the Office scene with zero agents and the Office's empty line", async () => {
      await renderEmpty('office');
      expect(el('orchestrator-empty-state').contains(el('fake-office'))).toBe(true);
      expect(el('orchestrator-empty-state').textContent).toContain(
        'No tasks yet. Describe the work and the Manager will split it across the team.'
      );
    });
  });

  it('summarises the roster, with ~ when a cost is unknown', async () => {
    await renderStage(FIXTURE);
    expect(query('orchestrator-summary-strip')?.textContent).toBe(
      '4 agents \u00B7 2 working \u00B7 1 done \u00B7 ~30 credits'
    );
  });

  it('uses the singular for one agent, and shows no needs-you pill when nothing needs the user', async () => {
    await renderStage([agentFixture('w', 'working', { credits: 1 })]);
    expect(query('orchestrator-summary-strip')?.textContent).toBe('1 agent \u00B7 1 working \u00B7 1 credit');
    expect(query('orchestrator-needs-you-pill')).toBeNull();
  });

  it('counts the parent waiting on an approval as needing the user, and its pill opens the parent', async () => {
    const onParentFocus = vi.fn();
    await themed.render(
      <OrchestratorStage
        agents={[agentFixture('w', 'working')]}
        parent={{ status: 'needs-action' }}
        onParentFocus={onParentFocus}
        layout={singlePaneLayout('table')}
        onLayoutChange={onLayoutChange}
        actions={actions}
        introPlaying={false}
      />
    );
    expect(el('orchestrator-needs-you-pill').textContent).toBe('1 need you');
    expect(el('orchestrator-summary-strip').textContent).not.toContain('need you');
    await act(async () => el('orchestrator-needs-you-pill').click());
    expect(onParentFocus).toHaveBeenCalledTimes(1);
    expect(query('orchestrator-peek-drawer')).toBeNull();
  });

  // Office shares the Tavern's parentScene branch.
  it.each(['tavern', 'aquarium', 'board'] as const)(
    'keeps the %s parent scene action distinct from attention focus',
    async view => {
      const onParentFocus = vi.fn();
      const onParentToggle = vi.fn();
      await themed.render(
        <OrchestratorStage
          agents={[agentFixture('w', 'working')]}
          onParentFocus={onParentFocus}
          onParentToggle={onParentToggle}
          layout={singlePaneLayout(view)}
          onLayoutChange={onLayoutChange}
          actions={actions}
          introPlaying={false}
          renderView={(_view, props) => <button data-testid="scene-parent-action" onClick={props.onInnkeeperSelect} />}
        />
      );
      await act(async () => el('scene-parent-action').click());
      expect(onParentToggle).toHaveBeenCalledTimes(view !== 'board' ? 1 : 0);
      expect(onParentFocus).toHaveBeenCalledTimes(view === 'board' ? 1 : 0);
    }
  );

  it('opens the first failed agent from the failed pill, and leaves it out when none failed', async () => {
    await renderStage([agentFixture('d', 'done'), agentFixture('f', 'failed'), agentFixture('g', 'failed')]);
    expect(el('orchestrator-summary-strip').textContent).not.toContain('failed');
    expect(el('orchestrator-failed-pill').textContent).toBe('2 failed');
    await act(async () => el('orchestrator-failed-pill').click());
    expect(el('orchestrator-peek-drawer').textContent).toContain('Agent f');

    await renderStage(FIXTURE);
    expect(query('orchestrator-failed-pill')).toBeNull();
  });

  it('opens the drawer for the first needs-you agent from the pill, and only a fresh Escape closes it', async () => {
    await renderStage(FIXTURE);
    expect(query('orchestrator-peek-drawer')).toBeNull();
    await act(async () => el('orchestrator-needs-you-pill').click());
    expect(el('orchestrator-peek-drawer').textContent).toContain('Agent n');

    await pressEscape({ isComposing: true });
    expect(query('orchestrator-peek-drawer'), 'an IME-composing Escape is not a close').not.toBeNull();
    act(() => {
      const handled = new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true });
      handled.preventDefault();
      document.body.dispatchEvent(handled);
    });
    expect(query('orchestrator-peek-drawer'), 'an Escape another handler took is not a close').not.toBeNull();

    // The stage claims the Escape that closes it, so the docked conversation stays open.
    const reachedWindow: boolean[] = [];
    const onWindow = (event: KeyboardEvent) => reachedWindow.push(event.defaultPrevented);
    window.addEventListener('keydown', onWindow);
    await pressEscape();
    window.removeEventListener('keydown', onWindow);
    expect(query('orchestrator-peek-drawer')).toBeNull();
    expect(reachedWindow).toEqual([true]);
  });

  // Office shares the Tavern's in-scene branch; its panel colour is a constant in ORCHESTRATOR_VIEW_INFO.
  it.each(['tavern', 'aquarium', 'table'] as const)(
    'overlays details within the %s viewport without adding a layout column',
    async view => {
      await themed.render(
        <OrchestratorStage
          agents={FIXTURE}
          layout={singlePaneLayout(view)}
          onLayoutChange={onLayoutChange}
          actions={actions}
          introPlaying={false}
          renderView={(_id, props) => (
            <div data-testid="scene-artwork" style={{ position: 'relative' }}>
              <button data-testid="scene-select" onClick={() => props.onSelect('w1')} />
              {props.agentDetailsOverlay}
            </div>
          )}
        />
      );
      const scene = el('scene-select');
      const viewport = el('orchestrator-scene-viewport');
      await act(async () => scene.click());
      const region = el('orchestrator-peek-drawer-region');
      expect(viewport.contains(region)).toBe(true);
      expect(el('scene-artwork').contains(region)).toBe(view !== 'table');
      expect(el('scene-select')).toBe(scene);
      expect(getComputedStyle(viewport).position).toBe('relative');
      // jsdom recomputes every stylesheet per getComputedStyle call, so each element is read once.
      const regionStyle = getComputedStyle(region);
      const drawerStyle = getComputedStyle(el('orchestrator-peek-drawer'));
      expect(regionStyle.position).toBe('absolute');
      if (view === 'table') expect(regionStyle.inset).toBe('12px');
      else {
        expect(regionStyle.maxWidth).toBe('calc(100% - 24px)');
        expect(regionStyle.maxHeight).toBe('calc(100% - 24px)');
      }
      expect(regionStyle.pointerEvents).toBe('none');
      expect(drawerStyle.pointerEvents).toBe('auto');
      expect(drawerStyle.backgroundColor).toBe(
        view === 'tavern'
          ? 'rgb(242, 236, 225)'
          : view === 'aquarium'
            ? 'rgb(231, 239, 240)'
            : 'var(--joy-palette-background-surface)'
      );
    }
  );

  it('mounts Tavern details in the actual aspect-ratio artwork, not its frame or letterbox', async () => {
    await themed.render(
      <OrchestratorStage
        agents={FIXTURE}
        layout={singlePaneLayout('tavern')}
        onLayoutChange={onLayoutChange}
        actions={actions}
        introPlaying={false}
        renderView={(_id, props) => <TavernView {...props} />}
      />
    );
    const artwork = el('orchestrator-tavern');
    await act(async () => el('orchestrator-tavern-agent-w1').click());
    expect(el('orchestrator-peek-drawer-region').parentElement).toBe(artwork);
    expect(el('orchestrator-tavern')).toBe(artwork);
  });

  it('leaves requests to the Tavern dialogue box: no Needs-you strip, and the pill does not open details', async () => {
    await themed.render(
      <OrchestratorStage
        agents={FIXTURE}
        layout={singlePaneLayout('tavern')}
        onLayoutChange={onLayoutChange}
        actions={actions}
        introPlaying={false}
        renderView={(_id, props) => <TavernView {...props} />}
      />
    );
    await act(async () => undefined);
    expect(query('orchestrator-needs-you-strip')).toBeNull();
    await act(async () => el('orchestrator-needs-you-pill').click());
    expect(query('orchestrator-peek-drawer')).toBeNull();
  });

  it('opens compact details inside the Aquarium artwork', async () => {
    await themed.render(
      <OrchestratorStage
        agents={FIXTURE}
        layout={singlePaneLayout('aquarium')}
        onLayoutChange={onLayoutChange}
        actions={actions}
        introPlaying={false}
        renderView={(_id, props) => <AquariumView {...props} />}
      />
    );
    const tank = el('orchestrator-aquarium');
    await act(async () => el('orchestrator-aquarium-agent-w1').click());
    expect(el('orchestrator-peek-drawer-region').parentElement).toBe(tank);
    expect(el('orchestrator-aquarium')).toBe(tank);
    expect(el('orchestrator-peek-actions').parentElement).toBe(el('orchestrator-peek-action-row'));
    expect(document.activeElement).toBe(el('orchestrator-peek-drawer'));
    await pressEscape();
    expect(query('orchestrator-peek-drawer')).toBeNull();
  });

  it('lists what an agent waits on in the Needs-you strip, and opens its details from there', async () => {
    vi.mocked(window.b4m.chat.getHeldRelays).mockImplementation(async id =>
      id === 'n'
        ? [
            {
              id: 'h1',
              sessionId: 'n',
              text: 'merge it',
              heldAt: '2026-10-01T00:00:00.000Z',
              reason: 'other-project',
              relay: { fromSessionId: 'x', fromTitle: 'Sender', hops: 1 },
            },
          ]
        : []
    );
    await renderStage(FIXTURE);
    await act(async () => undefined);
    expect(el('orchestrator-needs-you-strip').textContent).toContain('merge it');
    expect(window.b4m.chat.getHeldRelays).not.toHaveBeenCalledWith('w1');
    await act(async () => el('decision-card-open-btn').click());
    expect(el('orchestrator-peek-drawer').textContent).toContain('Agent n');
  });

  it('opens the agent conversation when a table row is clicked, with a fresh reply box per agent', async () => {
    // By id: the Needs-you strip reads the waiting agents' sessions too.
    vi.mocked(sessionReads()).mockImplementation(async id =>
      id === 'w2'
        ? ({
            messages: [{ id: 'reply-w2', role: 'assistant', content: 'Working on the second task.' }],
          } as ChatSession)
        : null
    );
    await renderStage(FIXTURE);
    await act(async () => el('orchestrator-table-row-w1').click());
    await typeInto(el('orchestrator-peek-reply-input') as HTMLTextAreaElement, 'half-written');
    await act(async () => el('orchestrator-table-row-w2').click());
    expect(el('orchestrator-peek-drawer').textContent).toContain('Agent w2');
    expect(el('orchestrator-peek-conversation').contains(el('chat-message-assistant'))).toBe(true);
    expect(el('chat-message-assistant').textContent).toContain('Working on the second task.');
    expect(sessionReads()).toHaveBeenCalledWith('w2');
    expect((el('orchestrator-peek-reply-input') as HTMLTextAreaElement).value, 'draft is per agent').toBe('');
  });

  it('reports a view change', async () => {
    await renderStage(FIXTURE);
    act(() => el('orchestrator-view-menu-btn').click());
    act(() => el('orchestrator-view-option-board').click());
    expect(onLayoutChange).toHaveBeenCalledWith(singlePaneLayout('board'));
  });

  it('uses Office ambient copy and opens the parent attention request', async () => {
    const onParentFocus = vi.fn();
    const wake = vi.fn();
    await themed.render(
      <OrchestratorStage
        agents={[]}
        parent={{ status: 'needs-action' }}
        layout={singlePaneLayout('office')}
        onLayoutChange={onLayoutChange}
        actions={actions}
        introPlaying={false}
        onParentFocus={onParentFocus}
        ambient={{ settled: true, wake, on: true, onToggle: vi.fn() }}
        renderView={(_id, props) => <div data-testid="office-settled" data-settled={props.settled} />}
      />
    );
    expect(el('orchestrator-ambient-status').textContent).toBe('The office is quiet');
    expect(el('office-settled').dataset.settled).toBe('true');
    expect(el('orchestrator-needs-you-card').textContent).toContain('The Manager needs you');
    expect(el('orchestrator-stage').textContent).not.toContain('Innkeeper');
    act(() => el('orchestrator-needs-you-open-btn').click());
    expect(wake).toHaveBeenCalledTimes(1);
    expect(onParentFocus).toHaveBeenCalledTimes(1);
  });

  describe('settled (the ambient Tavern)', () => {
    const wake = vi.fn();
    const renderSettled = (agents: AgentView[], settled = true, parentStatus?: 'needs-action') =>
      themed.render(
        <OrchestratorStage
          agents={agents}
          parent={parentStatus ? { status: parentStatus } : undefined}
          layout={singlePaneLayout('tavern')}
          onLayoutChange={onLayoutChange}
          actions={actions}
          introPlaying={false}
          onParentFocus={onParentFocus}
          dockControl={<button data-testid="fake-dock-control" />}
          ambient={{ settled, wake, on: true, onToggle: vi.fn() }}
        />
      );
    const onParentFocus = vi.fn();

    it('thins the header to a status line', async () => {
      await renderSettled([agentFixture('w', 'working')]);
      expect(el('orchestrator-ambient-status').textContent).toContain('1 agent');
      expect(query('orchestrator-view-menu-btn')).toBeNull();
      expect(query('fake-dock-control')).toBeNull();

      // No pill in the ambient line, so the count rides in it, as on the menu bar and the mini Tavern.
      await renderSettled([agentFixture('n', 'needs-you'), agentFixture('d', 'done')], true, 'needs-action');
      expect(el('orchestrator-ambient-status').textContent).toContain('2 need you');
      // The parent's own wait comes first, and points at the conversation.
      expect(el('orchestrator-needs-you-card').textContent).toContain('The Innkeeper needs you');
      act(() => el('orchestrator-needs-you-open-btn').click());
      expect(onParentFocus).toHaveBeenCalledTimes(1);

      await renderSettled([agentFixture('n', 'needs-you')], false);
      expect(query('orchestrator-ambient-status')).toBeNull();
      expect(query('orchestrator-view-menu-btn')).not.toBeNull();
      expect(query('fake-dock-control'), 'the dock control rides in the awake header').not.toBeNull();
      expect(query('orchestrator-needs-you-card'), 'no card while awake: the pill says it').toBeNull();
      expect(query('orchestrator-needs-you-pill')).not.toBeNull();
    });

    it('slides in only the request of an agent that needs you, answerable in place', async () => {
      const chat = {
        getSession: vi.fn().mockResolvedValue({
          messages: [
            {
              id: 'm0',
              role: 'assistant',
              content: '',
              toolCalls: [
                {
                  id: 'c1',
                  name: 'bash_execute',
                  input: { command: 'rm -rf build' },
                  status: 'awaiting-approval',
                  approvalId: 'ap-1',
                  approvalDetail: 'rm -rf build',
                },
              ],
            },
          ],
        }),
        respondToApproval: vi.fn().mockResolvedValue(undefined),
        onStreamEvent: vi.fn(() => () => undefined),
        onQueueChanged: vi.fn(() => () => undefined),
      };
      (window as unknown as { b4m: unknown }).b4m = { host: chatBackedHostBridge(), chat };
      await renderSettled([agentFixture('n', 'needs-you'), agentFixture('w', 'working')]);
      const card = el('orchestrator-needs-you-card');
      expect(card.hasAttribute('data-ambient-quiet')).toBe(true);
      expect(card.textContent).toContain('rm -rf build');

      await act(async () => el('chat-tool-approve-once').click());
      expect(chat.respondToApproval).toHaveBeenCalledWith('ap-1', { decision: 'once' });
      expect(wake).not.toHaveBeenCalled();
    });

    it("opens the asking agent's drawer, waking the chrome", async () => {
      await renderSettled([agentFixture('n', 'needs-you')]);
      act(() => el('orchestrator-needs-you-open-btn').click());
      expect(wake).toHaveBeenCalledTimes(1);
      expect(query('orchestrator-peek-drawer')).not.toBeNull();
    });

    it('lets an open drawer settle out with the chrome and brings it back on waking', async () => {
      await renderSettled([agentFixture('n', 'needs-you')], false);
      act(() => el('orchestrator-needs-you-pill').click());
      expect(query('orchestrator-peek-drawer')).not.toBeNull();
      // A drawer left open is the usual way to watch the Tavern: it must not hold the chrome up.
      expect(ambientHeld(document)).toBe(false);

      await renderSettled([agentFixture('n', 'needs-you')], true);
      expect(getComputedStyle(el('orchestrator-peek-drawer-region')).display).toBe('none');
      // An Escape while settled must not drop the hidden selection.
      await pressEscape();

      await renderSettled([agentFixture('n', 'needs-you')], false);
      expect(getComputedStyle(el('orchestrator-peek-drawer-region')).display).not.toBe('none');
      expect(query('orchestrator-peek-drawer')).not.toBeNull();
    });

    it('closes a portaled action menu on settle without losing the drawer draft or reopening on wake', async () => {
      const agents = [agentFixture('n', 'needs-you')];
      await renderSettled(agents, false);
      await act(async () => el('orchestrator-needs-you-pill').click());
      const drawer = el('orchestrator-peek-drawer');
      await typeInto(el('orchestrator-peek-reply-input') as HTMLTextAreaElement, 'Keep my draft');
      await act(async () => el('orchestrator-peek-actions-menu-btn').click());
      expect(query('orchestrator-peek-archive-btn')).not.toBeNull();

      await renderSettled(agents, true);
      expect(query('orchestrator-peek-archive-btn')).toBeNull();
      expect(query('orchestrator-peek-actions-menu')).toBeNull();
      expect(el('orchestrator-peek-drawer')).toBe(drawer);

      await renderSettled(agents, false);
      expect(query('orchestrator-peek-archive-btn')).toBeNull();
      expect(el('orchestrator-peek-actions-menu-btn').getAttribute('aria-expanded')).toBe('false');
      expect((el('orchestrator-peek-reply-input') as HTMLTextAreaElement).value).toBe('Keep my draft');
      await act(async () => el('orchestrator-peek-actions-menu-btn').click());
      expect(query('orchestrator-peek-archive-btn')).not.toBeNull();
    });
  });

  describe('the finale', () => {
    const onReadReport = vi.fn();
    const REPORT = { id: 'summary-1', createdAt: '2026-10-01T00:10:00.000Z' };
    const renderRun = (agents: AgentView[], parent: { status?: 'processing' | 'done' } = {}) =>
      themed.render(
        <OrchestratorStage
          agents={agents}
          parent={parent}
          rootId="root"
          report={REPORT}
          layout={singlePaneLayout('table')}
          onLayoutChange={onLayoutChange}
          actions={actions}
          introPlaying={false}
          onReadReport={onReadReport}
        />
      );
    const finished = [
      agentFixture('a', 'done', {
        createdAt: '2026-10-01T00:00:00.000Z',
        updatedAt: '2026-10-01T00:03:12.000Z',
        credits: 1500,
      }),
      agentFixture('b', 'failed', { credits: 250 }),
    ];

    beforeEach(() => {
      window.localStorage.clear();
      vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    });
    afterEach(() => vi.useRealTimers());

    const settle = () =>
      act(async () => {
        vi.advanceTimersByTime(5000);
      });

    it('shows a banner with the run stats once the run completes, in the flow above any view, chiming once', async () => {
      const finaleCalls = () => chime.playSoundEvent.mock.calls.filter(([event]) => event === 'finale');
      await renderRun([agentFixture('a', 'working'), agentFixture('b', 'working')], { status: 'processing' });
      await renderRun(finished, { status: 'done' });
      expect(query('orchestrator-finale')).toBeNull();
      expect(finaleCalls()).toHaveLength(0);
      await settle();
      await renderRun(finished, { status: 'done' });
      expect(finaleCalls(), 'one chime as the banner comes up, not per render').toEqual([['finale', undefined]]);
      const banner = el('orchestrator-finale');
      // One of the two failed, so the run ended rather than completed.
      expect(banner.textContent).toContain('Quest ended');
      expect(banner.getAttribute('data-outcome')).toBe('ended');
      const chips = [...el('orchestrator-finale-stats').querySelectorAll('li')].map(chip => chip.textContent);
      expect(chips).toEqual(['2 agents', '3m 12s', '1,750 credits', '1 done', '1 failed']);
      expect(query('orchestrator-table')).not.toBeNull();
      // Off the Tavern it sits above the rows instead of floating over (and blocking) them.
      expect(banner.getAttribute('data-placement')).toBe('inline');
    });

    it("replaces the local estimate with the run's settled total once the server answers", async () => {
      const spend = (creditsCharged: number) => ({
        creditsCharged,
        requests: 1,
        inputTokens: 0,
        outputTokens: 0,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
      });
      const getRunSpend = vi.fn().mockResolvedValue({
        status: 'settled',
        runId: 'run-a',
        local: { creditsCharged: 1750, requests: 2 },
        checkedAt: '2026-10-01T00:11:00.000Z',
        server: {
          runId: 'run-a',
          createdAt: '2026-10-01T00:00:00.000Z',
          settled: spend(1800),
          byRole: [
            { ...spend(50), role: 'root' },
            { ...spend(1750), role: 'worker' },
          ],
          byPurpose: [
            { ...spend(1750), purpose: 'turn' },
            { ...spend(50), purpose: 'title' },
          ],
          byModel: [],
          byAttempt: [
            { ...spend(1500), role: 'worker', taskId: 'a' },
            { ...spend(250), role: 'worker', taskId: 'b' },
          ],
          byAttemptTruncated: false,
        },
      });
      (window as unknown as { b4m: { chat: Record<string, unknown> } }).b4m.chat.getRunSpend = getRunSpend;
      await renderRun([agentFixture('a', 'working'), agentFixture('b', 'working')], { status: 'processing' });
      await renderRun(finished, { status: 'done' });
      await settle();

      expect(getRunSpend).toHaveBeenCalledWith('root');
      const chips = [...el('orchestrator-finale-stats').querySelectorAll('li')].map(chip => chip.textContent);
      expect(chips).toContain('1,800 credits settled');
      const spendLines = el('orchestrator-finale-spend');
      expect(spendLines.getAttribute('data-reconciled')).toBe('true');
      expect([...spendLines.querySelectorAll('li')].map(line => line.textContent)).toEqual([
        'Root 50 credits \u00B7 Workers 1,750 credits over 2 attempts',
        'Turns 1,750 credits \u00B7 Titles 50 credits',
        'Turn charges match what this device recorded',
        expect.stringMatching(/^Server total as of /),
      ]);
    });

    it('says "Quest complete" only when every agent finished done', async () => {
      const allDone = [agentFixture('a', 'done'), agentFixture('b', 'done')];
      await renderRun([agentFixture('a', 'working'), agentFixture('b', 'working')], { status: 'processing' });
      await renderRun(allDone, { status: 'done' });
      await settle();
      const banner = el('orchestrator-finale');
      expect(banner.textContent).toContain('Quest complete');
      expect(banner.getAttribute('aria-label')).toBe('Quest complete');
      expect(banner.getAttribute('data-outcome')).toBe('complete');
      const chips = [...el('orchestrator-finale-stats').querySelectorAll('li')].map(chip => chip.textContent);
      expect(chips[0]).toBe('All 2 agents done');
      expect(chips.some(chip => chip?.includes('failed'))).toBe(false);
    });

    it('reads the report and dismisses the banner', async () => {
      await renderRun([agentFixture('a', 'working')]);
      await renderRun(finished);
      await settle();
      await act(async () => el('orchestrator-finale-read-btn').click());
      expect(onReadReport).toHaveBeenCalledTimes(1);
      expect(onReadReport).toHaveBeenCalledWith('summary-1');
      expect(query('orchestrator-finale')).toBeNull();
    });

    it('dismisses without reading', async () => {
      await renderRun([agentFixture('a', 'working')]);
      await renderRun(finished);
      await settle();
      await act(async () => el('orchestrator-finale-dismiss-btn').click());
      expect(query('orchestrator-finale')).toBeNull();
      expect(onReadReport).not.toHaveBeenCalled();
    });

    it('tells the views to celebrate while the banner is up', async () => {
      const seen: boolean[] = [];
      const renderView = (_view: string, props: { celebrating?: boolean }) => {
        seen.push(props.celebrating ?? false);
        return null;
      };
      const renderWith = (agents: AgentView[]) =>
        themed.render(
          <OrchestratorStage
            agents={agents}
            rootId="root"
            report={REPORT}
            layout={singlePaneLayout('tavern')}
            onLayoutChange={onLayoutChange}
            actions={actions}
            introPlaying={false}
            renderView={renderView}
          />
        );
      await renderWith([agentFixture('a', 'working')]);
      await renderWith(finished);
      expect(seen.at(-1)).toBe(false);
      await settle();
      expect(seen.at(-1)).toBe(true);
    });

    it('seats the banner on the tavern scene rather than above it', async () => {
      const renderTavern = (agents: AgentView[]) =>
        themed.render(
          <OrchestratorStage
            agents={agents}
            rootId="root"
            report={REPORT}
            layout={singlePaneLayout('tavern')}
            onLayoutChange={onLayoutChange}
            actions={actions}
            introPlaying={false}
            renderView={(_view, props) => <TavernView {...props} />}
          />
        );
      await renderTavern([agentFixture('a', 'working')]);
      await renderTavern(finished);
      await settle();
      expect(el('orchestrator-tavern').contains(el('orchestrator-finale'))).toBe(true);
      expect(el('orchestrator-finale').getAttribute('data-placement')).toBe('scene');
    });

    it('passes the finale overlay to Office and keeps it inline in Focus mode', async () => {
      const renderOffice = (focus = false) =>
        themed.render(
          <OrchestratorStage
            agents={finished}
            rootId="root"
            report={REPORT}
            layout={singlePaneLayout('office')}
            onLayoutChange={onLayoutChange}
            actions={actions}
            introPlaying={false}
            focus={{ on: focus, onToggle: vi.fn() }}
            renderView={(_id, props) => <div data-testid="office-scene">{props.sceneOverlay}</div>}
          />
        );
      await renderOffice();
      await settle();
      expect(el('office-scene').contains(el('orchestrator-finale'))).toBe(true);
      expect(el('orchestrator-finale').getAttribute('data-placement')).toBe('scene');
      expect(el('orchestrator-finale').getAttribute('data-look')).toBe('office');
      expect(el('orchestrator-finale').getAttribute('aria-label')).toBe('Shift ended');
      const portrait = el('orchestrator-finale').querySelector('img')?.getAttribute('src');
      expect([MANAGER_ART.idle, MANAGER_ART.cheering]).toContain(portrait);

      await renderOffice(true);
      expect(query('office-scene')).toBeNull();
      expect(el('orchestrator-finale').getAttribute('data-placement')).toBe('inline');
      expect(query('orchestrator-focus-panel')).not.toBeNull();
    });

    it("titles the Aquarium's finale from its own copy and shows the Keeper", async () => {
      await themed.render(
        <OrchestratorStage
          agents={finished}
          rootId="root"
          report={REPORT}
          layout={singlePaneLayout('aquarium')}
          onLayoutChange={onLayoutChange}
          actions={actions}
          introPlaying={false}
          renderView={(_id, props) => <div data-testid="aquarium-scene">{props.sceneOverlay}</div>}
        />
      );
      await settle();
      expect(el('aquarium-scene').contains(el('orchestrator-finale'))).toBe(true);
      expect(el('orchestrator-finale').getAttribute('aria-label')).toBe(AQUARIUM_SCENE.copy.stage.finale.ended);
      expect(el('orchestrator-finale').textContent).not.toContain('Quest');
      const portrait = el('orchestrator-finale').querySelector('img')?.getAttribute('src');
      expect([KEEPER_ART.idle, KEEPER_ART.cheering]).toContain(portrait);
    });

    it('waits for the parent to write its summary', async () => {
      const renderNoReport = (agents: AgentView[]) =>
        themed.render(
          <OrchestratorStage
            agents={agents}
            rootId="root"
            layout={singlePaneLayout('table')}
            onLayoutChange={onLayoutChange}
            actions={actions}
            introPlaying={false}
          />
        );
      await renderNoReport([agentFixture('a', 'working')]);
      await renderNoReport(finished);
      await settle();
      expect(query('orchestrator-finale')).toBeNull();
    });
  });

  it('swaps the view for the Focus panel, whose Open buttons reach the drawer and the parent', async () => {
    const onParentFocus = vi.fn();
    const renderFocused = (on: boolean) =>
      themed.render(
        <OrchestratorStage
          agents={FIXTURE}
          parent={{ status: 'needs-action' }}
          onParentFocus={onParentFocus}
          rootId="root"
          layout={singlePaneLayout('table')}
          onLayoutChange={onLayoutChange}
          actions={actions}
          introPlaying={false}
          focus={{ on, onToggle: vi.fn() }}
        />
      );
    await renderFocused(true);
    expect(query('orchestrator-table-row-w1')).toBeNull();
    const openButtons = () =>
      Array.from(document.querySelectorAll<HTMLElement>('[data-testid="orchestrator-focus-open-btn"]'));
    expect(openButtons()).toHaveLength(2);
    await act(async () => openButtons()[0].click());
    expect(onParentFocus).toHaveBeenCalledTimes(1);
    await act(async () => openButtons()[1].click());
    expect(el('orchestrator-peek-drawer').textContent).toContain('Agent n');

    await renderFocused(false);
    expect(query('orchestrator-focus-panel')).toBeNull();
    expect(query('orchestrator-table-row-w1')).not.toBeNull();
  });

  it('carries Focus actions out: Allow once and Stop through the stage, and a refusal from main back to the panel', async () => {
    const respondToApproval = vi.fn().mockResolvedValue(undefined);
    const chat = (window as unknown as { b4m: { chat: Record<string, unknown> } }).b4m.chat;
    chat.respondToApproval = respondToApproval;
    chat.getSession = vi.fn().mockResolvedValue({
      messages: [
        {
          id: 'm1',
          role: 'assistant',
          content: '',
          toolCalls: [
            {
              id: 'c1',
              name: 'bash_execute',
              input: { command: 'touch x' },
              status: 'awaiting-approval',
              approvalId: 'p1',
              approvalDetail: '$ touch x',
            },
          ],
        },
      ],
    });
    await themed.render(
      <OrchestratorStage
        agents={[agentFixture('w1', 'working')]}
        parent={{ status: 'needs-action' }}
        rootId="root"
        layout={singlePaneLayout('table')}
        onLayoutChange={onLayoutChange}
        actions={actions}
        introPlaying={false}
        focus={{ on: true, onToggle: vi.fn() }}
      />
    );
    await act(async () => el('orchestrator-focus-stop-btn').click());
    expect(actions.stop).toHaveBeenCalledWith('w1');

    respondToApproval.mockRejectedValueOnce(new Error('Already answered'));
    await act(async () => el('orchestrator-focus-allow-once-btn').click());
    expect(respondToApproval).toHaveBeenCalledWith('p1', { decision: 'once' });
    expect(el('orchestrator-focus-error').textContent).toBe('Already answered');
  });

  it('opens the agent a notice asked for, once, and says it was taken', async () => {
    const onFocusAgentConsumed = vi.fn();
    const renderFocus = (focusAgent: string | null) =>
      themed.render(
        <OrchestratorStage
          agents={FIXTURE}
          layout={singlePaneLayout('table')}
          onLayoutChange={onLayoutChange}
          actions={actions}
          introPlaying={false}
          focusAgent={focusAgent}
          onFocusAgentConsumed={onFocusAgentConsumed}
        />
      );
    await renderFocus('n');
    expect(query('orchestrator-peek-drawer')).not.toBeNull();
    expect(onFocusAgentConsumed).toHaveBeenCalledTimes(1);
  });
});
