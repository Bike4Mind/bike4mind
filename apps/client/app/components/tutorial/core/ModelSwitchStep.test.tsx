import { act, render } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ImageModels, type TutorialStep } from '@bike4mind/common';
import type { TutorialStepProps } from '../types';

const { llm, picker } = vi.hoisted(() => {
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
    picker: { open: false, listeners: new Set<() => void>() },
  };
});

vi.mock('@client/app/contexts/LLMContext', () => ({ useLLM: llm }));
vi.mock('@client/app/components/Session/AISettings/useAdvancedAISettingsStore', async () => {
  const { useSyncExternalStore } = await import('react');
  return {
    useAdvancedAISettings: (selector: (state: { showAdvancedSettings: boolean }) => boolean) =>
      useSyncExternalStore(
        listener => {
          picker.listeners.add(listener);
          return () => picker.listeners.delete(listener);
        },
        () => selector({ showAdvancedSettings: picker.open })
      ),
  };
});

import { ModelSwitchStep } from './ModelSwitchStep';

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

function setPicker(open: boolean) {
  picker.open = open;
  picker.listeners.forEach(listener => listener());
}

afterEach(() => {
  llm.reset();
  picker.open = false;
  picker.listeners.clear();
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

    act(() => setPicker(true));
    expect(setAnchor).toHaveBeenLastCalledWith('');
    expect(markDone).toHaveBeenLastCalledWith(true);

    act(() => setPicker(false));
    expect(setAnchor).toHaveBeenLastCalledWith(undefined);
    expect(markDone).toHaveBeenLastCalledWith(false);
  });

  it('docks at once when the picker is already open', () => {
    picker.open = true;
    const { setAnchor, markDone } = renderStep();
    expect(setAnchor).toHaveBeenLastCalledWith('');
    expect(markDone).toHaveBeenLastCalledWith(true);
  });

  it('ignores an image model pick, which would send the follow-up to image generation', () => {
    const { complete } = renderStep();
    act(() => llm.setState({ model: ImageModels.GPT_IMAGE_1, hasExplicitSessionModelSelection: true }));
    expect(complete).not.toHaveBeenCalled();
  });

  it('completes on a pick when the explicit flag was already up', () => {
    llm.setState({ hasExplicitSessionModelSelection: true });
    const { complete } = renderStep();
    act(() => llm.setState({ model: 'model-b' }));
    expect(complete).toHaveBeenCalledTimes(1);
  });

  it('calls the latest complete after a rerender', () => {
    const first = renderStep();
    const next = vi.fn();
    first.rerender(<ModelSwitchStep {...first} complete={next} />);
    act(() => llm.setState({ model: 'model-b', hasExplicitSessionModelSelection: true }));
    expect(next).toHaveBeenCalledTimes(1);
    expect(first.complete).not.toHaveBeenCalled();
  });

  it('stops listening once the step is gone', () => {
    const { complete, unmount } = renderStep();
    unmount();
    llm.setState({ model: 'model-b', hasExplicitSessionModelSelection: true });
    expect(complete).not.toHaveBeenCalled();
  });
});
