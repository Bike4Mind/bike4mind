// @vitest-environment jsdom
import { act } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AgentView } from '../roster';
import { agentFixture, createThemedMount, el, query } from '../testUtils';
import { DOOR_POINT } from './scene';
import { TavernView } from './TavernView';

const onSelect = vi.fn();
const themed = createThemedMount();

const renderTavern = (agents: AgentView[], introPlaying = false) =>
  themed.render(<TavernView agents={agents} onSelect={onSelect} selectedId={null} introPlaying={introPlaying} />);

const sprites = () => [...el('orchestrator-tavern').querySelectorAll('button')];

afterEach(() => {
  themed.unmount();
  vi.clearAllMocks();
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
});
