// @vitest-environment jsdom
import { act } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { assignPersonas } from '@shared/agentPersona';
import type { AgentView } from '../roster';
import { agentFixture, createThemedMount, el, query } from '../testUtils';
import { QUEST_DONE_LINGER_MS } from './quests';
import type { ComponentProps } from 'react';
import { SceneStage } from './SceneStage';
import { TAVERN_SCENE } from '../tavern/tavernScene';
import { chatBackedHostBridge } from '../../../__fixtures__/chatBackedHostBridge';

const TavernView = (props: Omit<ComponentProps<typeof SceneStage>, 'scene'>) => (
  <SceneStage {...props} scene={TAVERN_SCENE} />
);

const QUEST_BOARD = TAVERN_SCENE.map.board;

const onSelect = vi.fn();
const onOpenPr = vi.fn();
const themed = createThemedMount();

const renderTavern = (agents: AgentView[], selectedId: string | null = null) =>
  themed.render(
    <TavernView
      agents={agents}
      onSelect={onSelect}
      onOpenPr={onOpenPr}
      selectedId={selectedId}
      introPlaying={false}
      personas={assignPersonas(agents)}
    />
  );

const notes = () => [
  ...el('orchestrator-tavern-quest-board').querySelectorAll<HTMLElement>(
    '[role="button"][data-testid^="orchestrator-tavern-quest-"]'
  ),
];

// A needs-you agent's speech bubble loads its session to find what it waits on.
beforeEach(() => {
  (window as unknown as { b4m: unknown }).b4m = {
    host: chatBackedHostBridge(),
    chat: {
      getSession: vi.fn().mockResolvedValue(null),
      onStreamEvent: vi.fn(() => () => undefined),
      onQueueChanged: vi.fn(() => () => undefined),
    },
  };
});

afterEach(() => {
  themed.unmount();
  vi.clearAllMocks();
  vi.useRealTimers();
});

