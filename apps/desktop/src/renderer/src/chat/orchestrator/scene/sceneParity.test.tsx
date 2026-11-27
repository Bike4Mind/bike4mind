// @vitest-environment jsdom
import { act } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ChatSession } from '@shared/chat';
import type { PendingDecision } from '@shared/orchestration';
import { assignPersonas } from '@shared/agentPersona';
import { chatBackedHostBridge } from '../../../__fixtures__/chatBackedHostBridge';
import { OrchestratorStage, type OrchestratorViewProps } from '../OrchestratorStage';
import { singlePaneLayout } from '../orchestratorLayout';
import { describeAgentStates, type AgentState, type AgentView } from '../roster';
import { agentFixture, createThemedMount, el, query } from '../testUtils';
import { ORCHESTRATOR_VIEW_COMPONENTS, renderOrchestratorView } from '../viewRegistry';
import { sampleSkinSummary } from '../sampleSkin';
import { resetSkinsForTests } from '../skins';
import { mergeSkinTheme } from '../statePalette';
import { ANNOUNCE_DEBOUNCE_MS } from './announcements';
import { SCENE_VIEW_IDS, registeredScene } from './registeredScenes';
import { skinScene } from './sceneSkin';
import { ASK_OUTCOME_MS } from './useAskStates';
import { UNFOCUSED_PAUSE_MS } from './useScenePause';

/**
 * One feature suite run against every registered scene (registeredScenes.ts), bare and under the sample
 * skin, since a skin may change a scene's sprites, map and copy but never take a feature away. Each check
 * reads its expectations off the definition as the skin draws it.
 */
const SKINS = [
  { skin: 'no skin', summary: undefined },
  { skin: 'the nightglass skin', summary: sampleSkinSummary() },
];
const CASES = SCENE_VIEW_IDS.flatMap(view => SKINS.map(skin => ({ view, ...skin })));

vi.mock('../chime', () => ({ playChime: vi.fn(), playSoundEvent: vi.fn() }));

const ALL_STATES: AgentState[] = ['working', 'waiting', 'needs-you', 'done', 'failed', 'paused', 'stopped', 'idle'];
const HUNDREDS = 300;

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
  (window as unknown as { b4m: unknown }).b4m = { host: chatBackedHostBridge(), chat };
});

const mount = createThemedMount();

afterEach(() => {
  mount.unmount();
  vi.restoreAllMocks();
  vi.useRealTimers();
  window.localStorage.clear();
  resetSkinsForTests();
});

it('finds at least one registered scene', () => {
  expect(SCENE_VIEW_IDS.length).toBeGreaterThan(0);
});

