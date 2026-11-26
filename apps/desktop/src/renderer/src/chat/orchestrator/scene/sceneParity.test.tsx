// @vitest-environment jsdom
import { act } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ChatSession } from '@shared/chat';
import type { PendingDecision } from '@shared/orchestration';
import { assignPersonas } from '@shared/agentPersona';
import { OrchestratorStage, type OrchestratorViewProps } from '../OrchestratorStage';
import { singlePaneLayout } from '../orchestratorLayout';
import { describeAgentStates, type AgentState, type AgentView } from '../roster';
import { agentFixture, createThemedMount, el, query } from '../testUtils';
import { ORCHESTRATOR_VIEW_COMPONENTS, renderOrchestratorView } from '../viewRegistry';
import { ANNOUNCE_DEBOUNCE_MS } from './announcements';
import { SCENE_VIEW_IDS, registeredScene } from './registeredScenes';
import { UNFOCUSED_PAUSE_MS } from './useScenePause';

/**
 * One feature suite run against every registered scene (registeredScenes.ts). A scene differs only by its
 * definition's skin, map, sprites and copy, so each check reads its expectations off the definition.
 */

vi.mock('../chime', () => ({ playChime: vi.fn(), playSoundEvent: vi.fn() }));

const ALL_STATES: AgentState[] = ['working', 'waiting', 'needs-you', 'done', 'failed', 'paused', 'stopped', 'idle'];
const HUNDREDS = 300;
// jsdom with style injection; generous so a loaded CI machine passes, tight enough to catch a quadratic walk.
const HUNDREDS_BUDGET_MS = 4000;

const parkedCall = (approvalId: string) => ({
  id: `call-${approvalId}`,
  name: 'bash',
  input: { command: 'pnpm test' },
  status: 'awaiting-approval',
  approvalId,
});

/** A session whose reply in flight is parked on one approval, `ap-<id>`, as getSession returns it. */
const parkedSession = (id: string) =>
  ({
    id,
    messages: [{ id: 'm1', role: 'assistant', content: '', toolCalls: [parkedCall(`ap-${id}`)] }],
  }) as unknown as ChatSession;

const decision = (labels: string[]): PendingDecision => ({
  id: 'd-1',
  askedAt: '2026-11-16T00:00:00.000Z',
  question: {
    question: 'Which database?',
    header: 'Decision',
    options: labels.map(label => ({ label, description: '' })),
  },
});

const many = (prefix: string, state: AgentState, count: number) =>
  Array.from({ length: count }, (_, index) => agentFixture(`${prefix}${index}`, state));

const key = (target: Element, name: string) =>
  act(async () => {
    target.dispatchEvent(new KeyboardEvent('keydown', { key: name, bubbles: true, cancelable: true }));
  });

// The intro walk starts two frames after mount; frames run callbacks in request order, so these land after it.
const nextFrames = () =>
  act(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));

const setReducedMotion = () =>
  vi.spyOn(window, 'matchMedia').mockImplementation(media => ({
    matches: media.includes('prefers-reduced-motion'),
    media,
    onchange: null,
    addListener: () => {},
    removeListener: () => {},
    addEventListener: () => {},
    removeEventListener: () => {},
    dispatchEvent: () => false,
  }));

let chat: Record<string, ReturnType<typeof vi.fn>>;

beforeEach(() => {
  Element.prototype.scrollIntoView = vi.fn();
  chat = {
    getSession: vi.fn().mockResolvedValue(null),
    getHeldRelays: vi.fn().mockResolvedValue([]),
    onStreamEvent: vi.fn(() => () => undefined),
    onQueueChanged: vi.fn(() => () => undefined),
    respondToApproval: vi.fn().mockResolvedValue(undefined),
    answerTaskDecision: vi.fn().mockResolvedValue(undefined),
    resolveHeldRelay: vi.fn().mockResolvedValue(undefined),
    getRunSpend: vi.fn().mockResolvedValue({ status: 'unattributed' }),
  };
  (window as unknown as { b4m: unknown }).b4m = { chat };
});

const mount = createThemedMount();

afterEach(() => {
  mount.unmount();
  vi.restoreAllMocks();
  vi.useRealTimers();
  window.localStorage.clear();
});

it('finds at least one registered scene', () => {
  expect(SCENE_VIEW_IDS.length).toBeGreaterThan(0);
});

