// @vitest-environment jsdom
import { act } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AgentView } from '../roster';
import { agentFixture, createThemedMount, el, query } from '../testUtils';
import { DOOR_POINT, TAVERN_SLOTS } from './scene';
import { TavernView } from './TavernView';

const onSelect = vi.fn();
const themed = createThemedMount();

const renderTavern = (agents: AgentView[], introPlaying = false, selectedId: string | null = null) =>
  themed.render(<TavernView agents={agents} onSelect={onSelect} selectedId={selectedId} introPlaying={introPlaying} />);

const setReducedMotion = (matches: boolean) =>
  vi.spyOn(window, 'matchMedia').mockImplementation(media => ({
    matches,
    media,
    onchange: null,
    addListener: () => {},
    removeListener: () => {},
    addEventListener: () => {},
    removeEventListener: () => {},
    dispatchEvent: () => false,
  }));

const nextFrames = () => act(() => new Promise<void>(resolve => setTimeout(resolve, 100)));

const sprites = () => [
  ...el('orchestrator-tavern').querySelectorAll('button[data-testid^="orchestrator-tavern-agent-"]'),
];

afterEach(() => {
  themed.unmount();
  vi.clearAllMocks();
  vi.restoreAllMocks();
});

describe('TavernView', () => {
  it('renders one button per agent labelled with its title and state', async () => {
    await renderTavern([
      agentFixture('a', 'working'),
      agentFixture('b', 'needs-you'),
      agentFixture('c', 'done'),
      agentFixture('d', 'failed'),
    ]);
    expect(sprites()).toHaveLength(4);
    expect(el('orchestrator-tavern-agent-a').getAttribute('aria-label')).toBe('Agent a: Working');
    expect(el('orchestrator-tavern-agent-b').getAttribute('aria-label')).toBe('Agent b: Needs you');
    expect(el('orchestrator-tavern-agent-c').getAttribute('aria-label')).toBe('Agent c: Done');
    expect(el('orchestrator-tavern-agent-d').getAttribute('aria-label')).toBe('Agent d: Failed');
  });

  it("shows 'Needs you!' in a needs-you agent's bubble", async () => {
    await renderTavern([agentFixture('b', 'needs-you')]);
    expect(el('orchestrator-tavern-bubble-b').textContent).toBe('Needs you!');
  });

  it('shows the live activity, truncated, in a working agent bubble', async () => {
    await renderTavern([
      agentFixture('a', 'working', {
        activity: { kind: 'tool', tool: 'bash', detail: 'pnpm --filter @bike4mind/desktop test' },
      }),
    ]);
    const text = el('orchestrator-tavern-bubble-a').textContent ?? '';
    expect(text).toHaveLength(28);
    expect(text.startsWith('bash pnpm --filter')).toBe(true);
    expect(text.endsWith('\u2026')).toBe(true);
  });

  it('truncates the name plate to 18 characters', async () => {
    await renderTavern([agentFixture('a', 'done', { title: 'A very long agent title indeed' })]);
    expect(el('orchestrator-tavern-agent-a').textContent).toContain('A very long agent\u2026');
  });

  it('queues agents past the workbenches at the door with a +N badge', async () => {
    await renderTavern(Array.from({ length: 8 }, (_, index) => agentFixture(`w${index}`, 'working')));
    expect(sprites()).toHaveLength(7);
    expect(query('orchestrator-tavern-agent-w6')).not.toBeNull();
    expect(query('orchestrator-tavern-agent-w7')).toBeNull();
    expect(el('orchestrator-tavern-door-overflow').textContent).toBe('+1');
  });

  it('shows no overflow badge when everyone has a seat', async () => {
    await renderTavern([agentFixture('a', 'working')]);
    expect(query('orchestrator-tavern-door-overflow')).toBeNull();
  });

  it('calls onSelect when a sprite is clicked', async () => {
    await renderTavern([agentFixture('a', 'working')]);
    await act(async () => el('orchestrator-tavern-agent-a').click());
    expect(onSelect).toHaveBeenCalledWith('a');
  });

  it('starts sprites at the door during the intro', async () => {
    await renderTavern([agentFixture('a', 'done')], true);
    const sprite = el('orchestrator-tavern-agent-a');
    expect(sprite.style.left).toBe(`${DOOR_POINT.x}%`);
    expect(sprite.style.top).toBe(`${DOOR_POINT.y}%`);
  });

  describe('door queue', () => {
    const nine = Array.from({ length: 9 }, (_, index) => agentFixture(`w${index}`, 'working'));
    const badge = () => el('orchestrator-tavern-door-overflow');

    it('is a button that selects queued agents in turn and wraps', async () => {
      await renderTavern(nine);
      expect(badge().tagName).toBe('BUTTON');
      expect(badge().textContent).toBe('+2');
      expect(badge().getAttribute('aria-label')).toBe('2 more waiting at the door; select next');

      const clickFrom = async (selectedId: string | null) => {
        await renderTavern(nine, false, selectedId);
        onSelect.mockClear();
        await act(async () => badge().click());
        return onSelect.mock.calls[0]?.[0];
      };
      expect(await clickFrom(null)).toBe('w6');
      expect(await clickFrom('w6')).toBe('w7');
      expect(await clickFrom('w7')).toBe('w8');
      expect(await clickFrom('w8')).toBe('w6');
      expect(await clickFrom('w0')).toBe('w6');
    });

    const needing = (count: number) =>
      Array.from({ length: count }, (_, index) => agentFixture(`n${index}`, 'needs-you'));
    const working = (count: number) =>
      Array.from({ length: count }, (_, index) => agentFixture(`w${index}`, 'working'));

    it('puts a fifth needs-you agent at the door with its bubble', async () => {
      await renderTavern(needing(5));
      expect(el('orchestrator-tavern-bubble-n4').textContent).toBe('Needs you!');
      expect(el('orchestrator-tavern-agent-n4').style.left).toBe(`${DOOR_POINT.x}%`);
      expect(query('orchestrator-tavern-door-overflow')).toBeNull();
    });

    it('prefers a needs-you agent over earlier queued ones at the door', async () => {
      await renderTavern([...working(8), ...needing(5)]);
      expect(query('orchestrator-tavern-agent-n4')).not.toBeNull();
      expect(query('orchestrator-tavern-agent-w6')).toBeNull();
      expect(badge().textContent).toBe('+2');
      expect(badge().getAttribute('aria-label')).toBe('2 more waiting at the door; select next');
    });

    it('marks the badge urgent while a needs-you agent is hidden in the queue', async () => {
      await renderTavern([...working(7), ...needing(6)]);
      expect(query('orchestrator-tavern-agent-n4')).not.toBeNull();
      expect(badge().textContent).toBe('!+2');
      expect(badge().getAttribute('aria-label')).toBe('2 more waiting at the door, 1 needs you; select next');
      onSelect.mockClear();
      await act(async () => badge().click());
      expect(onSelect).toHaveBeenCalledWith('n4');
    });

    it('shows the selected queued agent at the door instead of the first', async () => {
      await renderTavern(nine, false, 'w7');
      expect(query('orchestrator-tavern-agent-w7')).not.toBeNull();
      expect(query('orchestrator-tavern-agent-w6')).toBeNull();
      expect(query('orchestrator-tavern-agent-w8')).toBeNull();
      expect(badge().textContent).toBe('+2');
    });
  });

  describe('a newcomer after arrival', () => {
    it('walks in from the door to its seat', async () => {
      await renderTavern([agentFixture('a', 'working')]);
      await renderTavern([agentFixture('a', 'working'), agentFixture('b', 'done')]);
      expect(el('orchestrator-tavern-agent-b').style.left).toBe(`${DOOR_POINT.x}%`);
      await nextFrames();
      expect(el('orchestrator-tavern-agent-b').style.left).toBe(`${TAVERN_SLOTS.hearth[0].x}%`);
      expect(el('orchestrator-tavern-agent-a').style.left).toBe(`${TAVERN_SLOTS.workbench[0].x}%`);
    });

    it('appears at its seat directly under reduced motion', async () => {
      setReducedMotion(true);
      await renderTavern([agentFixture('a', 'working')]);
      await renderTavern([agentFixture('a', 'working'), agentFixture('b', 'done')]);
      expect(el('orchestrator-tavern-agent-b').style.left).toBe(`${TAVERN_SLOTS.hearth[0].x}%`);
    });
  });
});
