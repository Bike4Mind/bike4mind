// @vitest-environment jsdom
import { act } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { assignPersonas } from '@shared/agentPersona';
import type { AgentView } from '../roster';
import { agentFixture, createThemedMount, el, query } from '../testUtils';
import { QUEST_DONE_LINGER_MS } from './quests';
import { QUEST_BOARD } from './scene';
import { TavernView } from './TavernView';

const onSelect = vi.fn();
const themed = createThemedMount();

const renderTavern = (agents: AgentView[], selectedId: string | null = null) =>
  themed.render(
    <TavernView
      agents={agents}
      onSelect={onSelect}
      selectedId={selectedId}
      introPlaying={false}
      personas={assignPersonas(agents)}
    />
  );

const notes = () => [
  ...el('orchestrator-tavern-quest-board').querySelectorAll<HTMLElement>(
    'button[data-testid^="orchestrator-tavern-quest-"]:not([data-testid="orchestrator-tavern-quest-more"])'
  ),
];

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
});
