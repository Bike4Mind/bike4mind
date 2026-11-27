// @vitest-environment jsdom
import { chatBackedHostBridge, chatStubs } from '../__fixtures__/chatBackedHostBridge';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { CssVarsProvider } from '@mui/joy/styles';
import type { PendingTaskDecision } from '@shared/orchestration';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  TASK_DECISION_LIST_MAX_HEIGHT,
  TaskDecisionCard,
  TaskDecisionCards,
  decisionsFor,
  useTaskDecisions,
} from './TaskDecisionCards';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

window.matchMedia ??= ((query: string) => ({
  matches: false,
  media: query,
  onchange: null,
  addListener: () => {},
  removeListener: () => {},
  addEventListener: () => {},
  removeEventListener: () => {},
  dispatchEvent: () => false,
})) as typeof window.matchMedia;

const pending = (sessionId: string, rootId: string, id: string): PendingTaskDecision => ({
  sessionId,
  rootId,
  title: `Agent ${sessionId}`,
  decision: {
    id,
    askedAt: '2026-11-13T00:00:00.000Z',
    question: {
      question: 'Stack on the prerequisite branch?',
      header: 'Decision',
      options: [
        { label: 'Stack on it (Recommended)', description: 'Start now.' },
        { label: 'Wait for the merge', description: 'Pause.' },
      ],
    },
  },
});

let root: Root | null = null;
let host: HTMLElement | null = null;
const answerTaskDecision = vi.fn(async () => undefined);
(window as unknown as { b4m: unknown }).b4m = { host: chatBackedHostBridge(), chat: { answerTaskDecision } };

afterEach(() => {
  act(() => root?.unmount());
  host?.remove();
  root = null;
  host = null;
  answerTaskDecision.mockReset();
});

function mount(sessionId: string, decisions: PendingTaskDecision[], onOpenSession = vi.fn()) {
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
  act(() => {
    root?.render(
      <CssVarsProvider>
        <TaskDecisionCards sessionId={sessionId} decisions={decisions} onOpenSession={onOpenSession} />
      </CssVarsProvider>
    );
  });
  return onOpenSession;
}

const all = (testId: string) => [...(host?.querySelectorAll<HTMLElement>(`[data-testid="${testId}"]`) ?? [])];
const one = (testId: string) => all(testId)[0];
const click = async (element: HTMLElement | undefined) => {
  await act(async () => element?.click());
};

describe('TaskDecisionCards', () => {
  const decisions = [pending('w1', 'root', 'd1'), pending('w2', 'other-root', 'd2')];

  it('caps the list and scrolls it, so many decisions never squeeze the thread or stage above', () => {
    mount('root', [pending('w1', 'root', 'd1'), pending('w2', 'root', 'd2'), pending('w3', 'root', 'd3')]);
    const list = one('task-decision-list');
    const style = getComputedStyle(list);
    expect(style.maxHeight).toBe(TASK_DECISION_LIST_MAX_HEIGHT);
    expect(style.overflowY).toBe('auto');
    expect(style.flexShrink).toBe('0');
    expect(list.getAttribute('role')).toBe('region');
    expect(list.tabIndex).toBe(0);
  });

  it('shows the root only its own agents decisions, and the worker its own', () => {
    mount('root', decisions);
    expect(all('task-decision-card').map(card => card.dataset.decisionId)).toEqual(['d1']);
    expect(one('task-decision-card').textContent).toContain('Agent w1 needs your decision');
    expect(one('task-decision-agent-link')).toBeTruthy();
    act(() => root?.unmount());
    host?.remove();

    mount('w2', decisions);
    expect(all('task-decision-card').map(card => card.dataset.decisionId)).toEqual(['d2']);
    // In the worker's own conversation there is nothing to link to.
    expect(one('task-decision-agent-link')).toBeUndefined();
  });

  it('draws nothing when no decision belongs here', () => {
    mount('elsewhere', decisions);
    expect(one('task-decision-list')).toBeUndefined();
  });

  it('submits the picked option for that worker and decision', async () => {
    mount('root', decisions);
    await click(one('chat-question-option-0-1'));
    await click(one('chat-question-submit'));
    expect(answerTaskDecision).toHaveBeenCalledWith('w1', 'd1', {
      status: 'answered',
      answers: [{ selected: ['Wait for the merge'] }],
    });
    expect(one('task-decision-sending')).toBeTruthy();
  });

  it('sends Skip, and shows a refusal so the card can be answered again', async () => {
    answerTaskDecision.mockRejectedValueOnce(new Error('This decision is no longer pending.'));
    mount('root', decisions);
    await click(one('chat-question-skip'));
    expect(answerTaskDecision).toHaveBeenCalledWith('w1', 'd1', { status: 'skipped' });
    expect(one('task-decision-error').textContent).toContain('no longer pending');
    expect(one('chat-question-card')).toBeTruthy();
  });

  it('reports an answer that went through, and stays silent when it was refused', async () => {
    const onAnswered = vi.fn();
    const renderCard = () => {
      host = document.createElement('div');
      document.body.appendChild(host);
      root = createRoot(host);
      act(() => {
        root?.render(
          <CssVarsProvider>
            <TaskDecisionCard
              sessionId="w1"
              title="Agent w1"
              decision={decisions[0].decision}
              onAnswered={onAnswered}
            />
          </CssVarsProvider>
        );
      });
    };
    answerTaskDecision.mockRejectedValueOnce(new Error('This decision is no longer pending.'));
    renderCard();
    await click(one('chat-question-skip'));
    expect(one('task-decision-error')).toBeTruthy();
    expect(onAnswered).not.toHaveBeenCalled();

    await click(one('chat-question-skip'));
    expect(onAnswered).toHaveBeenCalledTimes(1);
  });

  it('opens the asking agent from the root card', async () => {
    const onOpen = mount('root', decisions);
    await click(one('task-decision-agent-link'));
    expect(onOpen).toHaveBeenCalledWith('w1');
  });
});

