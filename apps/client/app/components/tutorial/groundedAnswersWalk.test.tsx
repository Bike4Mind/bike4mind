import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

const mockInput = vi.hoisted(() => ({
  chatInputValue: '',
  setDraft: vi.fn(),
  setChatInputValue: vi.fn(),
  requestFocus: vi.fn(),
  clearDraft: vi.fn(),
}));
const mockFiles = vi.hoisted(() => ({ current: [] as { id: string }[] }));
vi.mock('@client/app/utils/react-query', () => ({ setOptimisticQueryData: vi.fn() }));
vi.mock('@client/app/hooks/useChatInput', () => ({
  useChatInput: { getState: () => mockInput, subscribe: () => () => undefined },
}));
vi.mock('@client/app/contexts/SessionsContext', () => ({ useWorkBenchFiles: () => mockFiles.current }));
vi.mock('sonner', () => ({ toast: vi.fn() }));
vi.mock('@client/app/contexts/LLMContext', () => ({
  useLLM: (select: (state: { agentMode: { enabled: boolean } }) => unknown) =>
    select({ agentMode: { enabled: false } }),
}));
vi.mock('@client/app/contexts/UserSettingsContext', () => ({
  useUserSettings: () => ({ settings: { agentModeDefault: 'off' } }),
}));
vi.mock('@client/app/hooks/useFeatureEnabled', () => ({
  useFeatureEnabled: () => ({ isFeatureEnabled: () => false }),
}));

import { TUTORIAL_MARKER_TYPE } from '@bike4mind/common';
import { GROUNDED_ANSWERS_STEPS } from '@bike4mind/server-utils/tutorials/modules/grounded-answers/steps';
import transcript from '../../../../../packages/server-utils/src/tutorials/modules/grounded-answers/transcript.json';
import { GENERIC_TUTORIAL_STEPS } from './genericSteps';
import { TutorialRunner } from './TutorialRunner';
import { TutorialHostProvider } from './TutorialHostContext';
import type { TutorialQuest, TutorialScript, TutorialTransport } from './types';
import { tutorialStoreFor } from './useTutorialStore';

const BASE = '/api/test-tutorials';
const MODULE_ID = 'grounded-answers';
const SHEET_FILE_ID = 'sheet-1';
const script: TutorialScript = { id: MODULE_ID, steps: GROUNDED_ANSWERS_STEPS };
const [ATTACH, ASK, CHECK, DONE] = GROUNDED_ANSWERS_STEPS.map(step => step.id);
const store = () => tutorialStoreFor(BASE).getState();
const activeStepId = () => store().active?.stepId;

const answered = (turn: number): TutorialQuest => ({
  id: `q${turn}`,
  status: 'done',
  uiSideEffects: [{ type: TUTORIAL_MARKER_TYPE, payload: { turn } }],
});

function transport() {
  return {
    progress: vi.fn(async () => ({})),
    start: vi.fn(async () => ({ sessionId: 's1' })),
    resume: vi.fn(async () => ({ sessionId: 's1' })),
    sheet: vi.fn(async () => ({ fileId: SHEET_FILE_ID })),
    advance: vi.fn(async () => ({ quest: answered(0) })),
    position: vi.fn(async () => undefined),
  } satisfies TutorialTransport;
}

function renderWalk(t: TutorialTransport, quests: TutorialQuest[] = []) {
  const client = new QueryClient();
  const ui = (q: TutorialQuest[]) => (
    <QueryClientProvider client={client}>
      <TutorialHostProvider apiBase={BASE}>
        <TutorialRunner script={script} steps={GENERIC_TUTORIAL_STEPS} transport={t} quests={q} skippable />
      </TutorialHostProvider>
    </QueryClientProvider>
  );
  const view = render(ui(quests));
  return { rerenderWith: (q: TutorialQuest[]) => view.rerender(ui(q)) };
}

const begin = (stepId: string) => act(() => store().begin({ moduleId: MODULE_ID, sessionId: 's1', stepId }));
const skip = () => fireEvent.click(screen.getByTestId('tutorial-coach-skip'));

