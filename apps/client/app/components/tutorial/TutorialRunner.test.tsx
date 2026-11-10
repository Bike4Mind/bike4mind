import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

const mockSetOptimistic = vi.hoisted(() => vi.fn());
const mockToast = vi.hoisted(() => vi.fn());
const mockInput = vi.hoisted(() => ({
  chatInputValue: '',
  setDraft: vi.fn(),
  setChatInputValue: vi.fn(),
  requestFocus: vi.fn(),
  clearDraft: vi.fn(),
}));
const mockFiles = vi.hoisted(() => ({ current: [] as { id: string }[] }));
const mockAgent = vi.hoisted(() => ({ feature: true, toggle: false, default: 'off' as 'off' | 'auto' | 'on' }));
vi.mock('@client/app/utils/react-query', () => ({ setOptimisticQueryData: mockSetOptimistic }));
vi.mock('@client/app/hooks/useChatInput', () => ({
  useChatInput: { getState: () => mockInput, subscribe: () => () => undefined },
}));
vi.mock('@client/app/contexts/SessionsContext', () => ({ useWorkBenchFiles: () => mockFiles.current }));
vi.mock('sonner', () => ({ toast: mockToast }));
vi.mock('@client/app/contexts/LLMContext', () => ({
  useLLM: (select: (state: { agentMode: { enabled: boolean } }) => unknown) =>
    select({ agentMode: { enabled: mockAgent.toggle } }),
}));
vi.mock('@client/app/contexts/UserSettingsContext', () => ({
  useUserSettings: () => ({ settings: { agentModeDefault: mockAgent.default } }),
}));
vi.mock('@client/app/hooks/useFeatureEnabled', () => ({
  useFeatureEnabled: () => ({ isFeatureEnabled: () => mockAgent.feature }),
}));

import { TUTORIAL_MARKER_TYPE } from '@bike4mind/common';
import { a11yAttr } from './a11y';
import { GENERIC_TUTORIAL_STEPS, readAttachCue } from './genericSteps';
import {
  CHANGED_NOTICE,
  JUMP_FAILED_NOTICE,
  LANDED_EARLIER_NOTICE,
  LEFT_NOTICE,
  OFF_NOTICE,
  PAUSED_NOTICE,
  TutorialRunner,
  hasForeignQuest,
  stepProgress,
} from './TutorialRunner';
import type {
  TutorialQuest,
  TutorialScript,
  TutorialStepProps,
  TutorialStepRegistry,
  TutorialTransport,
} from './types';
import { TutorialHostProvider } from './TutorialHostContext';
import { tutorialStoreFor } from './useTutorialStore';

const BASE = '/api/test-tutorials';
const useTutorialStore = { getState: () => tutorialStoreFor(BASE).getState() };

function HostedClient({ client, children }: { client: QueryClient; children: React.ReactNode }) {
  return (
    <QueryClientProvider client={client}>
      <TutorialHostProvider apiBase={BASE}>{children}</TutorialHostProvider>
    </QueryClientProvider>
  );
}

const script: TutorialScript = {
  id: 'demo',
  steps: [
    { id: 'intro', type: 'point', body: 'Here is the problem.' },
    { id: 'ask', type: 'prompt', body: 'Send the question.', turn: 1, prompt: 'What next?', anchor: 'send-btn' },
    { id: 'wrap', type: 'point', body: 'That is the answer.', anchor: 'answer-panel' },
  ],
};

const marked = (id: string, turn?: number): TutorialQuest => ({
  id,
  status: 'done',
  uiSideEffects: [{ type: TUTORIAL_MARKER_TYPE, payload: { turn } }],
});

function transport(): TutorialTransport & {
  advance: ReturnType<typeof vi.fn>;
  position: ReturnType<typeof vi.fn>;
  sheet: ReturnType<typeof vi.fn>;
} {
  return {
    progress: vi.fn(async () => ({})),
    start: vi.fn(async () => ({ sessionId: 's1' })),
    resume: vi.fn(async () => ({ sessionId: 's1' })),
    sheet: vi.fn(async () => ({ fileId: 'sheet-1' })),
    advance: vi.fn(async () => ({ quest: marked('q1') })),
    position: vi.fn(async () => undefined),
  };
}

function renderRunner(
  t: TutorialTransport,
  quests?: TutorialQuest[],
  {
    using = script,
    onStartModule,
    onExit,
    landOn,
    onShowSteps,
    onChanged,
    registry = GENERIC_TUTORIAL_STEPS,
  }: {
    using?: TutorialScript;
    onStartModule?: (moduleId: string) => void;
    onExit?: () => void;
    landOn?: (stepId: string, sessionId: string) => string;
    onShowSteps?: () => void;
    onChanged?: () => void;
    registry?: TutorialStepRegistry;
  } = {}
) {
  const client = new QueryClient();
  const ui = (q?: TutorialQuest[]) => (
    <HostedClient client={client}>
      <TutorialRunner
        script={using}
        steps={registry}
        transport={t}
        quests={q}
        onStartModule={onStartModule}
        onExit={onExit}
        landOn={landOn}
        onShowSteps={onShowSteps}
        onChanged={onChanged}
      />
    </HostedClient>
  );
  const view = render(ui(quests));
  return { ...view, client, rerenderWith: (q?: TutorialQuest[]) => view.rerender(ui(q)) };
}

const begin = (stepId: string, moduleId = 'demo') =>
  act(() => useTutorialStore.getState().begin({ moduleId, sessionId: 's1', stepId }));

beforeEach(() => {
  useTutorialStore.getState().end();
  useTutorialStore.getState().clearJump();
  mockSetOptimistic.mockReset();
  mockToast.mockReset();
  mockInput.chatInputValue = '';
  mockInput.setDraft.mockReset();
  mockInput.setChatInputValue.mockReset();
  mockInput.requestFocus.mockReset();
  mockFiles.current = [];
  Object.assign(mockAgent, { feature: true, toggle: false, default: 'off' });
});