describe('QuestBoard', () => {
  it('pins one note per open quest, naming the agent and its task', async () => {
    const task = {
      workerTask: { contract: { outcome: 'Review the auth middleware' } },
    } as unknown as Partial<AgentView>;
    await renderTavern([agentFixture('a', 'working', task), agentFixture('b', 'needs-you'), agentFixture('c', 'idle')]);
    expect(notes().map(note => note.dataset.testid)).toEqual([
      'orchestrator-tavern-quest-a',
      'orchestrator-tavern-quest-b',
    ]);
    expect(el('orchestrator-tavern-quest-a').textContent).toContain('Review the auth middleware');
    expect(el('orchestrator-tavern-quest-b').textContent).toContain('Agent b');
    expect(el('orchestrator-tavern-quest-board').getAttribute('aria-label')).toBe('Quest board: 2 open quests');
  });

  it('says so when no quest is posted', async () => {
    await renderTavern([agentFixture('a', 'idle')]);
    expect(query('orchestrator-tavern-quest-empty')).not.toBeNull();
    expect(notes()).toHaveLength(0);
  });

  it('opens the agent behind a note when it is clicked', async () => {
    await renderTavern([agentFixture('a', 'working')], 'a');
    const note = el('orchestrator-tavern-quest-a');
    expect(note.getAttribute('aria-pressed')).toBe('true');
    await act(async () => note.click());
    expect(onSelect).toHaveBeenCalledWith('a');
  });

  it('checks a quest off when its agent finishes, then takes it down', async () => {
    vi.useFakeTimers();
    await renderTavern([agentFixture('a', 'working'), agentFixture('b', 'working')]);
    await renderTavern([agentFixture('a', 'done'), agentFixture('b', 'working')]);
    const done = el('orchestrator-tavern-quest-a');
    expect(done.dataset.done).toBe('true');
    expect(done.getAttribute('aria-label')).toContain('(done)');
    expect(el('orchestrator-tavern-quest-board').getAttribute('aria-label')).toBe('Quest board: 1 open quest');

    await act(async () => {
      vi.advanceTimersByTime(QUEST_DONE_LINGER_MS);
    });
    expect(query('orchestrator-tavern-quest-a')).toBeNull();
    expect(query('orchestrator-tavern-quest-b')).not.toBeNull();
  });

  it('opens a pinned quest PR separately from its agent, including keyboard activation', async () => {
    await renderTavern([agentFixture('a', 'working', { pr: { number: 611, state: 'open' } })]);
    const note = el('orchestrator-tavern-quest-a');
    const badge = note.querySelector<HTMLButtonElement>('[data-testid="orchestrator-pr-indicator"]')!;
    expect(badge.closest('button')?.parentElement?.closest('button')).toBeNull();
    await act(async () => {
      badge.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', shiftKey: true, bubbles: true }));
    });
    expect(onOpenPr).toHaveBeenCalledWith('a');
    expect(onSelect).not.toHaveBeenCalled();
    await act(async () => note.dispatchEvent(new KeyboardEvent('keydown', { key: ' ', bubbles: true })));
    expect(onSelect).toHaveBeenCalledWith('a');
  });

  it('shows PRs in overflow quest notes without selecting the agent', async () => {
    const agents = Array.from({ length: QUEST_BOARD.notes + 2 }, (_, index) =>
      agentFixture(`a${index}`, 'working', { pr: { number: 611 + index, state: 'closed' } })
    );
    await renderTavern(agents);
    await act(async () => el('orchestrator-tavern-quest-more').click());
    const item = el(`orchestrator-tavern-quest-more-item-a${agents.length - 1}`);
    await act(async () =>
      item
        .querySelector<HTMLButtonElement>('[data-testid="orchestrator-pr-indicator"]')!
        .dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, shiftKey: true }))
    );
    expect(onOpenPr).toHaveBeenCalledWith(`a${agents.length - 1}`);
    expect(onSelect).not.toHaveBeenCalled();
  });

  it('checks a quest off even when its agent reads idle on the way to done', async () => {
    await renderTavern([agentFixture('a', 'working')]);
    await renderTavern([agentFixture('a', 'idle')]);
    await renderTavern([agentFixture('a', 'done')]);
    expect(el('orchestrator-tavern-quest-a').dataset.done).toBe('true');
  });

  it('does not pin quests that were already done when the board first saw them', async () => {
    await renderTavern([agentFixture('a', 'done')]);
    expect(query('orchestrator-tavern-quest-a')).toBeNull();
  });

  it('folds the quests past the board into a "+N" note listing them', async () => {
    const agents = Array.from({ length: QUEST_BOARD.notes + 2 }, (_, index) => agentFixture(`a${index}`, 'working'));
    await renderTavern(agents);
    expect(notes()).toHaveLength(QUEST_BOARD.notes - 1);
    const more = el('orchestrator-tavern-quest-more');
    expect(more.textContent).toContain('+3');
    await act(async () => more.click());
    const last = el(`orchestrator-tavern-quest-more-item-a${agents.length - 1}`);
    await act(async () => last.click());
    expect(onSelect).toHaveBeenCalledWith(`a${agents.length - 1}`);
  });

  describe('on a board too short for the nominal count', () => {
    const stubBoardHeight = (height: number) =>
      vi.spyOn(HTMLElement.prototype, 'clientHeight', 'get').mockReturnValue(height);
    const threeAgents = () => ['a', 'b', 'c'].map(id => agentFixture(id, 'working'));

    afterEach(() => vi.restoreAllMocks());

    it('pins fewer notes and folds the rest into "+N"', async () => {
      stubBoardHeight(77);
      await renderTavern(threeAgents());
      expect(notes()).toHaveLength(1);
      expect(el('orchestrator-tavern-quest-more').textContent).toContain('+2');
    });

    it('keeps only the "+N" note when no note fits', async () => {
      stubBoardHeight(28);
      await renderTavern(threeAgents());
      expect(notes()).toHaveLength(0);
      expect(el('orchestrator-tavern-quest-more').textContent).toContain('+3');
      expect(getComputedStyle(el('orchestrator-tavern-quest-board')).visibility).not.toBe('hidden');
    });

    it('leaves the board undrawn when even the "+N" note does not fit', async () => {
      stubBoardHeight(16);
      await renderTavern(threeAgents());
      expect(getComputedStyle(el('orchestrator-tavern-quest-board')).visibility).toBe('hidden');
    });
  });
});
