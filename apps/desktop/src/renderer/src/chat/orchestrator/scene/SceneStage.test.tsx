// @vitest-environment jsdom
import { act } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { assignPersonas } from '@shared/agentPersona';
import type { OrchestratorViewProps } from '../OrchestratorStage';
import type { AgentView } from '../roster';
import { stateLampColor } from '../statePalette';
import { agentFixture, createThemedMount, el, query } from '../testUtils';
import { ANNOUNCE_DEBOUNCE_MS } from './announcements';
import { SceneStage, sceneView } from './SceneStage';
import { TEST_SCENE } from './testScene';
import { UNFOCUSED_PAUSE_MS } from './useScenePause';

const mount = createThemedMount('dark');
const sprite = (id: string) => el(`orchestrator-test-yard-agent-${id}`);

function props(agents: AgentView[], extra: Partial<OrchestratorViewProps> = {}): OrchestratorViewProps {
  return {
    agents,
    onSelect: vi.fn(),
    selectedId: null,
    introPlaying: false,
    personas: assignPersonas(agents),
    ...extra,
  };
}

const render = (view: OrchestratorViewProps) => mount.render(<SceneStage {...view} scene={TEST_SCENE} />);

const press = (target: HTMLElement, key: string) =>
  act(async () => {
    target.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true }));
  });

beforeEach(() => {
  (window as unknown as { b4m: unknown }).b4m = {
    chat: {
      getSession: vi.fn().mockResolvedValue(null),
      getHeldRelays: vi.fn().mockResolvedValue([]),
      onStreamEvent: vi.fn(() => () => undefined),
      onQueueChanged: vi.fn(() => () => undefined),
    },
  };
});