describe('TutorialRunner', () => {
  it('renders nothing while no module is active, or another module is', () => {
    const { container } = renderRunner(transport());
    expect(container).toBeEmptyDOMElement();
    begin('intro', 'other');
    expect(screen.queryByTestId('tutorial-coach-card')).toBeNull();
  });

  it('shows the current step and moves to the next on its event, recording the position', async () => {
    const t = transport();
    renderRunner(t);
    begin('intro');
    expect(screen.getByTestId('tutorial-coach-card')).toHaveTextContent('Here is the problem.');
    fireEvent.click(screen.getByTestId('tutorial-step-next'));
    expect(useTutorialStore.getState().active?.stepId).toBe('ask');
    expect(t.position).toHaveBeenCalledWith({ moduleId: 'demo', stepId: 'ask', status: 'in_progress' });
    expect(screen.getByTestId('tutorial-step-paste')).toBeInTheDocument();
  });

  it('swaps the body for doneBody once the step reports its action done', () => {
    const Doing = ({ markDone }: TutorialStepProps) => (
      <button data-testid="do-it" onClick={() => markDone?.()}>
        do
      </button>
    );
    const doneScript: TutorialScript = {
      id: 'demo',
      steps: [{ id: 'open', type: 'doing', body: 'Open it.', doneBody: 'It is open.' }],
    };
    render(
      <HostedClient client={new QueryClient()}>
        <TutorialRunner script={doneScript} steps={{ doing: Doing }} transport={transport()} />
      </HostedClient>
    );
    begin('open');
    expect(screen.getByTestId('tutorial-coach-card')).toHaveTextContent('Open it.');
    fireEvent.click(screen.getByTestId('do-it'));
    expect(screen.getByTestId('tutorial-coach-card')).toHaveTextContent('It is open.');
    expect(screen.getByTestId('tutorial-coach-card')).not.toHaveTextContent('Open it.');
  });

  describe('doneBody', () => {
    const Doing = ({ markDone, complete }: TutorialStepProps) => (
      <>
        <button data-testid="do-it" onClick={() => markDone?.()}>
          do
        </button>
        <button data-testid="undo-it" onClick={() => markDone?.(false)}>
          undo
        </button>
        <button data-testid="tutorial-step-next" onClick={complete}>
          next
        </button>
      </>
    );
    const twoDone: TutorialScript = {
      id: 'demo',
      steps: [
        { id: 'open', type: 'doing', body: 'Open it.', doneBody: 'It is open.' },
        { id: 'look', type: 'doing', body: 'Look at it.', doneBody: 'You looked.' },
      ],
    };
    const renderDone = () =>
      render(
        <HostedClient client={new QueryClient()}>
          <TutorialRunner script={twoDone} steps={{ doing: Doing }} transport={transport()} />
        </HostedClient>
      );
    const card = () => screen.getByTestId('tutorial-coach-card');

    it('switches back to the body when the step reports its action undone', () => {
      renderDone();
      begin('open');
      fireEvent.click(screen.getByTestId('do-it'));
      expect(card()).toHaveTextContent('It is open.');
      fireEvent.click(screen.getByTestId('undo-it'));
      expect(card()).toHaveTextContent('Open it.');
    });

    it('brings a card hidden to its pill back once the step reports done, showing its doneBody', () => {
      renderDone();
      begin('open');
      fireEvent.click(screen.getByTestId('tutorial-coach-hide'));
      expect(screen.getByTestId('tutorial-coach-pill')).toBeVisible();
      fireEvent.click(screen.getByTestId('do-it'));
      expect(card()).toBeVisible();
      expect(card()).toHaveTextContent('It is open.');
      expect(screen.queryByTestId('tutorial-coach-pill')).toBeNull();
    });

    it('does not carry a done step over to the next step', () => {
      renderDone();
      begin('open');
      fireEvent.click(screen.getByTestId('do-it'));
      fireEvent.click(screen.getByTestId('tutorial-step-next'));
      expect(card()).toHaveTextContent('Look at it.');
      expect(card()).not.toHaveTextContent('You looked.');
    });

    it('starts a step over on its body when the user comes back to it', () => {
      renderDone();
      begin('open');
      fireEvent.click(screen.getByTestId('do-it'));
      act(() => useTutorialStore.getState().goTo('look'));
      act(() => useTutorialStore.getState().goTo('open'));
      expect(card()).toHaveTextContent('Open it.');
      expect(card()).not.toHaveTextContent('It is open.');
    });
  });

  it('does not skip a step when the same step reports completion twice', () => {
    renderRunner(transport());
    begin('intro');
    const next = screen.getByTestId('tutorial-step-next');
    fireEvent.click(next);
    fireEvent.click(next);
    expect(useTutorialStore.getState().active?.stepId).toBe('ask');
  });

  it("pastes the turn's prompt into the composer and waits for the user to send it", async () => {
    const t = transport();
    const { rerenderWith } = renderRunner(t, []);
    begin('ask');
    expect(mockInput.setDraft).toHaveBeenCalledWith('s1', 'What next?');
    expect(mockInput.setChatInputValue).toHaveBeenCalledWith('What next?');
    expect(mockInput.requestFocus).toHaveBeenCalled();
    expect(t.advance).not.toHaveBeenCalled();

    rerenderWith([{ id: 'u1', prompt: 'What next?', status: 'running' }]);
    expect(screen.getByTestId('tutorial-step-waiting')).toBeInTheDocument();
    expect(useTutorialStore.getState().active?.stepId).toBe('ask');

    rerenderWith([{ ...marked('u1', 1), prompt: 'What next?' }]);
    await waitFor(() => expect(useTutorialStore.getState().active?.stepId).toBe('wrap'));
    expect(t.advance).not.toHaveBeenCalled();
  });

  it('pastes the opening turn only on request, since the host sends it from its own start box', () => {
    const opening: TutorialScript = {
      id: 'demo',
      steps: [{ id: 'opening', type: 'prompt', body: 'Sent.', turn: 0, prompt: 'Hello' }],
    };
    const { rerenderWith } = renderRunner(transport(), [], { using: opening });
    begin('opening');
    expect(mockInput.setChatInputValue).not.toHaveBeenCalled();
    expect(screen.queryByTestId('tutorial-step-waiting')).toBeNull();
    fireEvent.click(screen.getByTestId('tutorial-step-paste'));
    expect(mockInput.setChatInputValue).toHaveBeenCalledWith('Hello');

    rerenderWith([{ id: 'u0', prompt: 'Hello', status: 'running' }]);
    expect(screen.getByTestId('tutorial-step-waiting')).toBeInTheDocument();
  });

  it('does not move on for the reply to another turn', () => {
    renderRunner(transport(), [marked('q0', 0)]);
    begin('ask');
    expect(useTutorialStore.getState().active?.stepId).toBe('ask');
  });

  it('never pastes over what the user is typing, and pastes again on request', () => {
    mockInput.chatInputValue = 'my own words';
    renderRunner(transport(), []);
    begin('ask');
    expect(mockInput.setChatInputValue).not.toHaveBeenCalled();
    fireEvent.click(screen.getByTestId('tutorial-step-paste'));
    expect(mockInput.setChatInputValue).toHaveBeenCalledWith('What next?');
  });

  it('points the card at the send button', () => {
    const button = document.createElement('button');
    button.setAttribute('data-testid', 'send-btn');
    document.body.appendChild(button);
    renderRunner(transport(), []);
    begin('ask');
    expect(screen.getByTestId('tutorial-anchor-ring')).toBeInTheDocument();
    button.remove();
  });

  it('finishes the module after the last step', () => {
    const t = transport();
    renderRunner(t);
    begin('wrap');
    fireEvent.click(screen.getByTestId('tutorial-step-next'));
    expect(t.position).toHaveBeenCalledWith({ moduleId: 'demo', stepId: 'wrap', status: 'finished' });
    expect(useTutorialStore.getState().active).toBeNull();
  });

  it('leaves only from Leave tutorial; close and Escape hide the card for the step without leaving', async () => {
    const t = transport();
    renderRunner(t);
    begin('intro');
    fireEvent.click(screen.getByTestId('tutorial-coach-hide'));
    expect(screen.getByTestId('tutorial-coach-card')).not.toBeVisible();
    expect(screen.getByTestId('tutorial-coach-pill')).toBeVisible();
    expect(useTutorialStore.getState().active?.stepId).toBe('intro');
    expect(t.position).not.toHaveBeenCalledWith(expect.objectContaining({ status: 'left' }));

    // The hidden card's step is still mounted, so it still advances.
    fireEvent.click(screen.getByTestId('tutorial-step-next'));
    expect(useTutorialStore.getState().active?.stepId).toBe('ask');
    expect(screen.getByTestId('tutorial-coach-card')).toBeVisible();
    expect(screen.queryByTestId('tutorial-coach-pill')).toBeNull();

    fireEvent.keyDown(screen.getByTestId('tutorial-step-paste'), { key: 'Escape' });
    expect(screen.getByTestId('tutorial-coach-pill')).toBeVisible();
    expect(useTutorialStore.getState().active?.stepId).toBe('ask');

    fireEvent.click(screen.getByTestId('tutorial-coach-pill'));
    fireEvent.click(screen.getByTestId('tutorial-coach-leave'));
    await waitFor(() =>
      expect(t.position).toHaveBeenLastCalledWith({ moduleId: 'demo', stepId: 'ask', status: 'left' })
    );
    expect(useTutorialStore.getState().active).toBeNull();
    expect(mockToast).toHaveBeenLastCalledWith(PAUSED_NOTICE);
  });

  it("steps aside once the chat answers a message of the user's own, not while it runs or for its placeholder", () => {
    const t = transport();
    const { rerenderWith } = renderRunner(t, [marked('q0')]);
    begin('intro');
    rerenderWith([{ id: 'optimistic-quest-s1', _optimistic: true }, marked('q0')]);
    expect(useTutorialStore.getState().active).not.toBeNull();

    rerenderWith([{ id: 'live', status: 'running', uiSideEffects: [] }, marked('q0')]);
    expect(useTutorialStore.getState().active).not.toBeNull();

    rerenderWith([{ id: 'live', status: 'done', uiSideEffects: [] }, marked('q0')]);
    expect(t.position).toHaveBeenCalledWith({ moduleId: 'demo', stepId: 'intro', status: 'left' });
    expect(useTutorialStore.getState().active).toBeNull();
    expect(mockToast).toHaveBeenCalledWith(LEFT_NOTICE);
  });

  it('ends without recording a position when the saved step no longer exists', () => {
    const t = transport();
    renderRunner(t);
    begin('removed-step');
    expect(useTutorialStore.getState().active).toBeNull();
    expect(mockToast).toHaveBeenCalledWith(CHANGED_NOTICE);
    expect(t.position).not.toHaveBeenCalled();
  });

  it('moves focus to the step button', () => {
    renderRunner(transport());
    begin('intro');
    expect(screen.getByTestId('tutorial-step-next')).toHaveFocus();
  });
});

