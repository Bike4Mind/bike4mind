// @vitest-environment jsdom
import { act } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ChatSession } from '@shared/chat';
import type { PendingDecision } from '@shared/orchestration';
import type { AgentView } from '../roster';
import { agentFixture, createThemedMount, el, query } from '../testUtils';
import { assignPersonas } from '@shared/agentPersona';
import { TavernView } from './TavernView';

const themed = createThemedMount();
const onSelect = vi.fn();

const parkedCall = (approvalId: string, extra: Record<string, unknown> = {}) => ({
  id: `call-${approvalId}`,
  name: 'bash',
  input: { command: 'pnpm test' },
  status: 'awaiting-approval',
  approvalId,
  ...extra,
});

/** A session whose reply in flight is parked on `calls`, as getSession returns it. */
const sessionWith = (id: string, calls: unknown[]) =>
  ({ id, messages: [{ id: 'm1', role: 'assistant', content: '', toolCalls: calls }] }) as unknown as ChatSession;

const decision = (labels: string[]): PendingDecision => ({
  id: 'd-1',
  askedAt: '2026-11-16T00:00:00.000Z',
  question: {
    question: 'Which database?',
    header: 'Decision',
    options: labels.map(label => ({ label, description: '' })),
  },
});

let chat: {
  getSession: ReturnType<typeof vi.fn>;
  respondToApproval: ReturnType<typeof vi.fn>;
  answerTaskDecision: ReturnType<typeof vi.fn>;
};

beforeEach(() => {
  chat = {
    getSession: vi.fn().mockResolvedValue(null),
    respondToApproval: vi.fn().mockResolvedValue(undefined),
    answerTaskDecision: vi.fn().mockResolvedValue(undefined),
  };
  (window as unknown as { b4m: unknown }).b4m = { chat };
});

afterEach(() => {
  themed.unmount();
  vi.clearAllMocks();
});

const renderTavern = (agents: AgentView[], answerFromBubble = true) =>
  themed.render(
    <TavernView
      agents={agents}
      onSelect={onSelect}
      selectedId={null}
      introPlaying={false}
      personas={assignPersonas(agents)}
      answerFromBubble={answerFromBubble}
    />
  );

const click = (testId: string) => act(async () => el(testId).click());

