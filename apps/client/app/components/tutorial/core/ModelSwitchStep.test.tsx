import { act, render } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { TutorialStep } from '@bike4mind/common';
import type { TutorialStepProps } from '../types';

const { llm } = vi.hoisted(() => {
  type State = { model: string; hasExplicitSessionModelSelection: boolean };
  type Listener = (state: State, prior: State) => void;
  let state: State = { model: 'model-a', hasExplicitSessionModelSelection: false };
  const listeners = new Set<Listener>();
  return {
    llm: {
      getState: () => state,
      setState: (patch: Partial<State>) => {
        const prior = state;
        state = { ...state, ...patch };
        listeners.forEach(listener => listener(state, prior));
      },
      subscribe: (listener: Listener) => {
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
      reset: () => {
        state = { model: 'model-a', hasExplicitSessionModelSelection: false };
        listeners.clear();
      },
    },
  };
});

vi.mock('@client/app/contexts/LLMContext', () => ({ useLLM: llm }));

import { MODEL_PICKER_MODAL, ModelSwitchStep } from './ModelSwitchStep';

const STEP: TutorialStep = {
  id: 'switch',
  type: 'model-switch',
  body: 'Pick another model.',
  anchor: 'ai-settings-btn',
};

function renderStep() {
  const props = {
    step: STEP,
    sessionId: 's1',
    quests: [],
    complete: vi.fn(),
    advance: vi.fn(),
    setAnchor: vi.fn(),
    markDone: vi.fn(),
    sheetFileId: vi.fn(),
  } satisfies TutorialStepProps;
  const view = render(<ModelSwitchStep {...props} />);
  return { ...props, ...view };
}

function openPicker() {
  const modal = document.createElement('div');
  modal.dataset.testid = MODEL_PICKER_MODAL;
  document.body.appendChild(modal);
  return modal;
}

afterEach(() => {
  llm.reset();
  document.body.innerHTML = '';
});

describe('ModelSwitchStep', () => {
  it('completes when the user picks a different model', () => {
    const { complete } = renderStep();
    act(() => llm.setState({ model: 'model-b', hasExplicitSessionModelSelection: true }));
    expect(complete).toHaveBeenCalledTimes(1);
  });

  it('ignores a model the notebook restores on load', () => {
    const { complete } = renderStep();
    act(() => llm.setState({ model: 'model-pinned', hasExplicitSessionModelSelection: false }));
    expect(complete).not.toHaveBeenCalled();
  });

  it('ignores a store write that keeps the same model', () => {
    llm.setState({ hasExplicitSessionModelSelection: true });
    const { complete } = renderStep();
    act(() => llm.setState({ hasExplicitSessionModelSelection: true }));
    expect(complete).not.toHaveBeenCalled();
  });

  it('docks the card and shortens it while the picker is open, then points back at the button', async () => {
    const { setAnchor, markDone } = renderStep();
    expect(setAnchor).toHaveBeenLastCalledWith(undefined);
    expect(markDone).toHaveBeenLastCalledWith(false);

    let modal: HTMLElement | undefined;
    await act(async () => {
      modal = openPicker();
    });
    expect(setAnchor).toHaveBeenLastCalledWith('');
    expect(markDone).toHaveBeenLastCalledWith(true);

    await act(async () => modal?.remove());
    expect(setAnchor).toHaveBeenLastCalledWith(undefined);
    expect(markDone).toHaveBeenLastCalledWith(false);
  });

  it('stops listening once the step is gone', () => {
    const { complete, unmount } = renderStep();
    unmount();
    llm.setState({ model: 'model-b', hasExplicitSessionModelSelection: true });
    expect(complete).not.toHaveBeenCalled();
  });
});