describe('jumping from the journey panel', () => {
  const twoTurns: TutorialScript = {
    id: 'demo',
    steps: [
      { id: 'opening', type: 'prompt', body: 'Send the problem.', turn: 0 },
      { id: 'intro', type: 'point', body: 'Here is the problem.' },
      { id: 'ask', type: 'prompt', body: 'Send the question.', turn: 1 },
      { id: 'answer', type: 'point', body: 'The answer.' },
      { id: 'ask-more', type: 'prompt', body: 'Ask again.', turn: 2 },
      { id: 'wrap', type: 'point', body: 'That is all.' },
    ],
  };
  const jumpTo = (stepId: string, moduleId = 'demo') =>
    act(() => useTutorialStore.getState().requestJump({ moduleId, stepId }));

  it('seeds every turn before the step, in order, then stands on it and records the position', async () => {
    const t = transport();
    renderRunner(t, undefined, { using: twoTurns });
    begin('intro');
    jumpTo('wrap');
    await waitFor(() => expect(useTutorialStore.getState().active?.stepId).toBe('wrap'));
    expect(t.advance.mock.calls.map(([input]) => input.turn)).toEqual([0, 1, 2]);
    expect(t.position).toHaveBeenLastCalledWith({ moduleId: 'demo', stepId: 'wrap', status: 'in_progress' });
    expect(useTutorialStore.getState().pendingJump).toBeNull();
    expect(mockToast).not.toHaveBeenCalled();
  });

  it('leaves a prompt step its own turn to send', async () => {
    const t = transport();
    renderRunner(t, undefined, { using: twoTurns });
    begin('intro');
    jumpTo('ask-more');
    await waitFor(() => expect(useTutorialStore.getState().active?.stepId).toBe('ask-more'));
    expect(t.advance.mock.calls.map(([input]) => input.turn)).toEqual([0, 1]);
  });

  // A host's own step type can carry a turn (a sheet hand-over sends one), and a jump past it seeds it too.
  it("seeds a turn a host's own step type sends", async () => {
    const hostSend: TutorialScript = {
      id: 'demo',
      steps: [
        { id: 'opening', type: 'prompt', body: 'Send the problem.', turn: 0 },
        { id: 'hand-over', type: 'handOver', body: 'Attach and send.', turn: 1 },
        { id: 'answer', type: 'point', body: 'The answer.' },
      ],
    };
    const t = transport();
    const registry = { ...GENERIC_TUTORIAL_STEPS, handOver: GENERIC_TUTORIAL_STEPS.point };
    renderRunner(t, undefined, { using: hostSend, registry });
    begin('opening');
    jumpTo('answer');
    await waitFor(() => expect(useTutorialStore.getState().active?.stepId).toBe('answer'));
    expect(t.advance.mock.calls.map(([input]) => input.turn)).toEqual([0, 1]);
  });

  it("replaces another step's pasted prompt with the landing step's own", async () => {
    const prompted: TutorialScript = {
      id: 'demo',
      steps: [
        { id: 'intro', type: 'point', body: 'Here is the problem.' },
        { id: 'ask', type: 'prompt', body: 'Send the question.', turn: 1, prompt: 'What next?' },
        { id: 'answer', type: 'point', body: 'The answer.' },
        { id: 'ask-more', type: 'prompt', body: 'Ask again.', turn: 2, prompt: 'And after that?' },
      ],
    };
    mockInput.chatInputValue = 'What next?';
    mockInput.setChatInputValue.mockImplementation((value: string) => {
      mockInput.chatInputValue = value;
    });
    renderRunner(transport(), [], { using: prompted });
    begin('answer');
    jumpTo('ask-more');
    await waitFor(() => expect(useTutorialStore.getState().active?.stepId).toBe('ask-more'));
    expect(mockInput.chatInputValue).toBe('And after that?');
    expect(mockInput.setDraft).toHaveBeenLastCalledWith('s1', 'And after that?');
  });

  it('keeps what the user typed when a jump lands on a prompt step', async () => {
    const prompted: TutorialScript = {
      id: 'demo',
      steps: [
        { id: 'intro', type: 'point', body: 'Here is the problem.' },
        { id: 'ask', type: 'prompt', body: 'Send the question.', turn: 1, prompt: 'What next?' },
      ],
    };
    mockInput.chatInputValue = 'my own words';
    renderRunner(transport(), [], { using: prompted });
    begin('intro');
    jumpTo('ask');
    await waitFor(() => expect(useTutorialStore.getState().active?.stepId).toBe('ask'));
    expect(mockInput.setChatInputValue).not.toHaveBeenCalled();
    expect(mockInput.setDraft).not.toHaveBeenCalled();
  });

  it("keeps the current step's prompt when a jump lands on the step the user is on", async () => {
    const prompted: TutorialScript = {
      id: 'demo',
      steps: [
        { id: 'intro', type: 'point', body: 'Here is the problem.' },
        { id: 'ask', type: 'prompt', body: 'Send the question.', turn: 1, prompt: 'What next?' },
      ],
    };
    mockInput.chatInputValue = 'What next?';
    const t = transport();
    renderRunner(t, [], { using: prompted });
    begin('ask');
    jumpTo('ask');
    await waitFor(() =>
      expect(t.position).toHaveBeenLastCalledWith({ moduleId: 'demo', stepId: 'ask', status: 'in_progress' })
    );
    expect(mockInput.setChatInputValue).not.toHaveBeenCalledWith('');
    expect(mockInput.setDraft).not.toHaveBeenCalledWith('s1', '');
  });

  it('lands where the host says the page can stand, and says so', async () => {
    const landOn = vi.fn(() => 'answer');
    renderRunner(transport(), undefined, { using: twoTurns, landOn });
    begin('intro');
    jumpTo('wrap');
    await waitFor(() => expect(useTutorialStore.getState().active?.stepId).toBe('answer'));
    expect(landOn).toHaveBeenCalledWith('wrap', 's1');
    expect(mockToast).toHaveBeenCalledWith(LANDED_EARLIER_NOTICE);
  });

  it('goes back to an earlier step', async () => {
    const t = transport();
    renderRunner(t, undefined, { using: twoTurns });
    begin('wrap');
    jumpTo('opening');
    await waitFor(() => expect(useTutorialStore.getState().active?.stepId).toBe('opening'));
    expect(t.advance).not.toHaveBeenCalled();
  });

  it('stays put and says so when a turn fails to seed', async () => {
    const t = transport();
    t.advance.mockRejectedValueOnce(new Error('409'));
    renderRunner(t, undefined, { using: twoTurns });
    begin('intro');
    jumpTo('wrap');
    await waitFor(() => expect(mockToast).toHaveBeenCalledWith(JUMP_FAILED_NOTICE));
    expect(useTutorialStore.getState().active?.stepId).toBe('intro');
  });

  it('leaves a jump into another module for that module', () => {
    const t = transport();
    renderRunner(t, undefined, { using: twoTurns });
    begin('intro');
    jumpTo('wrap', 'other');
    expect(useTutorialStore.getState().pendingJump).toEqual({ moduleId: 'other', stepId: 'wrap' });
    expect(useTutorialStore.getState().active?.stepId).toBe('intro');
  });

  it('opens the steps from the card', () => {
    const onShowSteps = vi.fn();
    renderRunner(transport(), undefined, { onShowSteps });
    begin('ask');
    expect(screen.getByTestId('tutorial-coach-steps')).toHaveTextContent('Step 2 of 3');
    fireEvent.click(screen.getByTestId('tutorial-coach-steps'));
    expect(onShowSteps).toHaveBeenCalled();
  });

  it('counts the steps without the closing bridge', () => {
    const closing: TutorialScript = {
      ...script,
      steps: [...script.steps, { id: 'bridge', type: 'bridge', body: 'Carry on?' }],
    };
    renderRunner(transport(), undefined, { using: closing, onShowSteps: vi.fn() });
    begin('ask');
    expect(screen.getByTestId('tutorial-coach-steps')).toHaveTextContent('Step 2 of 3');
  });

  it('numbers the first step too', () => {
    renderRunner(transport(), undefined, { onShowSteps: vi.fn() });
    begin('intro');
    expect(screen.getByTestId('tutorial-coach-steps')).toHaveTextContent('Step 1 of 3');
  });

  it('reports progress for a step, and none for the bridge', () => {
    const closing: TutorialScript = { ...script, steps: [...script.steps, { id: 'bridge', type: 'bridge', body: '' }] };
    expect(stepProgress(closing, 'intro')).toEqual({ index: 1, count: 3 });
    expect(stepProgress(closing, 'bridge')).toBeUndefined();
  });
});