describe('NeedsYouBubble', () => {
  describe('a permission wait', () => {
    beforeEach(() => {
      chat.getSession.mockImplementation(async (id: string) => sessionWith(id, [parkedCall(`ap-${id}`)]));
    });

    it('approves once from the bubble, then the bubble clears with the wait', async () => {
      await renderTavern([agentFixture('a', 'needs-you')]);
      expect(el('orchestrator-tavern-bubble-a-actions').getAttribute('data-plan')).toBe('approve');
      expect(el('orchestrator-tavern-bubble-a-prompt').textContent).toBe('bash pnpm test');

      await click('orchestrator-tavern-bubble-a-approve');
      expect(chat.respondToApproval).toHaveBeenCalledWith('ap-a', { decision: 'once' });
      expect(el('orchestrator-tavern-bubble-a-approve').hasAttribute('disabled')).toBe(true);

      // Main settles the wait and pushes the new status; the same push clears the card and the badge.
      await renderTavern([agentFixture('a', 'working')]);
      expect(query('orchestrator-tavern-bubble-a-actions')).toBeNull();
    });

    it('denies from the bubble and never offers "always allow"', async () => {
      await renderTavern([agentFixture('a', 'needs-you')]);
      expect(el('orchestrator-tavern-bubble-a').textContent).not.toMatch(/always/i);
      await click('orchestrator-tavern-bubble-a-deny');
      expect(chat.respondToApproval).toHaveBeenCalledWith('ap-a', { decision: 'deny' });
    });

    it('sends an irreversible call to the full card instead', async () => {
      chat.getSession.mockResolvedValue(sessionWith('a', [parkedCall('ap-a', { approvalIrreversible: true })]));
      await renderTavern([agentFixture('a', 'needs-you')]);
      expect(query('orchestrator-tavern-bubble-a-approve')).toBeNull();
      await click('orchestrator-tavern-bubble-a-open');
      expect(onSelect).toHaveBeenCalledWith('a');
    });

    it('shows a failed answer in the bubble and lets the user try again', async () => {
      chat.respondToApproval.mockRejectedValueOnce(new Error('Request expired'));
      await renderTavern([agentFixture('a', 'needs-you')]);
      await click('orchestrator-tavern-bubble-a-approve');
      expect(el('orchestrator-tavern-bubble-a-error').textContent).toBe('Request expired');
      expect(el('orchestrator-tavern-bubble-a-approve').hasAttribute('disabled')).toBe(false);
    });
  });

  describe('a decision wait', () => {
    it('answers with the clicked option, the recommended one without its suffix', async () => {
      await renderTavern([
        agentFixture('a', 'needs-you', { decision: decision(['Postgres (Recommended)', 'SQLite']) }),
      ]);
      expect(el('orchestrator-tavern-bubble-a-prompt').textContent).toBe('Which database?');
      expect(el('orchestrator-tavern-bubble-a-option-0').textContent).toBe('Postgres');

      await click('orchestrator-tavern-bubble-a-option-1');
      expect(chat.answerTaskDecision).toHaveBeenCalledWith('a', 'd-1', {
        status: 'answered',
        answers: [{ selected: ['SQLite'] }],
      });

      await renderTavern([agentFixture('a', 'working')]);
      expect(query('orchestrator-tavern-bubble-a-actions')).toBeNull();
    });

    it('falls back to Open for a destructive choice', async () => {
      await renderTavern([agentFixture('a', 'needs-you', { decision: decision(['Keep it', 'Delete the branch']) })]);
      expect(el('orchestrator-tavern-bubble-a-actions').getAttribute('data-plan')).toBe('open');
      expect(query('orchestrator-tavern-bubble-a-option-0')).toBeNull();
    });
  });

  it('cycles the shared bubble through every agent waiting in the zone', async () => {
    chat.getSession.mockImplementation(async (id: string) => sessionWith(id, [parkedCall(`ap-${id}`)]));
    await renderTavern(['a', 'b', 'c'].map(id => agentFixture(id, 'needs-you')));
    const bubble = 'orchestrator-tavern-bubble-b';
    expect(el(`${bubble}-label`).textContent).toBe('Needs you! ×3');
    expect(el(`${bubble}-prompt`).textContent).toMatch(/^.+: bash pnpm test$/);

    const names = new Set<string>();
    for (let step = 0; step < 3; step++) {
      names.add(el(`${bubble}-prompt`).textContent ?? '');
      await click(`${bubble}-next`);
    }
    expect(names.size).toBe(3);

    await click(`${bubble}-approve`);
    expect(chat.respondToApproval).toHaveBeenCalledTimes(1);
  });

  it('is reachable by keyboard: every action is a native button', async () => {
    chat.getSession.mockResolvedValue(sessionWith('a', [parkedCall('ap-a')]));
    await renderTavern([agentFixture('a', 'needs-you')]);
    const buttons = [...el('orchestrator-tavern-bubble-a').querySelectorAll('button')];
    expect(buttons.map(button => button.textContent)).toEqual(['Approve', 'Deny', 'Open']);
    expect(buttons.every(button => button.type === 'button' && button.tabIndex === 0)).toBe(true);
    // Not nested inside the sprite's own button.
    expect(el('orchestrator-tavern-agent-a').contains(buttons[0])).toBe(false);
  });

  it('leaves the plain bubble where the bubble does not answer (the mini Tavern)', async () => {
    await renderTavern([agentFixture('a', 'needs-you')], false);
    expect(el('orchestrator-tavern-bubble-a').textContent).toBe('Needs you!');
    expect(query('orchestrator-tavern-bubble-a-actions')).toBeNull();
    expect(chat.getSession).not.toHaveBeenCalled();
  });
});