beforeEach(() => {
  store().end();
  store().clearJump();
  Object.values(mockInput).forEach(value => typeof value === 'function' && 'mockReset' in value && value.mockReset());
  mockInput.chatInputValue = '';
  mockFiles.current = [];
});

describe('grounded-answers tutorial walk', () => {
  it('ships the module content the walk depends on', () => {
    expect(GROUNDED_ANSWERS_STEPS.map(step => step.type)).toEqual(['attach', 'prompt', 'point', 'bridge']);
    expect(transcript[0].prompt).toBe(GROUNDED_ANSWERS_STEPS[1].prompt);
  });

  it('walks attach, ask, check and done, each finishing on its own event', async () => {
    const t = transport();
    const { rerenderWith } = renderWalk(t);
    begin(ATTACH);
    expect(screen.getByTestId('tutorial-attach-hint')).toBeInTheDocument();
    await waitFor(() => expect(t.sheet).toHaveBeenCalledWith({ moduleId: MODULE_ID }));
    expect(activeStepId()).toBe(ATTACH);

    mockFiles.current = [{ id: SHEET_FILE_ID }];
    rerenderWith([]);
    await waitFor(() => expect(activeStepId()).toBe(ASK));

    // Prefilled on arrival, as every prompt step is: no "Paste the message" press first.
    expect(mockInput.setChatInputValue).toHaveBeenCalledWith(transcript[0].prompt);
    rerenderWith([{ id: 'u0', prompt: transcript[0].prompt, status: 'running' }]);
    expect(activeStepId()).toBe(ASK);
    rerenderWith([{ ...answered(0), prompt: transcript[0].prompt }]);
    await waitFor(() => expect(activeStepId()).toBe(CHECK));

    fireEvent.click(screen.getByTestId('tutorial-step-next'));
    expect(activeStepId()).toBe(DONE);
    expect(t.position).toHaveBeenLastCalledWith({ moduleId: MODULE_ID, stepId: DONE, status: 'in_progress' });
    // The finale offers only Done.
    expect(screen.queryByTestId('tutorial-coach-leave')).toBeNull();
    expect(screen.queryByTestId('tutorial-coach-skip')).toBeNull();

    fireEvent.click(screen.getByTestId('tutorial-step-next'));
    await waitFor(() => expect(store().active).toBeNull());
    expect(t.position).toHaveBeenLastCalledWith({ moduleId: MODULE_ID, stepId: DONE, status: 'finished' });
  });

  it('does not move past attach for a file other than the sheet', async () => {
    const t = transport();
    mockFiles.current = [{ id: 'someone-elses-file' }];
    renderWalk(t);
    begin(ATTACH);
    await waitFor(() => expect(t.sheet).toHaveBeenCalled());
    expect(activeStepId()).toBe(ATTACH);
  });

  it('reaches the closing card by skipping every step, seeding turn 0 on the way', async () => {
    const t = transport();
    renderWalk(t);
    begin(ATTACH);
    skip();
    await waitFor(() => expect(activeStepId()).toBe(ASK));
    skip();
    await waitFor(() => expect(activeStepId()).toBe(CHECK));
    expect(t.advance).toHaveBeenCalledTimes(1);
    expect(t.advance).toHaveBeenCalledWith({ moduleId: MODULE_ID, sessionId: 's1', turn: 0 });
    skip();
    await waitFor(() => expect(activeStepId()).toBe(DONE));
    expect(screen.getByTestId('tutorial-step-next')).toHaveTextContent('Done');
    expect(screen.queryByTestId('tutorial-coach-skip')).toBeNull();
  });

  it.each([
    ['attach', ATTACH],
    ['prompt', ASK],
    ['point', CHECK],
  ])('offers Skip on the %s step', (_type, stepId) => {
    renderWalk(transport());
    begin(stepId);
    expect(screen.getByTestId('tutorial-coach-skip')).toBeInTheDocument();
  });
});