describe('the bridge step', () => {
  const bridged: TutorialScript = {
    id: 'demo',
    steps: [{ id: 'bridge', type: 'bridge', layout: 'panel', title: 'All done', body: 'Carry on?', action: 'Close' }],
  };

  it('closes on its action by default, finishing the module', () => {
    const t = transport();
    renderRunner(t, undefined, { using: bridged });
    begin('bridge');
    expect(screen.getByTestId('tutorial-step-next')).toHaveTextContent('Close');
    fireEvent.click(screen.getByTestId('tutorial-step-next'));
    expect(t.position).toHaveBeenCalledWith({ moduleId: 'demo', stepId: 'bridge', status: 'finished' });
    expect(useTutorialStore.getState().active).toBeNull();
  });

  it('finishes the module when the user closes the card, with no paused notice', () => {
    const t = transport();
    renderRunner(t, undefined, { using: bridged });
    begin('bridge');
    // The panel's X is its only close: it does not hide to a pill, and there is no separate Leave.
    expect(screen.queryByTestId('tutorial-coach-hide')).toBeNull();
    expect(screen.getAllByTestId('tutorial-coach-leave')).toHaveLength(1);
    fireEvent.click(screen.getByTestId('tutorial-coach-leave'));
    expect(screen.queryByTestId('tutorial-coach-pill')).toBeNull();
    expect(t.position).toHaveBeenCalledWith({ moduleId: 'demo', stepId: 'bridge', status: 'finished' });
    expect(useTutorialStore.getState().active).toBeNull();
    expect(mockToast).not.toHaveBeenCalledWith(PAUSED_NOTICE);
  });

  it('opens a panel step over the page on a scrim, as a modal dialog', () => {
    renderRunner(transport(), undefined, { using: bridged });
    begin('bridge');
    expect(screen.getByTestId('tutorial-coach-card')).toHaveAttribute('data-layout', 'panel');
    expect(screen.getByTestId('tutorial-panel-scrim')).toBeInTheDocument();
    expect(screen.getByRole('dialog', { name: 'All done' })).toHaveAttribute(a11yAttr('ariaModal'), 'true');
  });

  it('keeps a step that is not a panel non-modal, with no scrim', () => {
    const t = transport();
    renderRunner(t);
    begin(script.steps[0].id);
    expect(screen.getByTestId('tutorial-coach-card')).not.toHaveAttribute(a11yAttr('ariaModal'));
    expect(screen.queryByTestId('tutorial-panel-scrim')).toBeNull();
  });

  it('hands a host renderer the ways on: the module is finished before either runs', () => {
    const t = transport();
    const onStartModule = vi.fn(() => expect(useTutorialStore.getState().active).toBeNull());
    const onExit = vi.fn(() => expect(useTutorialStore.getState().active).toBeNull());
    const Closing = ({ complete, startModule, exit }: TutorialStepProps) => (
      <>
        <button
          data-testid="next"
          onClick={() => {
            complete();
            startModule?.('more');
          }}
        />
        <button
          data-testid="own"
          onClick={() => {
            complete();
            exit?.();
          }}
        />
      </>
    );
    const registry = { ...GENERIC_TUTORIAL_STEPS, bridge: Closing };
    renderRunner(t, undefined, { using: bridged, onStartModule, onExit, registry });
    begin('bridge');
    fireEvent.click(screen.getByTestId('next'));
    expect(t.position).toHaveBeenCalledWith({ moduleId: 'demo', stepId: 'bridge', status: 'finished' });
    expect(onStartModule).toHaveBeenCalledWith('more');
    begin('bridge');
    fireEvent.click(screen.getByTestId('own'));
    expect(onExit).toHaveBeenCalled();
  });

  it('heads the bridge with the finished chain rather than a step number, which the steps list leaves out', () => {
    renderRunner(transport(), undefined, { using: bridged, onShowSteps: vi.fn() });
    begin('bridge');
    expect(screen.getByTestId('tutorial-coach-steps')).toHaveTextContent('Quest chain complete');
  });

  it('counts the module steps in the bridge heading', () => {
    const closing: TutorialScript = { ...script, steps: [...script.steps, ...bridged.steps] };
    renderRunner(transport(), undefined, { using: closing });
    begin('bridge');
    expect(screen.getByTestId('tutorial-coach-progress')).toHaveTextContent('Quest chain complete: all 3 steps');
  });
});

