import React from 'react';
import { describe, it, expect, vi } from 'vitest';
import { render, fireEvent } from '@testing-library/react';
import { CssVarsProvider, extendTheme } from '@mui/joy/styles';
import { getThemeConfig } from '@client/app/utils/themes';
import { ChatModels } from '@bike4mind/common';
import type { ResearchModeConfiguration } from '@client/app/types/ResearchMode';

/**
 * The Research Mode config card must hide the sampling-param
 * inputs (Temperature / Top P / Frequency penalty) for models that reject them -
 * the newer Anthropic models in NO_TEMPERATURE_MODELS (Opus 4.7/4.8, Sonnet 5,
 * Fable 5) - while still showing Max Tokens, which every model supports.
 *
 * Uses the real NO_TEMPERATURE_MODELS set from @bike4mind/common (browser-safe)
 * and only mocks useAccessibleModels to avoid its deep provider/query chain.
 */

const textModels = [
  { id: ChatModels.GPT4_1, name: 'GPT-4.1', type: 'text', contextWindow: 1_000_000, max_tokens: 32_768 },
  {
    id: ChatModels.CLAUDE_4_8_OPUS,
    name: 'Claude Opus 4.8',
    type: 'text',
    contextWindow: 1_000_000,
    max_tokens: 128_000,
  },
];

vi.mock('@client/app/hooks/useAccessibleModels', () => ({
  useAccessibleModels: () => ({ accessibleTextModels: textModels }),
}));

import { ResearchConfigPanel } from './ResearchConfigPanel';

const appTheme = extendTheme({ ...getThemeConfig() });
const Wrapper: React.FC<{ children: React.ReactNode }> = ({ children }) => (
  <CssVarsProvider theme={appTheme}>{children}</CssVarsProvider>
);

const makeConfig = (model: ResearchModeConfiguration['model']): ResearchModeConfiguration => ({
  id: 'cfg-1',
  enabled: true,
  model,
  parameters: { temperature: 0.7, maxTokens: 4096, topP: 1, frequencyPenalty: 0 },
});

const renderPanel = (model: ResearchModeConfiguration['model']) =>
  render(<ResearchConfigPanel index={0} config={makeConfig(model)} onUpdate={vi.fn()} onRemove={vi.fn()} />, {
    wrapper: Wrapper,
  });

describe('ResearchConfigPanel sampling-param gating', () => {
  it('shows all sampling params for a model that supports them', () => {
    const { queryByTestId } = renderPanel(ChatModels.GPT4_1);
    expect(queryByTestId('research-param-temperature')).toBeTruthy();
    expect(queryByTestId('research-param-top-p')).toBeTruthy();
    expect(queryByTestId('research-param-frequency-penalty')).toBeTruthy();
    expect(queryByTestId('research-param-max-tokens')).toBeTruthy();
  });

  it('hides sampling params for a NO_TEMPERATURE model but keeps Max Tokens', () => {
    const { queryByTestId } = renderPanel(ChatModels.CLAUDE_4_8_OPUS);
    expect(queryByTestId('research-param-temperature')).toBeNull();
    expect(queryByTestId('research-param-top-p')).toBeNull();
    expect(queryByTestId('research-param-frequency-penalty')).toBeNull();
    // Max Tokens is supported by every model and must still render.
    expect(queryByTestId('research-param-max-tokens')).toBeTruthy();
  });

  it('does not propagate NaN when a parameter input is cleared', () => {
    const onUpdate = vi.fn();
    const { getByTestId } = render(
      <ResearchConfigPanel index={0} config={makeConfig(ChatModels.GPT4_1)} onUpdate={onUpdate} onRemove={vi.fn()} />,
      { wrapper: Wrapper }
    );
    const input = getByTestId('research-param-temperature').querySelector('input');
    expect(input).toBeTruthy();
    fireEvent.change(input!, { target: { value: '' } });
    expect(onUpdate).not.toHaveBeenCalled();
  });
});

/**
 * The model Select is deliberately narrow in the 4-across grid,
 * so a long name like "Claude Opus 4.8" hard-clips in the button. The whole Select is
 * wrapped in a Tooltip so the full name stays discoverable on hover.
 */
describe('ResearchConfigPanel model-name tooltip', () => {
  it('surfaces the full model name in a tooltip on hover', async () => {
    const { getByTestId, findByRole } = renderPanel(ChatModels.CLAUDE_4_8_OPUS);

    // Hover the whole Select control (the Tooltip's child) rather than a value
    // node inside the button - the outer wrap is what makes the hover reliable.
    fireEvent.mouseOver(getByTestId('research-model-select'));

    const tooltip = await findByRole('tooltip');
    expect(tooltip.textContent).toContain('Claude Opus 4.8');
  });
});
