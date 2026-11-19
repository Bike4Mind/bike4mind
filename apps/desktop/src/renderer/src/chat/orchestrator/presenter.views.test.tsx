// @vitest-environment jsdom
import { act } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { OrchestratorStage } from './OrchestratorStage';
import { ORCHESTRATOR_VIEWS, type OrchestratorViewId } from './orchestratorPrefs';
import { presenterAgentTitle } from './presenter';
import type { AgentView } from './roster';
import { agentFixture, createThemedMount, el, query } from './testUtils';
import { renderOrchestratorView } from './viewRegistry';

const chime = vi.hoisted(() => ({ playChime: vi.fn() }));
vi.mock('./chime', () => chime);

const SECRET = 'SECRET';

/** Every redacted kind of text on a roster: titles, activity, last replies, a question and its options, PRs, branches, costs. */
const ROSTER: AgentView[] = [
  agentFixture('asking', 'needs-you', {
    title: `${SECRET} billing refactor`,
    seedPrompt: `${SECRET} seed`,
    decision: {
      id: 'decision-1',
      askedAt: '2026-10-01T00:00:00.000Z',
      question: {
        question: `${SECRET} ship it?`,
        header: `${SECRET} header`,
        options: [
          { label: `${SECRET} yes`, description: `${SECRET} yes means` },
          { label: `${SECRET} no`, description: `${SECRET} no means` },
        ],
      },
    },
    credits: 1234,
    branch: `${SECRET}-branch-a`,
  }),
  agentFixture('busy', 'working', {
    title: `${SECRET} parser work`,
    activity: { kind: 'tool', tool: 'bash', detail: `${SECRET} command` },
    usdCost: 7.77,
    pr: { number: 4242, state: 'open' },
    branch: `${SECRET}-branch-b`,
  }),
  agentFixture('shipped', 'done', {
    title: `${SECRET} docs pass`,
    lastSnippet: `${SECRET} last reply`,
    credits: 55,
    pr: { number: 4343, state: 'merged' },
  }),
  agentFixture('broken', 'failed', { title: `${SECRET} flaky test`, lastSnippet: `${SECRET} failure` }),
];

/** Strings that would only be on screen if some real text, PR number or cost got through. */
const LEAKS = [SECRET, '4242', '4343', '1,234', '1234', '7.77', 'credit'];

const answerTaskDecision = vi.fn().mockResolvedValue(undefined);
const themed = createThemedMount();

beforeEach(() => {
  answerTaskDecision.mockClear();
  (window as unknown as { b4m: unknown }).b4m = {
    chat: {
      getSession: vi.fn().mockResolvedValue(null),
      getRunSpend: vi.fn().mockResolvedValue({ status: 'unattributed' }),
      onQueueChanged: vi.fn(() => () => undefined),
      onStreamEvent: vi.fn(() => () => undefined),
      answerTaskDecision,
    },
  };
});
afterEach(() => themed.unmount());

const renderStage = (view: OrchestratorViewId, { focus = false, settled = false, agents = ROSTER } = {}) =>
  themed.render(
    <OrchestratorStage
      agents={agents}
      parent={{ status: 'processing', activity: { kind: 'tool', tool: 'bash', detail: `${SECRET} root command` } }}
      rootId="root"
      view={view}
      onViewChange={vi.fn()}
      actions={{ open: vi.fn(), stop: vi.fn(), archive: vi.fn() }}
      introPlaying={false}
      renderView={renderOrchestratorView}
      presenter={{ on: true, onToggle: vi.fn() }}
      focus={{ on: focus, onToggle: vi.fn() }}
      ambient={{ settled, wake: vi.fn(), on: true, onToggle: vi.fn() }}
    />
  );

const expectNoLeaks = () => {
  const text = `${document.body.textContent ?? ''} ${document.body.innerHTML}`;
  for (const leak of LEAKS) expect(text, leak).not.toContain(leak);
};

describe('Presenter mode on every view', () => {
  it.each(ORCHESTRATOR_VIEWS)('%s shows no real title, activity, PR or cost, and the badge', async view => {
    await renderStage(view);
    expect(el('orchestrator-presenting-badge').textContent).toBe('Presenting');
    expectNoLeaks();
    // The leak check alone would pass on a view that drew nothing; every agent must show as its placeholder.
    const text = `${document.body.textContent ?? ''} ${document.body.innerHTML}`;
    ROSTER.forEach((_, index) => expect(text).toContain(presenterAgentTitle(index + 1)));
  });

  it('Focus mode shows placeholders and answers with the real option', async () => {
    await renderStage('board', { focus: true });
    expectNoLeaks();
    const options = [...document.querySelectorAll<HTMLElement>('[data-testid="orchestrator-focus-option-btn"]')];
    expect(options.map(option => option.textContent)).toEqual(['Option 1', 'Option 2']);
    await act(async () => options[1].click());
    expect(answerTaskDecision).toHaveBeenCalledWith('asking', 'decision-1', {
      status: 'answered',
      answers: [{ selected: [`${SECRET} no`] }],
    });
  });

  /** The asking agent, waiting on a choice whose real labels Focus mode must not offer one click each. */
  const askingWith = (labels: string[]): AgentView[] => {
    const [asking, ...rest] = ROSTER;
    const question = { ...asking.decision!.question, options: labels.map(label => ({ label, description: label })) };
    return [{ ...asking, decision: { ...asking.decision!, question } }, ...rest];
  };

  it.each([
    ['a destructive option', ['Keep it', 'Delete the branch']],
    ['a long option', ['Yes', 'Rewrite the whole billing module from scratch']],
  ])('Focus mode sends %s to Open instead of one-click placeholders', async (_case, labels) => {
    await renderStage('board', { focus: true, agents: askingWith(labels) });
    expect(document.querySelectorAll('[data-testid="orchestrator-focus-option-btn"]')).toHaveLength(0);
    expect(query('orchestrator-focus-open-btn')).not.toBeNull();
    expect(document.body.textContent).not.toContain('Option 2');
    expect(answerTaskDecision).not.toHaveBeenCalled();
  });

  it('the settled stage keeps the badge and sends the request to the drawer instead of showing it', async () => {
    await renderStage('tavern', { settled: true });
    expect(query('orchestrator-presenting-badge')).not.toBeNull();
    expect(el('orchestrator-needs-you-card').textContent).toContain('Open it to answer');
    expectNoLeaks();
  });

  it('opening an agent shows its real conversation details in the peek drawer', async () => {
    await renderStage('board', { focus: true });
    const open = document.querySelector<HTMLElement>('[data-testid="orchestrator-focus-open-btn"]');
    await act(async () => open?.click());
    expect(el('orchestrator-peek-drawer-region').textContent).toContain(`${SECRET} billing refactor`);
  });
});