describe('the dismiss step', () => {
  const closing: TutorialScript = {
    id: 'demo',
    steps: [
      { id: 'close', type: 'dismiss', anchor: 'panel-close', body: 'Close it.' },
      { id: 'after', type: 'point', body: 'Next one.' },
    ],
  };

  it('waits for the user to close what it points at, then moves on', async () => {
    const panel = document.createElement('button');
    panel.dataset.testid = 'panel-close';
    document.body.appendChild(panel);
    renderRunner(transport(), undefined, { using: closing });
    begin('close');
    expect(useTutorialStore.getState().active?.stepId).toBe('close');
    act(() => panel.remove());
    await waitFor(() => expect(useTutorialStore.getState().active?.stepId).toBe('after'));
  });

  it('moves on once the anchor has stayed away past the grace period', async () => {
    renderRunner(transport(), undefined, { using: closing });
    begin('close');
    await waitFor(() => expect(useTutorialStore.getState().active?.stepId).toBe('after'), { timeout: 3000 });
  });
});

describe('the dismiss step anchoring', () => {
  const closing: TutorialScript = {
    id: 'demo',
    steps: [
      { id: 'close', type: 'dismiss', anchor: 'late:panel', body: 'Close it.' },
      { id: 'after', type: 'point', body: 'Next one.' },
    ],
  };

  it('waits for an anchor that renders late, and one whose id needs escaping', async () => {
    renderRunner(transport(), undefined, { using: closing });
    begin('close');
    await new Promise(resolve => setTimeout(resolve, 20));
    expect(useTutorialStore.getState().active?.stepId).toBe('close');
    const panel = document.createElement('button');
    panel.dataset.testid = 'late:panel';
    act(() => {
      document.body.appendChild(panel);
    });
    await new Promise(resolve => setTimeout(resolve, 20));
    expect(useTutorialStore.getState().active?.stepId).toBe('close');
    act(() => panel.remove());
    await waitFor(() => expect(useTutorialStore.getState().active?.stepId).toBe('after'));
  });
});

describe('position writes', () => {
  it('sends them in order, one at a time', async () => {
    const t = transport();
    const releases: Array<() => void> = [];
    t.position.mockImplementation(() => new Promise<void>(resolve => releases.push(resolve)));
    const points: TutorialScript = {
      id: 'demo',
      steps: ['a', 'b', 'c'].map(id => ({ id, type: 'point', body: id })),
    };
    renderRunner(t, undefined, { using: points });
    begin('a');
    fireEvent.click(screen.getByTestId('tutorial-step-next'));
    fireEvent.click(screen.getByTestId('tutorial-step-next'));
    expect(t.position).toHaveBeenCalledTimes(1);
    expect(t.position).toHaveBeenLastCalledWith(expect.objectContaining({ stepId: 'b' }));
    releases[0]();
    await waitFor(() => expect(t.position).toHaveBeenCalledTimes(2));
    expect(t.position).toHaveBeenLastCalledWith(expect.objectContaining({ stepId: 'c' }));
  });
});