describe('decisionsFor', () => {
  const decisions = [pending('w1', 'root', 'd1'), pending('root', 'root', 'd2'), pending('w2', 'other', 'd3')];

  it('keeps the decisions asked under this root and by the root itself', () => {
    expect(decisionsFor('root', decisions).map(entry => entry.decision.id)).toEqual(['d1', 'd2']);
  });

  it('keeps only the worker its own decision', () => {
    expect(decisionsFor('w2', decisions).map(entry => entry.decision.id)).toEqual(['d3']);
  });

  it('keeps nothing for an unsaved conversation', () => {
    expect(decisionsFor(null, decisions)).toEqual([]);
  });
});

describe('useTaskDecisions', () => {
  function Probe() {
    const decisions = useTaskDecisions();
    return <div data-testid="decision-ids">{decisions.map(entry => entry.decision.id).join(',')}</div>;
  }

  function mountProbe() {
    host = document.createElement('div');
    document.body.appendChild(host);
    root = createRoot(host);
    act(() => root?.render(<Probe />));
  }

  const flush = () => act(async () => undefined);
  const ids = () => one('decision-ids')?.textContent;

  function stubDecisions(seed: Promise<PendingTaskDecision[]>) {
    let push: (decisions: PendingTaskDecision[]) => void = () => undefined;
    const chat = chatStubs();
    chat.listTaskDecisions = () => seed;
    chat.onTaskDecisions = listener => {
      push = listener;
      return () => undefined;
    };
    return (decisions: PendingTaskDecision[]) => act(() => push(decisions));
  }

  it('shows the seeded decisions', async () => {
    stubDecisions(Promise.resolve([pending('w1', 'root', 'd1')]));
    mountProbe();
    await flush();
    expect(ids()).toBe('d1');
  });

  it('replaces the list with each pushed one', async () => {
    const push = stubDecisions(Promise.resolve([pending('w1', 'root', 'd1')]));
    mountProbe();
    await flush();
    push([pending('w2', 'root', 'd2'), pending('w3', 'root', 'd3')]);
    expect(ids()).toBe('d2,d3');
    push([]);
    expect(ids()).toBe('');
  });

  it('keeps a push that lands before the seed answer', async () => {
    let answerSeed: (decisions: PendingTaskDecision[]) => void = () => undefined;
    const push = stubDecisions(new Promise(resolve => (answerSeed = resolve)));
    mountProbe();
    push([pending('w2', 'root', 'd2')]);
    await act(async () => answerSeed([pending('w1', 'root', 'd1')]));
    expect(ids()).toBe('d2');
  });
});
