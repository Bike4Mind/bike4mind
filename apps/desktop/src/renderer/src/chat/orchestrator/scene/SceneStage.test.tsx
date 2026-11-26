// @vitest-environment jsdom
import { act } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { assignPersonas } from '@shared/agentPersona';
import type { OrchestratorViewProps } from '../OrchestratorStage';
import type { AgentView } from '../roster';
import { stateLampColor } from '../statePalette';
import { agentFixture, createThemedMount, el, query } from '../testUtils';
import { SceneStage, sceneView } from './SceneStage';
import { TEST_SCENE } from './testScene';

const mount = createThemedMount('dark');
const sprite = (id: string) => el(`scene-stage-agent-${id}`);

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

afterEach(() => {
  mount.unmount();
  vi.restoreAllMocks();
});

describe('SceneStage', () => {
  it('draws each seated agent at its slot, in its state pose, from data alone', async () => {
    await render(props([agentFixture('a', 'working'), agentFixture('b', 'done')]));
    expect(el('scene-stage').getAttribute('aria-label')).toBe('Test yard');
    expect(el('scene-stage-frame').dataset.scene).toBe('test-yard');
    const desk = TEST_SCENE.map.zones.desk.slots[0];
    expect(sprite('a').style.left).toBe(`${desk.x}%`);
    expect(sprite('a').style.top).toBe(`${desk.y}%`);
    const sheets = TEST_SCENE.cast.sheets.map(sheet => sheet.sprites.busy);
    expect(sheets).toContain(sprite('a').querySelector('img')?.getAttribute('src'));
    expect(el('scene-stage-summary').textContent).toBe('2 agents: 1 working, 1 done');
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

  it('colours each sprite lamp from the shared state palette', async () => {
    await render(props([agentFixture('a', 'failed')]));
    const lamp = sprite('a').querySelector<HTMLElement>('[data-scene-lamp]');
    expect(lamp?.style.getPropertyValue('--lamp')).toBe(stateLampColor('failed'));
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
    expect(query('scene-stage-agent-d')).toBeNull();
    const pile = el('scene-stage-overflow-desk');
    expect(pile.textContent).toBe('+2');
    expect(pile.getAttribute('aria-label')).toBe('2 more at the desks; list them');
    await act(async () => pile.click());
    await act(async () => el('scene-stage-overflow-item-e').click());
    expect(view.onSelect).toHaveBeenCalledWith('e');
  });

  it('keeps focus in the scene when a focused stack goes away', async () => {
    const agents = ['a', 'b', 'c', 'd'].map(id => agentFixture(id, 'working'));
    await render(props(agents));
    el('scene-stage-overflow-desk').focus();
    await render(props(agents.slice(1)));
    expect(query('scene-stage-overflow-desk')).toBeNull();
    expect(document.activeElement).toBe(el('scene-stage'));
  });

  it('says how many in a stack need you', async () => {
    const agents = ['n1', 'n2', 'n3', 'n4', 'n5', 'n6', 'n7', 'n8', 'n9', 'n10'].map(id =>
      agentFixture(id, 'needs-you')
    );
    await render(props(agents));
    const pile = el('scene-stage-overflow-porch');
    expect(pile.getAttribute('aria-label')).toBe('1 more on the porch, 1 needs you; list them');
    expect(pile.dataset.urgent).toBe('true');
  });

  it('opens the host conversation from the host, and keeps the host out of the tab order without one', async () => {
    const onInnkeeperSelect = vi.fn();
    await render(props([], { onInnkeeperSelect }));
    const host = el('scene-stage-host') as HTMLButtonElement;
    expect(host.getAttribute('aria-label')).toBe('Warden');
    await act(async () => host.click());
    expect(onInnkeeperSelect).toHaveBeenCalledTimes(1);
    await render(props([]));
    expect((el('scene-stage-host') as HTMLButtonElement).disabled).toBe(true);
    expect(el('scene-stage-host').tabIndex).toBe(-1);
  });

  it('cheers at the finale', async () => {
    await render(props([agentFixture('a', 'done')], { celebrating: true }));
    expect(el('scene-stage-host').dataset.pose).toBe('cheering');
    expect(el('scene-stage-host').querySelector('img')?.getAttribute('src')).toBe(
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
    expect(el('details').parentElement).toBe(el('scene-stage'));
    expect(el('overlay').parentElement).toBe(el('scene-stage'));
  });

  it('pauses every looping animation while the window is hidden', async () => {
    await render(props([agentFixture('a', 'working')]));
    expect(el('scene-stage-frame').dataset.paused).toBeUndefined();
    await act(async () => {
      vi.spyOn(document, 'hidden', 'get').mockReturnValue(true);
      document.dispatchEvent(new Event('visibilitychange'));
    });
    expect(el('scene-stage-frame').dataset.paused).toBe('hidden');
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
    expect(document.querySelectorAll('[data-testid^="scene-stage-agent-"]')).toHaveLength(3);
    expect(el('scene-stage-overflow-desk').textContent).toBe('+297');
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