describe('CoachMark anchoring', () => {
  it('rings the anchor once it mounts, and floats unanchored until then', async () => {
    renderRunner(transport());
    begin('wrap');
    expect(screen.queryByTestId('tutorial-anchor-ring')).toBeNull();

    const anchor = document.createElement('div');
    anchor.dataset.testid = 'answer-panel';
    act(() => {
      document.body.appendChild(anchor);
    });
    expect(await screen.findByTestId('tutorial-anchor-ring')).toBeInTheDocument();
    anchor.remove();
  });

  it('re-points at the new anchor when the step changes while the old one is still on the page', async () => {
    const two: TutorialScript = {
      id: 'demo',
      steps: [
        { id: 'a', type: 'point', body: 'First.', anchor: 'first-target' },
        { id: 'b', type: 'point', body: 'Second.', anchor: 'second-target' },
      ],
    };
    const first = document.createElement('div');
    first.dataset.testid = 'first-target';
    const second = document.createElement('div');
    second.dataset.testid = 'second-target';
    document.body.append(first, second);
    second.getBoundingClientRect = () =>
      ({ top: 200, bottom: 240, left: 10, right: 50, width: 40, height: 40 }) as DOMRect;
    renderRunner(transport(), undefined, { using: two });
    begin('a');
    await screen.findByTestId('tutorial-anchor-ring');

    begin('b');
    await waitFor(() => expect(screen.getByTestId('tutorial-anchor-ring')).toHaveStyle({ top: '194px' }));
    first.remove();
    second.remove();
  });

  it('scrolls an anchor that sits below the fold into view', async () => {
    const scroll = vi.fn();
    const anchor = document.createElement('div');
    anchor.dataset.testid = 'answer-panel';
    anchor.scrollIntoView = scroll;
    anchor.getBoundingClientRect = () =>
      ({
        top: window.innerHeight + 50,
        bottom: window.innerHeight + 90,
        left: 0,
        right: 10,
        width: 10,
        height: 40,
      }) as DOMRect;
    document.body.appendChild(anchor);
    renderRunner(transport());
    begin('wrap');
    await waitFor(() => expect(scroll).toHaveBeenCalledWith({ block: 'center', behavior: 'smooth' }));
    anchor.remove();
  });

  it('follows an anchor that a canvas camera moves', async () => {
    const pane = document.createElement('div');
    pane.className = 'react-flow';
    const anchor = document.createElement('div');
    anchor.dataset.testid = 'answer-panel';
    let top = 200;
    anchor.getBoundingClientRect = () =>
      ({ top, bottom: top + 40, left: 10, right: 50, width: 40, height: 40 }) as DOMRect;
    pane.appendChild(anchor);
    document.body.appendChild(pane);
    renderRunner(transport());
    begin('wrap');
    await waitFor(() => expect(screen.getByTestId('tutorial-anchor-ring')).toHaveStyle({ top: '194px' }));

    top = 300;
    await waitFor(() => expect(screen.getByTestId('tutorial-anchor-ring')).toHaveStyle({ top: '294px' }));
    pane.remove();
  });

  it('docks the card on screen while the anchor stays out of view', async () => {
    const anchor = document.createElement('div');
    anchor.dataset.testid = 'answer-panel';
    anchor.scrollIntoView = vi.fn();
    anchor.getBoundingClientRect = () =>
      ({
        top: window.innerHeight + 700,
        bottom: window.innerHeight + 740,
        left: 0,
        right: 10,
        width: 10,
        height: 40,
      }) as DOMRect;
    document.body.appendChild(anchor);
    renderRunner(transport());
    begin('wrap');
    await waitFor(() =>
      expect(screen.getByTestId('tutorial-coach-card')).toHaveStyle({ right: '24px', bottom: '24px' })
    );
    expect(screen.queryByTestId('tutorial-anchor-ring')).toBeNull();
    anchor.remove();
  });

  it('docks bottom-left instead when the step prefers the left', () => {
    renderRunner(transport(), undefined, {
      using: { id: 'demo', steps: [{ id: 'aside', type: 'point', body: 'Read this.', placement: 'left' }] },
    });
    begin('aside');
    expect(screen.getByTestId('tutorial-coach-card')).toHaveStyle({ left: '24px', bottom: '24px' });
  });
});

describe('a step that walks several anchors', () => {
  function Staged({ setAnchor }: TutorialStepProps) {
    return (
      <>
        <button data-testid="go-second" onClick={() => setAnchor('second', { placement: 'right' })} />
        <button data-testid="go-scoped" onClick={() => setAnchor('item', { scope: '[data-node-id="b"]' })} />
        <button data-testid="go-back" onClick={() => setAnchor(undefined)} />
        <button data-testid="go-unscoped" onClick={() => setAnchor('loose', { scope: undefined })} />
        <button data-testid="go-avoid" onClick={() => setAnchor(undefined, { avoid: '[data-testid="blocker"]' })} />
      </>
    );
  }
  const staged: TutorialScript = {
    id: 'demo',
    steps: [{ id: 'staged', type: 'staged', body: 'Go.', anchor: 'first', placement: 'below' }],
  };
  const box = (testid: string, top: number, parent: HTMLElement = document.body) => {
    const el = document.createElement('div');
    el.dataset.testid = testid;
    el.getBoundingClientRect = () =>
      ({ top, bottom: top + 40, left: 100, right: 140, width: 40, height: 40 }) as DOMRect;
    parent.appendChild(el);
    return el;
  };
  const renderStaged = () =>
    render(
      <HostedClient client={new QueryClient()}>
        <TutorialRunner script={staged} steps={{ staged: Staged }} transport={transport()} />
      </HostedClient>
    );

  it("places the card on each stage's side, and on the step's own once the stage is cleared", async () => {
    const first = box('first', 300);
    const second = box('second', 200);
    renderStaged();
    begin('staged');
    const card = screen.getByTestId('tutorial-coach-card');
    await waitFor(() => expect(card).toHaveStyle({ top: `${340 + 6 + 12}px` }));

    fireEvent.click(screen.getByTestId('go-second'));
    await waitFor(() => expect(card).toHaveStyle({ left: `${140 + 6 + 12}px`, top: `${200 - 6}px` }));

    fireEvent.click(screen.getByTestId('go-back'));
    await waitFor(() => expect(card).toHaveStyle({ top: `${340 + 6 + 12}px` }));
    first.remove();
    second.remove();
  });

  it('keeps the card clear of what a stage avoids', async () => {
    const realRect = HTMLElement.prototype.getBoundingClientRect;
    HTMLElement.prototype.getBoundingClientRect = function (this: HTMLElement) {
      return (
        this.dataset.testid === 'tutorial-coach-card'
          ? { top: 0, bottom: 100, left: 0, right: 340, width: 340, height: 100 }
          : { top: 0, bottom: 0, left: 0, right: 0, width: 0, height: 0 }
      ) as DOMRect;
    };
    const first = box('first', 300);
    const blocker = document.createElement('div');
    blocker.dataset.testid = 'blocker';
    blocker.getBoundingClientRect = () =>
      ({ top: 352, bottom: 600, left: 0, right: 1000, width: 1000, height: 248 }) as DOMRect;
    document.body.appendChild(blocker);
    try {
      renderStaged();
      begin('staged');
      const card = screen.getByTestId('tutorial-coach-card');
      await waitFor(() => expect(card).toHaveStyle({ top: `${340 + 6 + 12}px` }));

      fireEvent.click(screen.getByTestId('go-avoid'));
      await waitFor(() => expect(card).toHaveStyle({ top: `${600 + 12}px` }));
    } finally {
      HTMLElement.prototype.getBoundingClientRect = realRect;
      first.remove();
      blocker.remove();
    }
  });

  it("finds a stage's anchor inside the stage's own scope", async () => {
    const a = document.createElement('div');
    a.dataset.nodeId = 'a';
    const b = document.createElement('div');
    b.dataset.nodeId = 'b';
    document.body.append(a, b);
    box('item', 100, a);
    box('item', 400, b);
    renderStaged();
    begin('staged');
    fireEvent.click(screen.getByTestId('go-scoped'));
    await waitFor(() => expect(screen.getByTestId('tutorial-anchor-ring')).toHaveStyle({ top: '394px' }));
    a.remove();
    b.remove();
  });

  it("searches the whole page when a stage clears the step's scope", async () => {
    const node = document.createElement('div');
    node.dataset.nodeId = 'a';
    document.body.append(node);
    box('first', 300, node);
    const loose = box('loose', 150);
    render(
      <HostedClient client={new QueryClient()}>
        <TutorialRunner
          script={{ id: 'demo', steps: [{ ...staged.steps[0], anchorScope: '[data-node-id="a"]' }] }}
          steps={{ staged: Staged }}
          transport={transport()}
        />
      </HostedClient>
    );
    begin('staged');
    fireEvent.click(screen.getByTestId('go-unscoped'));
    await waitFor(() => expect(screen.getByTestId('tutorial-anchor-ring')).toHaveStyle({ top: '144px' }));
    node.remove();
    loose.remove();
  });
});