describe.each(SCENE_VIEW_IDS)('the %s scene', view => {
  const scene = registeredScene(view);
  if (!scene) {
    it('is a framework scene', () => expect.fail(`"${view}" is not registered through sceneView`));
    return;
  }
  const View = ORCHESTRATOR_VIEW_COMPONENTS[view];
  const { map, copy, states } = scene;
  const id = `orchestrator-${scene.id}`;
  const workZone = states.zone.working;
  const workSlots = map.zones[workZone].slots;
  const sprite = (agentId: string) => el(`${id}-agent-${agentId}`);
  const sprites = () => [...el(id).querySelectorAll<HTMLElement>(`[role="button"][data-testid^="${id}-agent-"]`)];
  const at = (node: HTMLElement) => ({ left: node.style.left, top: node.style.top });
  const pct = (point: { x: number; y: number }) => ({ left: `${point.x}%`, top: `${point.y}%` });

  const props = (agents: AgentView[], extra: Partial<OrchestratorViewProps> = {}): OrchestratorViewProps => ({
    agents,
    onSelect: vi.fn(),
    selectedId: null,
    introPlaying: false,
    personas: assignPersonas(agents),
    ...extra,
  });
  const render = (viewProps: OrchestratorViewProps) => mount.render(<View {...viewProps} />);

  const REPORT = { id: 'summary-1', createdAt: '2026-10-01T00:10:00.000Z' };
  const renderStage = (agents: AgentView[], extra: { rootId?: string; report?: typeof REPORT } = {}) =>
    mount.render(
      <OrchestratorStage
        agents={agents}
        layout={singlePaneLayout(view)}
        onLayoutChange={vi.fn()}
        actions={{ open: vi.fn(), stop: vi.fn(), archive: vi.fn() }}
        introPlaying={false}
        renderView={renderOrchestratorView}
        {...extra}
      />
    );

  describe('needs-you bubble', () => {
    it('approves a parked call inline from the bubble', async () => {
      chat.getSession.mockImplementation(async (sessionId: string) => parkedSession(sessionId));
      await render(props([agentFixture('n', 'needs-you')]));
      expect(el(`${id}-bubble-n-label`).textContent).toBe('Needs you!');
      await act(async () => el(`${id}-bubble-n-approve`).click());
      expect(chat.respondToApproval).toHaveBeenCalledWith('ap-n', { decision: 'once' });
    });

    it('denies a parked call inline from the bubble', async () => {
      chat.getSession.mockImplementation(async (sessionId: string) => parkedSession(sessionId));
      await render(props([agentFixture('n', 'needs-you')]));
      await act(async () => el(`${id}-bubble-n-deny`).click());
      expect(chat.respondToApproval).toHaveBeenCalledWith('ap-n', { decision: 'deny' });
    });

    it('answers a task decision with the clicked option', async () => {
      await render(props([agentFixture('n', 'needs-you', { decision: decision(['Postgres', 'SQLite']) })]));
      await act(async () => el(`${id}-bubble-n-option-1`).click());
      expect(chat.answerTaskDecision).toHaveBeenCalledWith('n', 'd-1', {
        status: 'answered',
        answers: [{ selected: ['SQLite'] }],
      });
    });
  });

  describe('dialogue queue', () => {
    it('asks every request in the dialogue box, in order, and answers the front one by key', async () => {
      chat.getSession.mockImplementation(async (sessionId: string) => parkedSession(sessionId));
      const agents = [agentFixture('n1', 'needs-you'), agentFixture('n2', 'needs-you'), agentFixture('w', 'working')];
      const personas = assignPersonas(agents);
      await renderStage(agents);
      const box = el('scene-dialogue');
      expect(el('scene-dialogue-name').textContent).toContain(personas.get('n1')?.label);
      expect(el(id).contains(box)).toBe(true);
      expect(el('scene-dialogue-position').textContent).toBe('1 of 2');
      // One place to answer: the bubbles keep only their marker.
      expect(query(`${id}-bubble-n1-approve`)).toBeNull();
      await key(box, 'a');
      expect(chat.respondToApproval).toHaveBeenCalledWith('ap-n1', { decision: 'once' });
      // The answered request leaves at once and the next comes forward.
      expect(el('scene-dialogue-name').textContent).toContain(personas.get('n2')?.label);
    });

    it('brings a clicked waiting character to the front of the box', async () => {
      chat.getSession.mockImplementation(async (sessionId: string) => parkedSession(sessionId));
      await renderStage([agentFixture('n1', 'needs-you'), agentFixture('n2', 'needs-you')]);
      await act(async () => sprite('n2').click());
      expect(el('scene-dialogue-position').textContent).toBe('2 of 2');
    });
  });

  describe('quest board', () => {
    it("pins a note for each working and needs-you agent, in the scene's own words and place", async () => {
      const view = props([agentFixture('w', 'working'), agentFixture('n', 'needs-you'), agentFixture('d', 'done')]);
      await render(view);
      const board = el(`${id}-quest-board`);
      expect(board.getAttribute('aria-label')).toBe(`${copy.board.name}: 2 open ${copy.board.items}`);
      expect(board.textContent).toContain(copy.board.title);
      expect(at(board)).toEqual({ left: `${map.board.left}%`, top: `${map.board.top}%` });
      expect(map.board.width).toBeGreaterThan(0);
      expect(map.board.height).toBeGreaterThan(0);
      expect(query(`${id}-quest-w`)).not.toBeNull();
      expect(query(`${id}-quest-n`)).not.toBeNull();
      expect(query(`${id}-quest-d`)).toBeNull();
      await act(async () => el(`${id}-quest-w`).click());
      expect(view.onSelect).toHaveBeenCalledWith('w');
    });

    it('shows its empty line with no open work', async () => {
      await render(props([agentFixture('d', 'done')]));
      expect(el(`${id}-quest-empty`).textContent).toBe(copy.board.empty);
    });
  });

  describe('overflow', () => {
    it('stacks a full zone behind one button that names its place', async () => {
      const agents = many('w', 'working', workSlots.length + 2);
      await render(props(agents));
      expect(query(`${id}-agent-w${workSlots.length}`)).toBeNull();
      const stack = el(`${id}-overflow-${workZone}`);
      expect(stack.tagName).toBe('BUTTON');
      expect(el(`${id}-overflow-${workZone}-count`).textContent).toBe('+2');
      expect(stack.getAttribute('aria-label')).toBe(`2 more ${map.zones[workZone].place}; list them`);
      expect(at(stack)).toEqual(pct(map.zones[workZone].overflow));
    });

    it('lists the stacked agents in a keyboard menu: arrows move, Enter selects', async () => {
      const view = props(many('w', 'working', workSlots.length + 2));
      await render(view);
      const stack = el(`${id}-overflow-${workZone}`);
      const items = () => [...document.querySelectorAll<HTMLElement>(`[data-testid^="${id}-overflow-item-"]`)];
      stack.focus();
      await key(stack, 'ArrowDown');
      expect(document.activeElement).toBe(items()[0]);
      await key(items()[0], 'ArrowDown');
      expect(document.activeElement).toBe(items()[1]);
      await key(items()[1], 'Enter');
      expect(view.onSelect).toHaveBeenCalledWith(`w${workSlots.length + 1}`);
    });

    it('never stacks a needs-you agent while a calm agent holds a seat', async () => {
      // Every zone a calm state reaches is full, and more wait than the needs-you zone seats.
      const seats = Object.values(map.zones).reduce((sum, zone) => sum + zone.slots.length, 0);
      const calmStates = ALL_STATES.filter(state => state !== 'needs-you');
      const calm = Array.from({ length: seats * calmStates.length }, (_, index) =>
        agentFixture(`c${index}`, calmStates[index % calmStates.length])
      );
      const waiting = many('n', 'needs-you', map.zones[states.zone['needs-you']].slots.length + 2);
      await render(props([...calm, ...waiting]));
      for (const agent of waiting) expect(query(`${id}-agent-${agent.id}`), agent.id).not.toBeNull();
    });
  });

  describe('host', () => {
    it('stands at its spot in its idle pose, named in the scene copy, and opens the conversation', async () => {
      const onInnkeeperSelect = vi.fn();
      await render(props([], { onInnkeeperSelect, desk: { onReadReply: vi.fn(), conversationHidden: true } }));
      const host = el(`${id}-host`);
      expect(at(host)).toEqual(pct(map.host));
      expect(host.getAttribute('aria-label')).toBe(`${copy.hostName}: ${copy.hostPoses.idle}`);
      expect(host.getAttribute('title')).toBe(`${copy.hostName}: ${copy.hostTitle}`);
      expect(el(`${id}-host-art`).getAttribute('src')).toBe(scene.cast.host.sprites.idle);
      expect(el(`${id}-host-greeting`).textContent).toBe(copy.hostGreeting);
      await act(async () => host.click());
      expect(onInnkeeperSelect).toHaveBeenCalledOnce();
    });

    it('hangs its reply bubble while the conversation is hidden, and reads or dismisses it', async () => {
      const onReadReply = vi.fn();
      const desk = { reply: { id: 'r1', snippet: 'All done.' }, onReadReply, conversationHidden: true };
      await render(props([agentFixture('w', 'working')], { desk }));
      expect(el(`${id}-reply-bubble`).textContent).toContain('All done.');
      await act(async () => el(`${id}-reply-read-btn`).click());
      expect(onReadReply).toHaveBeenCalledWith('r1');
      expect(query(`${id}-reply-bubble`)).toBeNull();

      mount.unmount();
      await render(props([agentFixture('w', 'working')], { desk: { ...desk, reply: { id: 'r2', snippet: 'More.' } } }));
      await act(async () => el(`${id}-reply-dismiss-btn`).click());
      expect(query(`${id}-reply-bubble`)).toBeNull();
    });

    it('walks over to an agent the parent is reading', async () => {
      const agents = [agentFixture('a', 'working')];
      const parent = {
        status: 'processing' as const,
        activity: { kind: 'tool' as const, tool: 'session_read', detail: '', target: 'a' },
      };
      await render(props(agents, { parent }));
      const host = el(`${id}-host`);
      expect(host.dataset.pose).toBe('walking');
      expect(at(host)).not.toEqual(pct(map.host));
    });
  });

  it('shows the PR indicator on a sprite and opens the PR without selecting the agent', async () => {
    const onOpenPr = vi.fn();
    const view = props([agentFixture('a', 'working', { pr: { number: 12, state: 'open' } })], { onOpenPr });
    await render(view);
    const indicator = sprite('a').querySelector<HTMLElement>('[data-testid="orchestrator-pr-indicator"]');
    if (!indicator) throw new Error('no PR indicator on the sprite');
    await act(async () => indicator.dispatchEvent(new MouseEvent('click', { bubbles: true, shiftKey: true })));
    expect(onOpenPr).toHaveBeenCalledWith('a');
    expect(view.onSelect).not.toHaveBeenCalled();
  });

  it('opens the agent details inside the scene when a sprite is selected', async () => {
    await renderStage([agentFixture('a', 'working'), agentFixture('b', 'done')]);
    expect(query('orchestrator-peek-drawer')).toBeNull();
    await act(async () => sprite('a').click());
    const drawer = el('orchestrator-peek-drawer');
    expect(el(id).contains(drawer)).toBe(true);
    expect(sprite('a').getAttribute('aria-pressed')).toBe('true');
  });

  describe('finale', () => {
    const finish = async (agents: AgentView[]) => {
      vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
      await renderStage(agents, { rootId: 'root', report: REPORT });
      await act(async () => vi.advanceTimersByTime(5000));
      await renderStage(agents, { rootId: 'root', report: REPORT });
    };

    it("titles the banner from the scene's copy, shows its host, and seats it in the scene", async () => {
      await finish([agentFixture('a', 'done'), agentFixture('b', 'failed')]);
      const banner = el('orchestrator-finale');
      expect(el(id).contains(banner)).toBe(true);
      expect(banner.getAttribute('data-placement')).toBe('scene');
      expect(banner.getAttribute('aria-label')).toBe(copy.stage.finale.ended);
      expect(banner.getAttribute('data-look')).toBe(scene.look.finale);
      const portrait = banner.querySelector('img')?.getAttribute('src');
      expect(Object.values(scene.cast.host.sprites)).toContain(portrait);
      expect(el(`${id}-host`).dataset.pose).toBe('cheering');
      expect(sprite('a').dataset.cheering).toBe('true');
    });

    it('says complete when every agent finished done', async () => {
      await finish([agentFixture('a', 'done'), agentFixture('b', 'done')]);
      expect(el('orchestrator-finale').getAttribute('aria-label')).toBe(copy.stage.finale.complete);
    });
  });

  it('settles into last call: the frame, light and spill change, and the room drifts if the scene asks', async () => {
    await render(props([agentFixture('a', 'working')]));
    expect(el(`${id}-light`).dataset.mood).toBe('day');
    expect(el(`${id}-frame`).dataset.settled).toBeUndefined();
    expect(getComputedStyle(el(`${id}-spill`)).opacity).toBe('0');
    await render(props([agentFixture('a', 'working')], { settled: true }));
    expect(el(`${id}-light`).dataset.mood).toBe('last-call');
    expect(el(`${id}-frame`).dataset.settled).toBe('true');
    expect(getComputedStyle(el(`${id}-spill`)).opacity).toBe('1');
    expect(getComputedStyle(el(id)).boxShadow).toBe(scene.ambience.settledShadow);
    const drift = getComputedStyle(el(id)).animation;
    if (scene.ambience.settledDrift) expect(drift).toMatch(/120s/);
    else expect(drift).toBe('none');
  });

  describe('intro and walks', () => {
    it('walks everyone in from the door during the intro', async () => {
      await render(props([agentFixture('a', 'working')], { introPlaying: true }));
      expect(at(sprite('a'))).toEqual(pct(map.door));
      await nextFrames();
      expect(at(sprite('a'))).toEqual(pct(workSlots[0]));
    });

    it('walks a newcomer in from the door after the intro', async () => {
      const first = props([agentFixture('a', 'working')]);
      await render(first);
      await nextFrames();
      await render({ ...first, agents: [agentFixture('a', 'working'), agentFixture('b', 'working')] });
      expect(at(sprite('b'))).toEqual(pct(map.door));
      await nextFrames();
      expect(at(sprite('b'))).toEqual(pct(workSlots[1]));
    });
  });

  describe('pause', () => {
    const blurLong = () =>
      act(async () => {
        window.dispatchEvent(new Event('blur'));
        vi.advanceTimersByTime(UNFOCUSED_PAUSE_MS + 1);
      });

    it('stops every looping animation while the window is hidden', async () => {
      await render(props([agentFixture('a', 'working')]));
      expect(el(`${id}-frame`).dataset.paused).toBeUndefined();
      await act(async () => {
        vi.spyOn(document, 'hidden', 'get').mockReturnValue(true);
        document.dispatchEvent(new Event('visibilitychange'));
      });
      expect(el(`${id}-frame`).dataset.paused).toBe('hidden');
      const css = [...document.querySelectorAll('style')].map(style => style.textContent).join('\n');
      expect(css).toMatch(/\[data-paused\][^{]*\{[^}]*animation-play-state:\s*paused/);
    });

    it(
      scene.ambience.awakeUnfocused
        ? 'keeps going while unfocused, as the definition asks, but stops when hidden'
        : 'stops after a while unfocused, and goes on when focus returns',
      async () => {
        vi.useFakeTimers();
        await render(props([agentFixture('a', 'working')]));
        await blurLong();
        if (scene.ambience.awakeUnfocused) {
          expect(el(`${id}-frame`).dataset.paused).toBeUndefined();
          await act(async () => {
            vi.spyOn(document, 'hidden', 'get').mockReturnValue(true);
            document.dispatchEvent(new Event('visibilitychange'));
          });
          expect(el(`${id}-frame`).dataset.paused).toBe('hidden');
        } else {
          expect(el(`${id}-frame`).dataset.paused).toBe('unfocused');
          await act(async () => window.dispatchEvent(new Event('focus')));
          expect(el(`${id}-frame`).dataset.paused).toBeUndefined();
        }
      }
    );
  });

  describe('reduced motion', () => {
    it('seats everyone at once, with no walk from the door', async () => {
      setReducedMotion();
      await render(props([agentFixture('a', 'working')], { introPlaying: true }));
      expect(at(sprite('a'))).toEqual(pct(workSlots[0]));
      await render(props([agentFixture('a', 'working'), agentFixture('b', 'working')], { introPlaying: true }));
      expect(at(sprite('b'))).toEqual(pct(workSlots[1]));
    });

    it('keeps the host at its spot and marks the agent it is reading instead', async () => {
      setReducedMotion();
      const parent = {
        status: 'processing' as const,
        activity: { kind: 'tool' as const, tool: 'session_read', detail: '', target: 'a' },
      };
      await render(props([agentFixture('a', 'working')], { parent }));
      expect(at(el(`${id}-host`))).toEqual(pct(map.host));
      expect(sprite('a').dataset.hostVisit).toBe('true');
    });
  });

  describe('keyboard', () => {
    it('makes each sprite a focusable button that selects on Enter and Space only', async () => {
      const view = props([agentFixture('a', 'working')]);
      await render(view);
      expect(sprite('a').getAttribute('role')).toBe('button');
      expect(sprite('a').tabIndex).toBe(0);
      await key(sprite('a'), 'Enter');
      await key(sprite('a'), ' ');
      await key(sprite('a'), 'x');
      expect(view.onSelect).toHaveBeenCalledTimes(2);
      expect(view.onSelect).toHaveBeenCalledWith('a');
    });

    it('marks the selected sprite with aria-pressed', async () => {
      const agents = [agentFixture('a', 'working'), agentFixture('b', 'done')];
      await render(props(agents, { selectedId: 'b' }));
      expect(sprite('a').getAttribute('aria-pressed')).toBe('false');
      expect(sprite('b').getAttribute('aria-pressed')).toBe('true');
    });
  });

  describe('screen readers', () => {
    it('names the scene and points at a summary of the room', async () => {
      const agents = [agentFixture('a', 'working'), agentFixture('b', 'needs-you'), agentFixture('c', 'done')];
      await render(props(agents));
      const room = el(id);
      expect(room.getAttribute('role')).toBe('group');
      expect(room.getAttribute('aria-label')).toBe(copy.name);
      const summary = document.getElementById(room.getAttribute('aria-describedby') ?? '');
      expect(summary?.textContent).toBe(
        describeAgentStates(
          agents.map(agent => agent.state),
          0
        )
      );
    });

    it('announces an agent that comes to need you in its live region', async () => {
      vi.useFakeTimers();
      const view = props([agentFixture('a', 'working')]);
      await render(view);
      expect(el(`${id}-announcer`).getAttribute('aria-live')).toBe('polite');
      await render({ ...view, agents: [agentFixture('a', 'needs-you')] });
      await act(async () => vi.advanceTimersByTime(ANNOUNCE_DEBOUNCE_MS));
      expect(el(`${id}-announcer`).textContent).toBe(`${view.personas.get('a')?.label} needs you.`);
    });
  });

  it('keeps every seated agent in its seat across roster updates', async () => {
    const [a, b, c] = many('s', 'working', 3);
    const view = props([a, b, c]);
    await render(view);
    const before = { b: at(sprite('s1')), c: at(sprite('s2')) };
    await render({ ...view, agents: [b, c] });
    await render({ ...view, agents: [c, b, agentFixture('s3', 'working')] });
    await render({
      ...view,
      agents: [c, { ...b, updatedAt: '2026-10-01T00:00:05.000Z' }, agentFixture('s3', 'working')],
    });
    await nextFrames();
    expect(at(sprite('s1'))).toEqual(before.b);
    expect(at(sprite('s2'))).toEqual(before.c);
    expect(at(sprite('s3'))).toEqual(pct(workSlots[0]));
  });

  it('shows each agent by a one-word name', async () => {
    const agents = ALL_STATES.map((state, index) => agentFixture(`a${index}`, state));
    const view = props(agents);
    await render(view);
    for (const agent of agents) {
      const name = view.personas.get(agent.id)?.label ?? '';
      expect(name).toMatch(/^\S+$/);
      expect(el(`${id}-name-${agent.id}`).textContent).toBe(name);
      expect(sprite(agent.id).getAttribute('aria-label')?.startsWith(`${name}: `)).toBe(true);
    }
  });

  it('draws hundreds of agents within budget, every seat used once and everyone else stacked', async () => {
    const agents = Array.from({ length: HUNDREDS }, (_, index) =>
      agentFixture(`h${index}`, ALL_STATES[index % ALL_STATES.length])
    );
    const started = performance.now();
    await render(props(agents));
    await render(props(agents.map(agent => ({ ...agent, updatedAt: '2026-10-01T00:00:09.000Z' }))));
    expect(performance.now() - started).toBeLessThan(HUNDREDS_BUDGET_MS);

    const seated = sprites();
    expect(new Set(seated.map(node => `${node.style.left},${node.style.top}`)).size).toBe(seated.length);
    const stacked = [...el(id).querySelectorAll<HTMLElement>(`[data-testid^="${id}-overflow-"][data-testid$="-count"]`)]
      .map(count => Number(count.textContent?.replace(/\D/g, '')))
      .reduce((sum, count) => sum + count, 0);
    expect(seated.length + stacked).toBe(HUNDREDS);
  }, 15_000);
});