afterEach(() => {
  mount.unmount();
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe('SceneStage', () => {
  it('draws each seated agent at its slot, in its state pose, from data alone', async () => {
    await render(props([agentFixture('a', 'working'), agentFixture('b', 'done')]));
    expect(el('orchestrator-test-yard').getAttribute('aria-label')).toBe('Test yard');
    expect(el('orchestrator-test-yard-frame').dataset.scene).toBe('test-yard');
    const desk = TEST_SCENE.map.zones.desk.slots[0];
    expect(sprite('a').style.left).toBe(`${desk.x}%`);
    expect(sprite('a').style.top).toBe(`${desk.y}%`);
    const sheets = TEST_SCENE.cast.sheets.map(sheet => sheet.sprites.busy);
    expect(sheets).toContain(sprite('a').querySelector('img')?.getAttribute('src'));
    expect(el('orchestrator-test-yard-summary').textContent).toBe('2 agents: 1 working, 1 done');
  });

  it('labels each sprite with its name and state, and marks the selected one pressed', async () => {
    const agents = [agentFixture('a', 'working'), agentFixture('b', 'needs-you')];
    const view = props(agents, { selectedId: 'b' });
    await render(view);
    const persona = view.personas.get('a');
    expect(sprite('a').getAttribute('aria-label')).toBe(`${persona?.label}: Agent a: Working`);
    expect(sprite('a').getAttribute('role')).toBe('button');
    expect(sprite('a').getAttribute('aria-pressed')).toBe('false');
    expect(sprite('b').getAttribute('aria-pressed')).toBe('true');
    expect(sprite('b').dataset.agentAvatar).toBe('b');
  });

  it('selects a sprite on click, Enter and Space, and ignores other keys', async () => {
    const view = props([agentFixture('a', 'working')]);
    await render(view);
    await act(async () => sprite('a').click());
    await press(sprite('a'), 'Enter');
    await press(sprite('a'), ' ');
    await press(sprite('a'), 'x');
    expect(view.onSelect).toHaveBeenCalledTimes(3);
    expect(view.onSelect).toHaveBeenCalledWith('a');
  });

  it('names each sprite on a plate lit in its state colour from the shared palette', async () => {
    const agents = [agentFixture('a', 'failed')];
    const view = props(agents);
    await render(view);
    const plate = el('orchestrator-test-yard-name-a');
    expect(plate.textContent).toBe(view.personas.get('a')?.label);
    expect(plate.style.getPropertyValue('--lamp')).toBe(stateLampColor('failed'));
    expect(el('orchestrator-test-yard-host-name').textContent).toBe('Warden');
  });

  it('shows the PR indicator for an agent with a PR, and opens it without selecting the agent', async () => {
    const onOpenPr = vi.fn();
    const view = props([agentFixture('a', 'working', { pr: { number: 12, state: 'open' } })], { onOpenPr });
    await render(view);
    const indicator = sprite('a').querySelector<HTMLElement>('[data-testid="orchestrator-pr-indicator"]');
    if (!indicator) throw new Error('no PR indicator');
    await act(async () => indicator.dispatchEvent(new MouseEvent('click', { bubbles: true, shiftKey: true })));
    expect(onOpenPr).toHaveBeenCalledWith('a');
    expect(view.onSelect).not.toHaveBeenCalled();
  });

  it('keeps a seated agent in its slot when an agent before it leaves', async () => {
    const a = agentFixture('a', 'working');
    const b = agentFixture('b', 'working');
    await render(props([a, b]));
    const before = sprite('b').style.left;
    await render(props([b]));
    expect(sprite('b').style.left).toBe(before);
  });

  it('stacks a full zone behind one button whose menu lists and selects every stacked agent', async () => {
    const agents = ['a', 'b', 'c', 'd', 'e'].map(id => agentFixture(id, 'working'));
    const view = props(agents);
    await render(view);
    expect(query('orchestrator-test-yard-agent-d')).toBeNull();
    const pile = el('orchestrator-test-yard-overflow-desk');
    expect(pile.textContent).toBe('+2');
    expect(pile.getAttribute('aria-label')).toBe('2 more at the desks; list them');
    await act(async () => pile.click());
    await act(async () => el('orchestrator-test-yard-overflow-item-e').click());
    expect(view.onSelect).toHaveBeenCalledWith('e');
  });

  it('keeps focus in the scene when a focused stack goes away', async () => {
    const agents = ['a', 'b', 'c', 'd'].map(id => agentFixture(id, 'working'));
    await render(props(agents));
    el('orchestrator-test-yard-overflow-desk').focus();
    await render(props(agents.slice(1)));
    expect(query('orchestrator-test-yard-overflow-desk')).toBeNull();
    expect(document.activeElement).toBe(el('orchestrator-test-yard'));
  });

  it('says how many in a stack need you', async () => {
    const agents = ['n1', 'n2', 'n3', 'n4', 'n5', 'n6', 'n7', 'n8', 'n9', 'n10'].map(id =>
      agentFixture(id, 'needs-you')
    );
    await render(props(agents));
    const pile = el('orchestrator-test-yard-overflow-porch');
    expect(pile.getAttribute('aria-label')).toBe('1 more on the porch, 1 needs you; list them');
    expect(pile.dataset.urgent).toBe('true');
  });

  it('opens the host conversation from the host, and keeps the host out of the tab order without one', async () => {
    const onInnkeeperSelect = vi.fn();
    await render(props([], { onInnkeeperSelect }));
    const host = el('orchestrator-test-yard-host') as HTMLButtonElement;
    expect(host.getAttribute('aria-label')).toBe('Warden: Watching the yard');
    await act(async () => host.click());
    expect(onInnkeeperSelect).toHaveBeenCalledTimes(1);
    await render(props([]));
    expect((el('orchestrator-test-yard-host') as HTMLButtonElement).disabled).toBe(true);
    expect(el('orchestrator-test-yard-host').tabIndex).toBe(-1);
  });

  it('cheers at the finale', async () => {
    await render(props([agentFixture('a', 'done')], { celebrating: true }));
    expect(el('orchestrator-test-yard-host').dataset.pose).toBe('cheering');
    expect(el('orchestrator-test-yard-host').querySelector('img')?.getAttribute('src')).toBe(
      TEST_SCENE.cast.host.sprites.cheering
    );
  });

  it('hangs agent details and the scene overlay inside the picture', async () => {
    await render(
      props([agentFixture('a', 'working')], {
        agentDetailsOverlay: <div data-testid="details" />,
        sceneOverlay: <div data-testid="overlay" />,
      })
    );
    expect(el('details').parentElement).toBe(el('orchestrator-test-yard'));
    expect(el('overlay').parentElement).toBe(el('orchestrator-test-yard'));
  });

  it('pauses every looping animation while the window is hidden', async () => {
    await render(props([agentFixture('a', 'working')]));
    expect(el('orchestrator-test-yard-frame').dataset.paused).toBeUndefined();
    await act(async () => {
      vi.spyOn(document, 'hidden', 'get').mockReturnValue(true);
      document.dispatchEvent(new Event('visibilitychange'));
    });
    expect(el('orchestrator-test-yard-frame').dataset.paused).toBe('hidden');
  });

  it('turns off walks and loops under reduced motion', async () => {
    await render(props([agentFixture('a', 'working')], { celebrating: true }));
    const css = [...document.querySelectorAll('style')].map(style => style.textContent).join('\n');
    expect(css).toMatch(/@media \(prefers-reduced-motion: reduce\)\s*\{[^}]*transition:\s*none/);
    expect(css).toMatch(/@media \(prefers-reduced-motion: reduce\)\s*\{[^}]*animation:\s*none/);
  });

  it('draws hundreds of agents with every seat used once and the rest stacked', async () => {
    const agents = Array.from({ length: 300 }, (_, index) => agentFixture(`a${index}`, 'working'));
    await render(props(agents));
    expect(document.querySelectorAll('[data-testid^="orchestrator-test-yard-agent-"]')).toHaveLength(3);
    expect(el('orchestrator-test-yard-overflow-desk').textContent).toBe('+297');
  });
});

// Every feature, on a scene that is only data: a definition can move and restyle these, never remove them.
describe('SceneStage features on any definition', () => {
  it("pins open work on the board, in the scene's own words and at its anchor", async () => {
    await render(props([agentFixture('a', 'working')]));
    const board = el('orchestrator-test-yard-quest-board');
    expect(board.getAttribute('aria-label')).toBe('Job board: 1 open job');
    expect(board.style.left).toBe(`${TEST_SCENE.map.board.left}%`);
    expect(board.textContent).toContain('Jobs');
    expect(query('orchestrator-test-yard-quest-a')).not.toBeNull();
  });

  it('gathers a zone of waiting agents under one answerable bubble', async () => {
    await render(props([agentFixture('n1', 'needs-you'), agentFixture('n2', 'needs-you')]));
    const bubble = el('orchestrator-test-yard-bubble-n1');
    expect(bubble.textContent).toContain('Needs you! \u00d72');
    expect(query('orchestrator-test-yard-bubble-n1-open')).not.toBeNull();
  });

  it('asks in the dialogue box instead of the bubbles when the stage hands it the requests', async () => {
    await render(props([agentFixture('n1', 'needs-you')], { inSceneDecisions: true }));
    expect(query('orchestrator-test-yard-bubble-n1-open')).toBeNull();
    expect(el('orchestrator-test-yard-bubble-n1').textContent).toBe('Needs you!');
  });

  it('keeps answers out of the bubbles where another card answers', async () => {
    mount.render(
      <SceneStage {...props([agentFixture('n1', 'needs-you')])} scene={TEST_SCENE} answerFromBubble={false} />
    );
    expect(query('orchestrator-test-yard-bubble-n1-open')).toBeNull();
  });

  it("greets from the host and hangs its reply at the definition's anchor while the conversation is hidden", async () => {
    const onReadReply = vi.fn();
    await render(
      props([], { desk: { reply: { id: 'r1', snippet: 'All done.' }, onReadReply, conversationHidden: true } })
    );
    const reply = el('orchestrator-test-yard-reply-bubble');
    expect(reply.textContent).toContain('All done.');
    await act(async () => el('orchestrator-test-yard-reply-read-btn').click());
    expect(onReadReply).toHaveBeenCalledWith('r1');
    expect(query('orchestrator-test-yard-reply-bubble')).toBeNull();
    expect(el('orchestrator-test-yard-host-greeting').textContent).toBe('Anything for me?');
  });

  it('walks the host over to an agent the parent is reading, and cuts it behind the scene furniture at rest', async () => {
    await render(props([agentFixture('a', 'working')]));
    // Feet 4% below the counter top on a 15%-tall sprite.
    expect(el('orchestrator-test-yard-host-art').style.clipPath).toBe('inset(0 0 26.666666666666668% 0)');
    const parent = {
      status: 'processing' as const,
      activity: { kind: 'tool' as const, tool: 'session_read', detail: '', target: 'a' },
    };
    await render(props([agentFixture('a', 'working')], { parent }));
    const host = el('orchestrator-test-yard-host');
    expect(host.dataset.pose).toBe('walking');
    expect(host.style.left).not.toBe(`${TEST_SCENE.map.host.x}%`);
  });

  it('lights the room by theme and dims it to last call once settled', async () => {
    await render(props([agentFixture('a', 'working')]));
    expect(el('orchestrator-test-yard-light').dataset.mood).toBe('night');
    await render(props([agentFixture('a', 'working')], { settled: true }));
    expect(el('orchestrator-test-yard-light').dataset.mood).toBe('last-call');
    expect(el('orchestrator-test-yard-frame').dataset.settled).toBe('true');
  });

  it('walks everyone in from the door during the intro', async () => {
    await render(props([agentFixture('a', 'working')], { introPlaying: true }));
    expect(sprite('a').style.left).toBe(`${TEST_SCENE.map.door.x}%`);
  });

  it('cheers every agent at the finale', async () => {
    await render(props([agentFixture('a', 'working')], { celebrating: true }));
    expect(sprite('a').dataset.cheering).toBe('true');
  });

  it('speaks arrivals that need attention in its live region', async () => {
    vi.useFakeTimers();
    const view = props([agentFixture('a', 'working')]);
    await render(view);
    await render({ ...view, agents: [agentFixture('a', 'needs-you')] });
    await act(async () => vi.advanceTimersByTime(ANNOUNCE_DEBOUNCE_MS));
    expect(el('orchestrator-test-yard-announcer').textContent).toBe(`${view.personas.get('a')?.label} needs you.`);
  });
});

// Optional definition fields that only some scenes set.
describe('SceneStage definition options', () => {
  const OPTIONED = {
    ...TEST_SCENE,
    map: { ...TEST_SCENE.map, lights: [{ x: 20, y: 5, size: 10, kind: 'lamp' as const }] },
    cast: {
      ...TEST_SCENE.cast,
      roam: { poses: ['busy'], reach: 6 },
      sheets: TEST_SCENE.cast.sheets.map(sheet => ({ ...sheet, hue: 90 })),
    },
    ambience: { ...TEST_SCENE.ambience, veil: 'rgba(0, 0, 0, 0.25)', awakeUnfocused: true },
  };
  const renderOptioned = (view: OrchestratorViewProps) => mount.render(<SceneStage {...view} scene={OPTIONED} />);

  it('swims a roaming pose across its seat and leaves other poses still', async () => {
    await renderOptioned(props([agentFixture('w', 'working'), agentFixture('d', 'done')]));
    expect(sprite('w').style.getPropertyValue('--roam-reach')).toBe('6cqw');
    expect(sprite('d').style.getPropertyValue('--roam-reach')).toBe('');
  });

  it("tints the art by its sheet's hue", async () => {
    await renderOptioned(props([agentFixture('w', 'working')]));
    expect(getComputedStyle(sprite('w').querySelector('img') as HTMLElement).filter).toContain('hue-rotate(90deg)');
  });

  it('veils the backdrop and draws a lamp', async () => {
    await renderOptioned(props([agentFixture('w', 'working')]));
    expect(query('orchestrator-test-yard-veil')).not.toBeNull();
    expect(el('orchestrator-test-yard-light').querySelector('[data-light-glow="lamp"]')).not.toBeNull();
    await render(props([agentFixture('w', 'working')]));
    expect(query('orchestrator-test-yard-veil')).toBeNull();
  });

  it('holds a lamp steady, white unless its tone says blue', async () => {
    const lampGlow = () => {
      const glow = el('orchestrator-test-yard-light').querySelector('[data-light-glow="lamp"]') as HTMLElement;
      return getComputedStyle(glow);
    };
    await renderOptioned(props([agentFixture('w', 'working')]));
    expect(lampGlow().backgroundImage).toContain('rgba(225, 240, 255');
    expect(lampGlow().animation).toBe('none');
    const blue = {
      ...OPTIONED,
      map: { ...OPTIONED.map, lights: [{ ...OPTIONED.map.lights[0], tone: 'blue' as const }] },
    };
    await mount.render(<SceneStage {...props([agentFixture('w', 'working')])} scene={blue} />);
    expect(lampGlow().backgroundImage).toContain('rgba(200, 238, 255');
    expect(lampGlow().animation).toBe('none');
  });

  it('stays awake while unfocused when the definition asks, and pauses otherwise', async () => {
    vi.useFakeTimers();
    const blurLong = () =>
      act(async () => {
        window.dispatchEvent(new Event('blur'));
        vi.advanceTimersByTime(UNFOCUSED_PAUSE_MS + 1);
      });
    await renderOptioned(props([agentFixture('w', 'working')]));
    await blurLong();
    expect(el('orchestrator-test-yard-frame').dataset.paused).toBeUndefined();
    mount.unmount();
    await render(props([agentFixture('w', 'working')]));
    await blurLong();
    expect(el('orchestrator-test-yard-frame').dataset.paused).toBe('unfocused');
  });
});

describe('sceneView', () => {
  it('turns a definition into a view the stage can mount', async () => {
    const View = sceneView(TEST_SCENE);
    expect(View.displayName).toBe('SceneView(test-yard)');
    await mount.render(<View {...props([agentFixture('a', 'working')])} />);
    expect(sprite('a')).toBeTruthy();
  });
});