describe('the attach step', () => {
  const withAttach: TutorialScript = {
    id: 'demo',
    steps: [
      { id: 'attach', type: 'attach', body: 'Attach it.', anchor: 'clip', params: { fileName: 'sheet.csv' } },
      { id: 'wrap', type: 'point', body: 'Done.' },
    ],
  };
  const mount = (testid: string) => {
    const el = document.createElement('div');
    el.setAttribute('data-testid', testid);
    document.body.appendChild(el);
    return el;
  };

  it("walks the attach flow a control at a time, and moves on once the module's sheet is in the session", async () => {
    const t = transport();
    const { rerenderWith } = renderRunner(t, [], { using: withAttach });
    begin('attach');
    expect(screen.getByTestId('tutorial-attach-hint')).toHaveTextContent('+ button');
    await waitFor(() => expect(t.sheet).toHaveBeenCalledWith({ moduleId: 'demo' }));

    const menu = mount('add-from-file-browser-btn');
    await waitFor(() => expect(screen.getByTestId('tutorial-attach-hint')).toHaveTextContent('File Browser'));
    const dialog = mount('file-browser-dialog');
    await waitFor(() => expect(screen.getByTestId('tutorial-attach-hint')).toHaveTextContent('Select sheet.csv'));

    mockFiles.current = [{ id: 'other' }];
    rerenderWith([]);
    expect(useTutorialStore.getState().active?.stepId).toBe('attach');
    mockFiles.current = [{ id: 'sheet-1' }];
    rerenderWith([]);
    await waitFor(() => expect(useTutorialStore.getState().active?.stepId).toBe('wrap'));
    menu.remove();
    dialog.remove();
  });

  it('rings the sheet in the File Browser, then names the Add button as it reads once it is selected', async () => {
    const t = transport();
    renderRunner(t, [], { using: withAttach });
    begin('attach');
    await waitFor(() => expect(t.sheet).toHaveBeenCalled());
    const dialog = mount('file-browser-dialog');
    const card = document.createElement('div');
    card.setAttribute('data-testid', 'recent-file-sheet-1');
    dialog.appendChild(card);
    const add = document.createElement('button');
    add.setAttribute('data-testid', 'file-browser-add-files-btn');
    add.disabled = true;
    add.textContent = 'Add Files';
    const click = vi.fn();
    add.addEventListener('click', click);
    dialog.appendChild(add);
    await waitFor(() => expect(screen.getByTestId('tutorial-attach-hint')).toHaveTextContent(/^Select sheet\.csv\.$/));
    expect(useTutorialStore.getState().active?.stepId).toBe('attach');

    add.disabled = false;
    await waitFor(() =>
      expect(screen.getByTestId('tutorial-attach-hint')).toHaveTextContent(/^Press Add Files to add sheet\.csv\.$/)
    );
    add.firstChild!.nodeValue = 'Add 1 File to Notebook';
    await waitFor(() =>
      expect(screen.getByTestId('tutorial-attach-hint')).toHaveTextContent(
        /^Press Add 1 File to Notebook to add sheet\.csv\.$/
      )
    );
    expect(click).not.toHaveBeenCalled();
    dialog.remove();
  });

  it('says so when the sheet lookup fails, and looks again on request', async () => {
    const t = transport();
    t.sheet.mockRejectedValueOnce(new Error('503'));
    renderRunner(t, [], { using: withAttach });
    begin('attach');
    await waitFor(() => expect(screen.getByTestId('tutorial-attach-hint')).toHaveTextContent('Could not look up'));
    fireEvent.click(screen.getByTestId('tutorial-attach-retry'));
    await waitFor(() => expect(screen.getByTestId('tutorial-attach-hint')).toHaveTextContent('+ button'));
    expect(t.sheet).toHaveBeenCalledTimes(2);
  });
});

describe('readAttachCue', () => {
  const el = (testid: string, parent: HTMLElement = document.body, text = '') => {
    const node = document.createElement(testid.endsWith('-btn') ? 'button' : 'div');
    node.setAttribute('data-testid', testid);
    node.textContent = text;
    parent.appendChild(node);
    return node;
  };
  const row = (dialog: HTMLElement, name: string) => {
    const item = el('file-browser-list-item', dialog);
    el('file-browser-item-name', item, name);
    return item;
  };
  const browser = () => {
    const dialog = el('file-browser-dialog');
    const add = el('file-browser-add-files-btn', dialog, 'Add Files') as HTMLButtonElement;
    add.disabled = true;
    return { dialog, add };
  };
  beforeEach(() => {
    document.body.innerHTML = '';
  });

  it('points at the + button, then the File Browser entry', () => {
    expect(readAttachCue('f1', 'a.csv')).toEqual({ anchor: undefined, hint: expect.stringContaining('+ button') });
    el('add-from-file-browser-btn');
    expect(readAttachCue('f1', 'a.csv')).toMatchObject({ anchor: 'add-from-file-browser-btn', placement: 'right' });
  });

  it("rings the sheet's Recent card by its file id", () => {
    const { dialog } = browser();
    el('recent-file-f1', dialog, 'a.csv');
    expect(readAttachCue('f1', 'a.csv')).toEqual({ anchor: 'recent-file-f1', hint: 'Select a.csv.' });
  });

  it('rings the first list row only when it is the sheet, and asks for a search otherwise', () => {
    const { dialog } = browser();
    el('file-browser-search-input', dialog);
    const other = row(dialog, 'other.csv');
    row(dialog, 'a.csv');
    expect(readAttachCue('f1', 'a.csv')).toEqual({
      anchor: 'file-browser-search-input',
      hint: 'Search for a.csv, then select it.',
    });
    other.remove();
    expect(readAttachCue('f1', 'a.csv')).toEqual({ anchor: 'file-browser-list-item', hint: 'Select a.csv.' });
  });

  it('does not take a longer name for the sheet', () => {
    const { dialog } = browser();
    row(dialog, 'old-a.csv');
    expect(readAttachCue('f1', 'a.csv').anchor).toBe('file-browser-add-files-btn');
  });

  const card = (dialog: HTMLElement, name: string) => {
    const item = el('file-browser-grid-item-card', dialog);
    const title = document.createElement('p');
    title.setAttribute('title', name);
    title.textContent = name;
    item.appendChild(title);
    return item;
  };

  it('rings a grid card that shows the sheet', () => {
    const { dialog } = browser();
    card(dialog, 'a.csv');
    expect(readAttachCue('f1', 'a.csv').anchor).toBe('file-browser-grid-item-card');
  });

  it('does not take a longer grid card name for the sheet', () => {
    const { dialog } = browser();
    card(dialog, 'old-a.csv');
    expect(readAttachCue('f1', 'a.csv').anchor).toBe('file-browser-add-files-btn');
  });

  it('falls back to the Add button, named as it reads, when neither the sheet nor a search box is found', () => {
    browser();
    expect(readAttachCue(null, 'a.csv')).toEqual({
      anchor: 'file-browser-add-files-btn',
      hint: 'Select a.csv, then press Add 1 File to Notebook.',
    });
  });

  it('rings Add once a file is selected, quoting its label', () => {
    const { dialog, add } = browser();
    el('recent-file-f1', dialog, 'a.csv');
    add.disabled = false;
    add.textContent = 'Add 1 File to Notebook';
    expect(readAttachCue('f1', 'a.csv')).toEqual({
      anchor: 'file-browser-add-files-btn',
      hint: 'Press Add 1 File to Notebook to add a.csv.',
    });
  });
});

