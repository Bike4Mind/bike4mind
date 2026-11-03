import React from 'react';
import { beforeEach, describe, it, expect, vi } from 'vitest';
import { fireEvent, render, renderHook, screen } from '@testing-library/react';
import { CssVarsProvider, extendTheme } from '@mui/joy/styles';
import { getThemeConfig } from '@client/app/utils/themes';

const OPUS = {
  id: 'claude-opus-x',
  type: 'text',
  contextWindow: 1_000_000,
  max_tokens: 128_000,
  thinkingStyle: 'adaptive',
};
const PLAIN = { id: 'plain-model', type: 'text', contextWindow: 200_000, max_tokens: 64_000 };
// Capped below the 64K reasoning floor: the raise must stop at what the model can emit.
const SMALL_CAP = {
  id: 'small-cap-model',
  type: 'text',
  contextWindow: 200_000,
  max_tokens: 32_000,
  thinkingStyle: 'adaptive',
};
const IMAGE = { id: 'gpt-image-1', type: 'image', contextWindow: 0, max_tokens: 4096 };

vi.mock('@client/app/hooks/data/useModelInfo', () => ({
  useModelInfo: () => ({ data: [OPUS, PLAIN, SMALL_CAP, IMAGE] }),
}));

import { useLLM } from '@client/app/contexts/LLMContext';
import { formatTokenBudget } from '@client/app/utils/aiSettingsUtils';
import { getLowOutputBudget, LowOutputBudgetBanner, useLowOutputBudget } from './LowOutputBudgetBanner';

const appTheme = extendTheme({ ...getThemeConfig() });

describe('getLowOutputBudget', () => {
  it('flags a budget below the model default', () => {
    expect(getLowOutputBudget(8192, 128_000)).toEqual({ requested: 8192, modelDefault: 128_000 });
  });

  it('does not flag a budget at or above the default', () => {
    expect(getLowOutputBudget(128_000, 128_000)).toBeNull();
    expect(getLowOutputBudget(200_000, 128_000)).toBeNull();
  });

  // Older turns and other entry points may not record either figure; the generic notice stands.
  it('does not flag when either figure is missing or unusable', () => {
    expect(getLowOutputBudget(undefined, 128_000)).toBeNull();
    expect(getLowOutputBudget(8192, undefined)).toBeNull();
    expect(getLowOutputBudget(0, 128_000)).toBeNull();
    expect(getLowOutputBudget(Number.NaN, 128_000)).toBeNull();
  });
});

describe('useLowOutputBudget', () => {
  it('flags a low budget on a model that reasons inside its output budget', () => {
    const { result } = renderHook(() => useLowOutputBudget(OPUS.id, 8192));

    expect(result.current).toEqual({ requested: 8192, modelDefault: 128_000 });
  });

  // An empty reply there was not reasoning running out of room, so the reasoning copy would be untrue.
  it('leaves any other model on the generic notice', () => {
    const { result } = renderHook(() => useLowOutputBudget(PLAIN.id, 1024));

    expect(result.current).toBeNull();
  });

  it('leaves a model missing from the catalog on the generic notice', () => {
    const { result } = renderHook(() => useLowOutputBudget('retired-model', 8192));

    expect(result.current).toBeNull();
  });
});

describe('LowOutputBudgetBanner', () => {
  beforeEach(() => {
    useLLM.getState().setLLM({ model: OPUS.id, max_tokens: 8192 });
  });

  const renderBanner = () =>
    render(
      <CssVarsProvider theme={appTheme}>
        <LowOutputBudgetBanner requested={8192} modelDefault={128_000} />
      </CssVarsProvider>
    );

  it('says the reply ran out of budget while reasoning and names the setting and the default', () => {
    renderBanner();

    const banner = screen.getByTestId('reply-low-output-budget-warning');
    expect(banner).toHaveTextContent('ran out of output budget while the model was still reasoning');
    expect(banner).toHaveTextContent("sent with Max output tokens set to 8 192, below this model's default of 128 000");
  });

  // The Max output tokens read-out formats with spaces; the notice about that setting must match it.
  it('formats every figure with the shared token formatter the settings slider uses', () => {
    renderBanner();

    expect(screen.getByTestId('reply-low-output-budget-warning')).toHaveTextContent(
      `set to ${formatTokenBudget(8192)}, below this model's default of ${formatTokenBudget(128_000)}`
    );
    expect(screen.getByTestId('reply-low-output-budget-raise-button')).toHaveTextContent(
      `Raise to ${formatTokenBudget(128_000)}`
    );
    expect(screen.getByTestId('reply-low-output-budget-warning')).not.toHaveTextContent('128,000');
  });

  it('raises the saved setting to the selected model default in one click', () => {
    renderBanner();

    const button = screen.getByTestId('reply-low-output-budget-raise-button');
    expect(button).toHaveTextContent('Raise to 128 000');
    fireEvent.click(button);

    expect(useLLM.getState().max_tokens).toBe(128_000);
    expect(screen.getByTestId('reply-low-output-budget-raised')).toHaveTextContent('Max output tokens is now 128 000');
  });

  it('raises no higher than the cap of a selected model capped below the reasoning floor', () => {
    useLLM.getState().setLLM({ model: SMALL_CAP.id, max_tokens: 8192 });
    renderBanner();

    fireEvent.click(screen.getByTestId('reply-low-output-budget-raise-button'));

    expect(useLLM.getState().max_tokens).toBe(SMALL_CAP.max_tokens);
  });

  // An image model's max_tokens is not an output budget, so there is nothing to raise while one is selected.
  it('offers no button while an image model is selected', () => {
    useLLM.getState().setLLM({ model: IMAGE.id, max_tokens: 1024 });
    renderBanner();

    expect(screen.getByTestId('reply-low-output-budget-warning')).toBeInTheDocument();
    expect(screen.queryByTestId('reply-low-output-budget-raise-button')).toBeNull();
  });

  // Fixed already (here or in the settings dialog): nothing left to click.
  it('offers no button once the setting is at the default', () => {
    useLLM.getState().setLLM({ max_tokens: 128_000 });
    renderBanner();

    expect(screen.queryByTestId('reply-low-output-budget-raise-button')).toBeNull();
  });
});
