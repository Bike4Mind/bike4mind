import React from 'react';
import { beforeEach, describe, it, expect, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { CssVarsProvider, extendTheme } from '@mui/joy/styles';
import { getThemeConfig } from '@client/app/utils/themes/themePrimitives';

const OPUS = { id: 'claude-opus-x', type: 'text', contextWindow: 1_000_000, max_tokens: 128_000 };

vi.mock('@client/app/hooks/data/useModelInfo', () => ({
  useModelInfo: () => ({ data: [OPUS] }),
}));

import { useLLM } from '@client/app/contexts/LLMContext';
import { getLowOutputBudget, LowOutputBudgetBanner } from './LowOutputBudgetBanner';

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

  it('names the setting and the model default', () => {
    renderBanner();

    const banner = screen.getByTestId('reply-low-output-budget-warning');
    expect(banner).toHaveTextContent('Your Max output tokens setting (8,192) is too low');
    expect(banner).toHaveTextContent("This model's default is 128,000");
  });

  it('raises the saved setting to the selected model default in one click', () => {
    renderBanner();

    fireEvent.click(screen.getByTestId('reply-low-output-budget-raise-button'));

    expect(useLLM.getState().max_tokens).toBe(128_000);
    expect(screen.getByTestId('reply-low-output-budget-raised')).toHaveTextContent('Max output tokens is now 128,000');
  });

  // Fixed already (here or in the settings dialog): nothing left to click.
  it('offers no button once the setting is at the default', () => {
    useLLM.getState().setLLM({ max_tokens: 128_000 });
    renderBanner();

    expect(screen.queryByTestId('reply-low-output-budget-raise-button')).toBeNull();
  });
});