describe('Agent mode on a prompt step', () => {
  const mount = (testid: string) => {
    const el = document.createElement('button');
    el.setAttribute('data-testid', testid);
    document.body.appendChild(el);
    return el;
  };
  const hint = () => screen.queryByTestId('tutorial-agent-mode-hint');
  const ring = () => screen.queryByTestId('tutorial-anchor-ring');

  it('asks the user to switch Agent mode off, pointing at the + button and then the switch, and never flips it', async () => {
    mockAgent.toggle = true;
    const send = mount('send-btn');
    const { rerenderWith } = renderRunner(transport(), []);
    begin('ask');
    expect(hint()).toHaveTextContent('Press the + button');
    expect(ring()).not.toBeInTheDocument();

    const clip = mount('attach-files-btn');
    await waitFor(() => expect(ring()).toBeInTheDocument());
    const toggle = mount('attach-menu-agent-mode-switch');
    await waitFor(() => expect(hint()).toHaveTextContent('Switch Agent mode off.'));
    clip.remove();
    expect(ring()).toBeInTheDocument();

    mockAgent.toggle = false;
    rerenderWith([]);
    expect(hint()).not.toBeInTheDocument();
    toggle.remove();
    await waitFor(() => expect(ring()).toBeInTheDocument());
    expect(useTutorialStore.getState().active?.stepId).toBe('ask');
    send.remove();
  });

  it('sends a user whose Smart Routing is always on to their settings, ringing nothing', () => {
    mockAgent.default = 'on';
    const send = mount('send-btn');
    renderRunner(transport(), []);
    begin('ask');
    expect(hint()).toHaveTextContent('Smart Routing');
    expect(ring()).not.toBeInTheDocument();
    send.remove();
  });

  it('says nothing when Agent mode is not available to the user, or the turn is already sent', () => {
    mockAgent.feature = false;
    mockAgent.toggle = true;
    const { rerenderWith } = renderRunner(transport(), []);
    begin('ask');
    expect(hint()).not.toBeInTheDocument();

    mockAgent.feature = true;
    rerenderWith([{ id: 'u1', prompt: 'What next?', status: 'running' }]);
    expect(hint()).not.toBeInTheDocument();
  });
});

describe('hasForeignQuest', () => {
  it('counts only settled, unmarked quests', () => {
    expect(hasForeignQuest(undefined)).toBe(false);
    expect(hasForeignQuest([marked('a'), { id: 'b', _optimistic: true }])).toBe(false);
    expect(hasForeignQuest([marked('a'), { id: 'r', status: 'running' }])).toBe(false);
    expect(hasForeignQuest([marked('a'), { id: 'c', uiSideEffects: null }])).toBe(true);
  });
});

describe('a module that moved under a running walk', () => {
  const refused = (status: number, code?: string) =>
    Object.assign(new Error(String(status)), { response: { status, data: { code } } });
  const beginAt = (stepId: string) =>
    act(() =>
      useTutorialStore.getState().begin({ moduleId: 'demo', sessionId: 's1', stepId, version: 3, revision: 1 })
    );

  it('reports the version and revision the walk started under', async () => {
    const t = transport();
    renderRunner(t);
    beginAt('intro');
    fireEvent.click(screen.getByTestId('tutorial-step-next'));
    await waitFor(() =>
      expect(t.position).toHaveBeenCalledWith({
        moduleId: 'demo',
        stepId: 'ask',
        status: 'in_progress',
        version: 3,
        revision: 1,
      })
    );
  });

  it.each([
    ['switched off', refused(410, 'MODULE_OFF'), OFF_NOTICE, false],
    ['changed', refused(409, 'VERSION_CHANGED'), CHANGED_NOTICE, true],
  ])('ends the walk when a position report says the module was %s', async (_label, error, notice, offersStart) => {
    const t = transport();
    t.position.mockRejectedValueOnce(error);
    const onChanged = vi.fn();
    const onStartModule = vi.fn();
    renderRunner(t, undefined, { onChanged, onStartModule });
    beginAt('intro');
    fireEvent.click(screen.getByTestId('tutorial-step-next'));
    await waitFor(() => expect(useTutorialStore.getState().active).toBeNull());
    expect(onChanged).toHaveBeenCalledTimes(1);
    const [message, options] = mockToast.mock.calls.at(-1)!;
    expect(message).toBe(notice);
    expect(options).toMatchObject({ testId: 'tutorial-updated-notice' });
    expect(Boolean(options.action)).toBe(offersStart);
  });

  it('keeps walking on a refusal that is not about the module', async () => {
    const t = transport();
    t.position.mockRejectedValueOnce(refused(409));
    renderRunner(t);
    beginAt('intro');
    fireEvent.click(screen.getByTestId('tutorial-step-next'));
    await waitFor(() => expect(t.position).toHaveBeenCalled());
    expect(useTutorialStore.getState().active?.stepId).toBe('ask');
    expect(mockToast).not.toHaveBeenCalled();
  });

  it('says nothing when leaving is refused', async () => {
    const t = transport();
    t.position.mockRejectedValue(refused(410, 'MODULE_OFF'));
    const onChanged = vi.fn();
    renderRunner(t, undefined, { onChanged });
    beginAt('intro');
    fireEvent.click(screen.getByTestId('tutorial-coach-leave'));
    await waitFor(() => expect(t.position).toHaveBeenCalledWith(expect.objectContaining({ status: 'left' })));
    expect(onChanged).not.toHaveBeenCalled();
  });

  it.each([
    ['switched off', refused(404), OFF_NOTICE],
    ['changed', refused(409, 'VERSION_CHANGED'), CHANGED_NOTICE],
  ])('ends a jump with the updated notice when the module was %s', async (_label, error, notice) => {
    const t = transport();
    t.advance.mockRejectedValueOnce(error);
    const onChanged = vi.fn();
    renderRunner(t, undefined, { onChanged });
    beginAt('intro');
    act(() => useTutorialStore.getState().requestJump({ moduleId: 'demo', stepId: 'wrap' }));
    await waitFor(() => expect(mockToast).toHaveBeenCalledWith(notice, expect.anything()));
    expect(mockToast).not.toHaveBeenCalledWith(JUMP_FAILED_NOTICE);
    expect(useTutorialStore.getState().active).toBeNull();
    expect(onChanged).toHaveBeenCalledTimes(1);
  });
});
