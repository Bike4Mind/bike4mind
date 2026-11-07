// @vitest-environment jsdom
import { act } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { OrchestratorViewProps } from '../OrchestratorStage';
import type { AgentView } from '../roster';
import { agentFixture, createThemedMount, el, query } from '../testUtils';
import { assignPersonas } from '@shared/agentPersona';
import { BAR_COUNTER, DOOR_POINT, INNKEEPER_POINT, TAVERN_SLOTS, hiddenByCounter } from './scene';
import { TavernView } from './TavernView';

type SceneModule = typeof import('./scene');
// Lets one test squeeze a label below the minimum, which no real seat pair does.
const labelLayoutOverride = vi.hoisted(() => ({ current: null as SceneModule['nameLabelLayout'] | null }));
vi.mock('./scene', async importOriginal => {
  const actual = await importOriginal<SceneModule>();
  return {
    ...actual,
    nameLabelLayout: (points: Parameters<SceneModule['nameLabelLayout']>[0]) =>
      (labelLayoutOverride.current ?? actual.nameLabelLayout)(points),
  };
});

const onSelect = vi.fn();
const themed = createThemedMount();

const renderTavern = (
  agents: AgentView[],
  introPlaying = false,
  selectedId: string | null = null,
  extra: Partial<OrchestratorViewProps> = {}
) =>
  themed.render(
    <TavernView
      agents={agents}
      onSelect={onSelect}
      selectedId={selectedId}
      introPlaying={introPlaying}
      personas={assignPersonas(agents)}
      {...extra}
    />
  );

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
  it('names the spawning agent by its persona in the tooltip and aria-label, not on the plate', async () => {
    const agents = [
      agentFixture('lead', 'working', { title: 'Lead the audit' }),
      agentFixture('helper', 'working', { title: 'Check the helpers', depth: 2, parentId: 'lead' }),
    ];
    await renderTavern(agents);
    const personas = assignPersonas(agents);
    const lead = personas.get('lead')?.label ?? '';
    const helper = personas.get('helper')?.label ?? '';
    expect(el('orchestrator-tavern-agent-helper').getAttribute('title')).toBe(
      `${helper}: ${personas.get('helper')?.shortTitle} \u00B7 via ${lead}`
    );
    expect(el('orchestrator-tavern-agent-helper').getAttribute('aria-label')).toBe(
      `${helper}: Check the helpers \u00B7 via ${lead}: Working`
    );
    expect(el('orchestrator-tavern-name-helper').textContent).toBe(helper);
    expect(el('orchestrator-tavern-agent-lead').getAttribute('title')).not.toContain('via');
  });

  it('shows the persona on the plate and keeps the full title in the aria-label and tooltip', async () => {
    const agent = agentFixture('a', 'working', { title: 'Review the auth middleware' });
    await renderTavern([agent]);
    const label = assignPersonas([agent]).get('a')?.label ?? '';
    expect(label).toMatch(/ the Warden$/);
    expect(el('orchestrator-tavern-name-a').textContent).toBe(label);
    expect(el('orchestrator-tavern-agent-a').getAttribute('aria-label')).toBe(
      `${label}: Review the auth middleware: Working`
    );
    expect(el('orchestrator-tavern-agent-a').getAttribute('title')).toBe(`${label}: Review the auth middleware`);
  });

  it('uses the part of the title that differs from its siblings in the tooltip only', async () => {
    const agents = [
      agentFixture('a', 'working', { title: 'Desktop audit: unused files' }),
      agentFixture('b', 'working', { title: 'Desktop audit: large files' }),
    ];
    await renderTavern(agents);
    const label = assignPersonas(agents).get('a')?.label ?? '';
    expect(el('orchestrator-tavern-agent-a').getAttribute('title')).toBe(`${label}: unused files`);
    expect(el('orchestrator-tavern-agent-a').getAttribute('aria-label')).toBe(
      `${label}: Desktop audit: unused files: Working`
    );
  });

  it('renders one button per agent labelled with its title and state', async () => {
    await renderTavern([
      agentFixture('a', 'working'),
      agentFixture('b', 'needs-you'),
      agentFixture('c', 'done'),
      agentFixture('d', 'failed'),
    ]);
    expect(sprites()).toHaveLength(4);
    expect(el('orchestrator-tavern-agent-a').getAttribute('aria-label')).toContain('Agent a: Working');
    expect(el('orchestrator-tavern-agent-b').getAttribute('aria-label')).toContain('Agent b: Needs you');
    expect(el('orchestrator-tavern-agent-c').getAttribute('aria-label')).toContain('Agent c: Done');
    expect(el('orchestrator-tavern-agent-d').getAttribute('aria-label')).toContain('Agent d: Failed');
  });

  it('staggers crowded name labels and caps them through a CSS variable, keeping the full title', async () => {
    const title = 'Seeded demo agent with a long name';
    await renderTavern([agentFixture('a', 'needs-you', { title }), agentFixture('b', 'needs-you', { title })]);
    const gap = TAVERN_SLOTS.bar[1].x - TAVERN_SLOTS.bar[0].x;
    const lanes = ['a', 'b'].map(id => el(`orchestrator-tavern-name-${id}`).getAttribute('data-lane'));
    expect(lanes).toEqual(['0', '1']);
    for (const id of ['a', 'b']) {
      const cap = el(`orchestrator-tavern-name-${id}`).style.getPropertyValue('--label-max');
      expect(cap.endsWith('cqw')).toBe(true);
      expect(Number.parseFloat(cap)).toBeGreaterThan(gap);
      expect(el(`orchestrator-tavern-agent-${id}`).getAttribute('title')).toContain(title);
    }
  });

  it('lifts the cap on the selected agent label', async () => {
    await renderTavern([agentFixture('a', 'needs-you'), agentFixture('b', 'needs-you')], false, 'a');
    expect(getComputedStyle(el('orchestrator-tavern-name-a')).maxWidth).toBe('none');
    expect(getComputedStyle(el('orchestrator-tavern-name-b')).maxWidth).not.toBe('none');
  });

  it('draws no label when its cap is below the minimum, but shows it once selected', async () => {
    labelLayoutOverride.current = points =>
      new Map([...points.keys()].map(id => [id, { lane: 0, maxWidth: id === 'a' ? 2 : 10, shown: id !== 'a' }]));
    try {
      await renderTavern([agentFixture('a', 'needs-you'), agentFixture('b', 'needs-you')]);
      expect(getComputedStyle(el('orchestrator-tavern-name-a')).display).toBe('none');
      expect(getComputedStyle(el('orchestrator-tavern-name-b')).display).not.toBe('none');
      await renderTavern([agentFixture('a', 'needs-you'), agentFixture('b', 'needs-you')], false, 'a');
      expect(getComputedStyle(el('orchestrator-tavern-name-a')).display).not.toBe('none');
    } finally {
      labelLayoutOverride.current = null;
    }
  });

  it("shows 'Needs you!' in a needs-you agent's bubble", async () => {
    await renderTavern([agentFixture('b', 'needs-you')]);
    expect(el('orchestrator-tavern-bubble-b').textContent).toBe('Needs you!');
  });

  it("shows a preparing agent's setup step in its bubble", async () => {
    await renderTavern([agentFixture('a', 'working', { preparing: 'worktree' })]);
    expect(el('orchestrator-tavern-bubble-a').textContent).toBe('Creating worktree\u2026');
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

  describe('the Innkeeper', () => {
    const innkeeper = () => el('orchestrator-tavern-innkeeper');
    const sessionRead = (target: string): OrchestratorViewProps['parent'] => ({
      status: 'processing',
      activity: { kind: 'tool', tool: 'session_read', detail: '', target },
    });

    it('stands behind the bar polishing, labelled, while the parent is not processing', async () => {
      await renderTavern([agentFixture('a', 'working')], false, null, { parent: { status: 'done' } });
      expect(innkeeper().style.left).toBe(`${INNKEEPER_POINT.x}%`);
      expect(innkeeper().style.top).toBe(`${INNKEEPER_POINT.y}%`);
      expect(innkeeper().getAttribute('data-pose')).toBe('idle');
      expect(el('orchestrator-tavern-innkeeper-name').textContent).toBe('Innkeeper');
      expect(query('orchestrator-tavern-innkeeper-bubble')).toBeNull();
      expect(sprites()).toHaveLength(1);
    });

    it('is cut off at the counter top behind the bar, with no shadow on floor it does not stand on', async () => {
      await renderTavern([], false, null, { parent: { status: 'done' } });
      expect(innkeeper().hasAttribute('data-behind-counter')).toBe(true);
      expect(el('orchestrator-tavern-innkeeper-art').style.clipPath).toMatch(
        /^inset\(0(px)? 0(px)? [1-9][\d.]*% 0(px)?\)$/
      );
      const shadow = innkeeper().querySelector<HTMLElement>('[data-contact-shadow]');
      expect(shadow).not.toBeNull();
      expect(getComputedStyle(shadow!).opacity).toBe('0');
    });

    it('takes the pointer on its visible art only, so the counter hiding his legs is not clickable', async () => {
      const onInnkeeperSelect = vi.fn();
      await renderTavern([], false, null, { parent: { status: 'done' }, onInnkeeperSelect });
      expect(getComputedStyle(innkeeper()).pointerEvents).toBe('none');
      const art = el('orchestrator-tavern-innkeeper-art');
      expect(getComputedStyle(art).pointerEvents).toBe('auto');
      expect(getComputedStyle(art).cursor).toBe('pointer');
      act(() => art.click());
      expect(onInnkeeperSelect).toHaveBeenCalledTimes(1);
    });

    it('gives every agent a contact shadow under its feet', async () => {
      await renderTavern([agentFixture('a', 'working'), agentFixture('b', 'done')]);
      for (const sprite of sprites()) expect(sprite.querySelector('[data-contact-shadow]')).not.toBeNull();
    });

    it("writes while posting quests, with the parent's activity in a bubble", async () => {
      await renderTavern([], false, null, {
        parent: { status: 'processing', activity: { kind: 'tool', tool: 'session_spawn', detail: '' } },
      });
      expect(innkeeper().getAttribute('data-pose')).toBe('writing');
      expect(el('orchestrator-tavern-innkeeper-bubble').textContent).toBe('session_spawn');
    });

    it('reads once every agent has settled while the parent is still processing', async () => {
      await renderTavern([agentFixture('a', 'done')], false, null, {
        parent: { status: 'processing', activity: { kind: 'phase', phase: 'thinking' } },
      });
      expect(innkeeper().getAttribute('data-pose')).toBe('reading');
    });

    it('walks over to the agent it reads, and back once the read is over', async () => {
      vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
      try {
        const agents = [agentFixture('a', 'working'), agentFixture('b', 'done')];
        await renderTavern(agents, false, null, { parent: sessionRead('b') });
        await renderTavern(agents, false, null, { parent: sessionRead('b') });
        expect(innkeeper().getAttribute('data-pose')).toBe('walking');
        const hearth = TAVERN_SLOTS.hearth[0];
        expect(Math.abs(parseFloat(innkeeper().style.left) - hearth.x)).toBeLessThanOrEqual(6);
        expect(innkeeper().style.top).toBe(`${hearth.y}%`);
        // Out on the floor: whole, and grounded by its shadow.
        expect(innkeeper().hasAttribute('data-behind-counter')).toBe(false);
        expect(el('orchestrator-tavern-innkeeper-art').style.clipPath).toMatch(
          /^inset\(0(px)?( 0(px)?)*\)$|^inset\(0(px)? 0(px)? 0% 0(px)?\)$/
        );

        // The read returns at once; the walk still finishes before heading back.
        await renderTavern(agents, false, null, { parent: { status: 'processing' } });
        expect(innkeeper().style.top).toBe(`${hearth.y}%`);
        await act(async () => {
          vi.advanceTimersByTime(5000);
        });
        expect(innkeeper().style.left).toBe(`${INNKEEPER_POINT.x}%`);
        expect(innkeeper().style.top).toBe(`${INNKEEPER_POINT.y}%`);
      } finally {
        vi.useRealTimers();
      }
    });

    it('clips him by where he is mid-walk, not by where he is headed', async () => {
      const agents = [agentFixture('a', 'working'), agentFixture('b', 'done')];
      await renderTavern(agents, false, null, { parent: { status: 'processing' } });
      const frames: FrameRequestCallback[] = [];
      vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => frames.push(callback));
      vi.stubGlobal('cancelAnimationFrame', () => {});
      const SCENE = { left: 0, top: 0, width: 1000, height: 500 };
      const box = (rect: { left: number; top: number; width: number; height: number }) =>
        ({
          ...rect,
          right: rect.left + rect.width,
          bottom: rect.top + rect.height,
          x: rect.left,
          y: rect.top,
        }) as DOMRect;
      let feet = { x: 60, y: BAR_COUNTER.front - 3 };
      vi.spyOn(Element.prototype, 'getBoundingClientRect').mockImplementation(function (this: Element) {
        if (this === el('orchestrator-tavern')) return box(SCENE);
        const width = 75;
        const height = 75;
        return box({
          left: (feet.x / 100) * SCENE.width - width / 2,
          top: (feet.y / 100) * SCENE.height - height,
          width,
          height,
        });
      });

      await renderTavern(agents, false, null, { parent: sessionRead('b') });
      const art = () => el('orchestrator-tavern-innkeeper-art');
      const behind = hiddenByCounter(feet, 15);
      expect(behind).toBeGreaterThan(0);
      expect(art().style.clipPath).toBe(`inset(0 0 ${behind}% 0)`);

      feet = { x: 60, y: BAR_COUNTER.front + 5 };
      act(() => frames.splice(0).forEach(frame => frame(0)));
      act(() => frames.splice(0).forEach(frame => frame(600)));
      expect(art().style.clipPath).toMatch(/^inset\(0(px)?( 0(px)?)*\)$|^inset\(0(px)? 0(px)? 0% 0(px)?\)$/);

      act(() => frames.splice(0).forEach(frame => frame(1300)));
      expect(hiddenByCounter(TAVERN_SLOTS.hearth[0], 15)).toBe(0);
      expect(art().style.clipPath).toBe('inset(0 0 0% 0)');
    });

    it('heads back to the bar, not the door, when the agent it is visiting is archived mid-visit', async () => {
      vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
      try {
        const agents = [agentFixture('a', 'working'), agentFixture('b', 'done')];
        await renderTavern(agents, false, null, { parent: sessionRead('b') });
        await renderTavern(agents, false, null, { parent: sessionRead('b') });
        expect(innkeeper().getAttribute('data-pose')).toBe('walking');

        // Still inside the held visit, but b has left the roster.
        await renderTavern([agents[0]], false, null, { parent: { status: 'processing' } });
        expect(innkeeper().style.left).toBe(`${INNKEEPER_POINT.x}%`);
        expect(innkeeper().style.top).toBe(`${INNKEEPER_POINT.y}%`);
        expect(innkeeper().getAttribute('data-pose')).not.toBe('walking');
      } finally {
        vi.useRealTimers();
      }
    });

    it('stays behind the bar under reduced motion and highlights the agent instead', async () => {
      setReducedMotion(true);
      const agents = [agentFixture('a', 'working'), agentFixture('b', 'done')];
      await renderTavern(agents, false, null, { parent: sessionRead('b') });
      await renderTavern(agents, false, null, { parent: sessionRead('b') });
      expect(innkeeper().style.left).toBe(`${INNKEEPER_POINT.x}%`);
      expect(el('orchestrator-tavern-agent-b').getAttribute('data-innkeeper-visit')).toBe('true');
      expect(el('orchestrator-tavern-agent-a').getAttribute('data-innkeeper-visit')).toBeNull();
    });

    it('is not interactive when nothing handles its selection', async () => {
      await renderTavern([agentFixture('a', 'working')]);
      const button = innkeeper() as HTMLButtonElement;
      expect(button.disabled).toBe(true);
      expect(button.tabIndex).toBe(-1);
    });

    it('calls onInnkeeperSelect when clicked, never onSelect', async () => {
      const onInnkeeperSelect = vi.fn();
      await renderTavern([agentFixture('a', 'working')], false, null, { onInnkeeperSelect });
      await act(async () => innkeeper().click());
      expect(onInnkeeperSelect).toHaveBeenCalledTimes(1);
      expect(onSelect).not.toHaveBeenCalled();
    });
  });

  describe('celebrating', () => {
    it('raises every agent and has the Innkeeper cheer', async () => {
      await renderTavern([agentFixture('a', 'done'), agentFixture('b', 'failed')], false, null, { celebrating: true });
      expect(el('orchestrator-tavern-agent-a').getAttribute('data-cheering')).toBe('true');
      expect(el('orchestrator-tavern-agent-b').getAttribute('data-cheering')).toBe('true');
      expect(el('orchestrator-tavern-innkeeper').getAttribute('data-pose')).toBe('cheering');
    });

    it('does nothing of the sort otherwise', async () => {
      await renderTavern([agentFixture('a', 'done')]);
      expect(el('orchestrator-tavern-agent-a').getAttribute('data-cheering')).toBeNull();
      expect(el('orchestrator-tavern-innkeeper').getAttribute('data-pose')).toBe('idle');
    });
  });
});