describe.each(CASES)('the $view scene with $skin', ({ view, summary }) => {
  const shipped = registeredScene(view);
  if (!shipped) {
    it('is a framework scene', () => expect.fail(`"${view}" is not registered through sceneView`));
    return;
  }
  const block = summary && mergeSkinTheme(summary).scenes[shipped.id];
  const scene = skinScene(shipped, block, summary?.id ?? null);
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
  const renderStage = (
    agents: AgentView[],
    extra: { rootId?: string; report?: typeof REPORT; archivedAgents?: Array<{ id: string; title: string }> } = {}
  ) =>
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

  beforeEach(() => resetSkinsForTests(summary ? [summary] : [], summary?.id ?? null));

  if (summary) {
    it("draws the skin's version of the scene", async () => {
      expect(block, `the skin has no ${shipped.id} block`).toBeDefined();
      expect(scene !== shipped, `the skin's ${shipped.id} block fails the scene schema, so it was dropped`).toBe(true);
      await render(props([agentFixture('a', 'working')]));
      expect(el(id).querySelector(':scope > img')?.getAttribute('src')).toBe(scene.map.backdrop);
    });
  }

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

    it('opens a waiting agent from its "Needs you!" marker when the box has nothing to ask', async () => {
      await renderStage([agentFixture('n1', 'needs-you'), agentFixture('w', 'working')]);
      await act(async () => undefined);
      const marker = el(`${id}-bubble-n1`);
      expect(marker.textContent).toBe('Needs you!');
      expect(getComputedStyle(marker).pointerEvents).toBe('auto');
      expect(query('orchestrator-peek-drawer')).toBeNull();
      await act(async () => marker.click());
      expect(el(id).contains(el('orchestrator-peek-drawer'))).toBe(true);
      expect(sprite('n1').getAttribute('aria-pressed')).toBe('true');
    });
  });

  describe('ask bubble', () => {
    const bubble = () => el(`${id}-bubble-n1`);
    const session = (sessionId: string, call: Record<string, unknown>) =>
      ({
        id: sessionId,
        messages: [
          {
            id: 'm1',
            role: 'assistant',
            content: '',
            toolCalls: [
              { id: `call-${sessionId}`, status: 'awaiting-approval', approvalId: `ap-${sessionId}`, ...call },
            ],
          },
        ],
      }) as unknown as ChatSession;
    const bash = (sessionId: string) =>
      session(sessionId, { name: 'bash_execute', input: { command: 'pnpm test --filter api' } });
    const renderAsking = async (agents = [agentFixture('n1', 'needs-you')]) => {
      const view = props(agents, { inSceneDecisions: true });
      await render(view);
      await act(async () => undefined);
      return view;
    };

    it('names the tool and its command, waiting', async () => {
      chat.getSession.mockImplementation(async (sessionId: string) => bash(sessionId));
      await renderAsking();
      expect(bubble().dataset.askState).toBe('waiting');
      expect(el(`${id}-bubble-n1-ask`).textContent).toBe('bash_execute pnpm test --filter api');
      expect(el(`${id}-bubble-n1-state`).textContent).toBe('Waiting');
    });

    it.each([
      ['scene-dialogue-allow-once', 'approved', 'Approved', 'once'],
      ['scene-dialogue-deny', 'denied', 'Denied', 'deny'],
    ])('opens the ask from the bubble; %s shows it %s, then clears', async (control, state, label, answer) => {
      chat.getSession.mockImplementation(async (sessionId: string) => bash(sessionId));
      const view = await renderAsking();
      await act(async () => bubble().click());
      expect(view.onSelect).not.toHaveBeenCalled();
      expect(el('scene-dialogue-command').textContent).toContain('pnpm test --filter api');
      vi.useFakeTimers({ shouldAdvanceTime: true });
      await act(async () => el(control).click());
      expect(chat.respondToApproval).toHaveBeenCalledWith('ap-n1', { decision: answer });
      expect(bubble().dataset.askState).toBe(state);
      expect(bubble().textContent).toContain(label);
      await act(async () => vi.advanceTimersByTime(ASK_OUTCOME_MS + 1));
      expect(query(`${id}-bubble-n1`)?.dataset.askState).toBeUndefined();
    });

    it('keeps the ask waiting, with the error, when the answer is refused', async () => {
      chat.getSession.mockImplementation(async (sessionId: string) => bash(sessionId));
      chat.respondToApproval.mockRejectedValueOnce(new Error('Request expired'));
      await renderAsking();
      await act(async () => bubble().click());
      await act(async () => el('scene-dialogue-deny').click());
      expect(el('scene-dialogue-error').textContent).toContain('Request expired');
      expect(bubble().dataset.askState).toBe('waiting');
      expect((el('scene-dialogue-deny') as HTMLButtonElement).disabled).toBe(false);
    });

    it("shows a question's own text and options", async () => {
      const questions = [
        {
          question: 'Which database?',
          header: 'DB',
          options: [
            { label: 'Postgres (Recommended)', description: 'a' },
            { label: 'SQLite', description: 'b' },
          ],
        },
      ];
      chat.getSession.mockImplementation(async (sessionId: string) =>
        session(sessionId, { name: 'ask_user', input: { questions } })
      );
      await renderAsking();
      expect(el(`${id}-bubble-n1-ask`).textContent).toBe('Which database?');
      expect(el(`${id}-bubble-n1-option-0`).textContent).toBe('Postgres');
      expect(el(`${id}-bubble-n1-option-1`).textContent).toBe('SQLite');
    });

    // The renderer holds no expiry for an ask, so one that lapses or is answered in another window ends here.
    it('says so when the ask ended without an answer from this scene', async () => {
      chat.getSession.mockImplementation(async (sessionId: string) => bash(sessionId));
      const view = await renderAsking();
      chat.getSession.mockResolvedValue(null);
      await render({ ...view, agents: [agentFixture('n1', 'working')] });
      await act(async () => undefined);
      expect(bubble().dataset.askState).toBe('elsewhere');
      expect(bubble().textContent).toContain('Answered elsewhere');
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

    it('says the parent needs you over its head, and counts it in the room summary', async () => {
      const agents = [agentFixture('a', 'working')];
      await render(props(agents, { parent: { status: 'needs-action' } }));
      expect(el(`${id}-host-bubble`).textContent).toBe('Needs you!');
      const summary = document.getElementById(el(id).getAttribute('aria-describedby') ?? '');
      expect(summary?.textContent).toBe(describeAgentStates(['working'], 1));
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

  describe('empty stage', () => {
    it('draws the scene with its own empty line and nobody in it', async () => {
      await renderStage([]);
      const empty = el('orchestrator-empty-state');
      expect(empty.contains(el(id))).toBe(true);
      expect(empty.textContent).toContain(copy.stage.empty);
      expect(query('orchestrator-archived-agents')).toBeNull();
    });

    it('says its archived line and lists each archived agent once the run is all archived', async () => {
      await renderStage([], { archivedAgents: [{ id: 'a1', title: 'Write the docs' }] });
      const empty = el('orchestrator-empty-state');
      expect(empty.contains(el(id))).toBe(true);
      expect(empty.textContent).toContain(copy.stage.emptyArchived);
      expect(el('orchestrator-archived-agents').textContent).toContain('1 archived agent');
    });
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

  it('keeps each sprite at its place in the DOM when its agent comes to need you and stops', async () => {
    // A moved node loses its previous computed style, so its walk to the new seat would not animate.
    const [a, b, c] = many('o', 'working', 3);
    const view = props([a, b, c]);
    await render(view);
    const before = sprites();
    const unmoved = () => sprites().map((node, index) => node === before[index]);
    expect(before.map(node => node.dataset.agentAvatar)).toEqual(['o0', 'o1', 'o2']);
    // The roster lists needs-you first, so the agent that comes to need you moves to the front of the props.
    await render({ ...view, agents: [{ ...b, state: 'needs-you' }, a, c] });
    expect(sprite('o1').getAttribute('aria-label')).toMatch(/needs you/i);
    expect(unmoved()).toEqual([true, true, true]);
    await render({ ...view, agents: [a, { ...b, state: 'working' }, c] });
    expect(unmoved()).toEqual([true, true, true]);
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

  it('draws hundreds of agents, every seat used once and everyone else stacked', async () => {
    const agents = Array.from({ length: HUNDREDS }, (_, index) =>
      agentFixture(`h${index}`, ALL_STATES[index % ALL_STATES.length])
    );
    await render(props(agents));
    await render(props(agents.map(agent => ({ ...agent, updatedAt: '2026-10-01T00:00:09.000Z' }))));

    const seated = sprites();
    expect(new Set(seated.map(node => `${node.style.left},${node.style.top}`)).size).toBe(seated.length);
    const stacked = [...el(id).querySelectorAll<HTMLElement>(`[data-testid^="${id}-overflow-"][data-testid$="-count"]`)]
      .map(count => Number(count.textContent?.replace(/\D/g, '')))
      .reduce((sum, count) => sum + count, 0);
    expect(seated.length + stacked).toBe(HUNDREDS);
  }, 15_000);
});
