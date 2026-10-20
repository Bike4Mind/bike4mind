import React from 'react';
import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { CssVarsProvider, extendTheme } from '@mui/joy/styles';
import type { ModelInfo } from '@bike4mind/common';
import { getThemeConfig } from '../../utils/themes';
import { preflightAnswerCredits } from '../../utils/creditEstimate';
import { AffordableModelOffer } from './AffordableModelOffer';

const model = (id: string, name: string, output: number): ModelInfo =>
  ({
    id,
    name,
    type: 'text',
    backend: 'openai',
    contextWindow: 128_000,
    max_tokens: 16_384,
    pricing: { 1_000_000: { input: 1 / 1_000_000, output: output / 1_000_000 } },
  }) as unknown as ModelInfo;

const expensive = model('expensive', 'Expensive', 20);
const affordable = model('affordable', 'Affordable', 1);
const inputTokens = 20_000;
const maxTokens = 16_384;
const appTheme = extendTheme({ ...getThemeConfig() });

describe('AffordableModelOffer', () => {
  it('appears above the balance gate and switches to the offered model on demand', () => {
    const onSelect = vi.fn();
    render(
      <CssVarsProvider theme={appTheme}>
        <AffordableModelOffer
          enabled
          models={[expensive, affordable]}
          selectedModelId={expensive.id}
          credits={preflightAnswerCredits(affordable, inputTokens, maxTokens)!}
          inputTokens={inputTokens}
          selectedMaxTokens={maxTokens}
          onSelect={onSelect}
        />
      </CssVarsProvider>
    );

    expect(screen.getByTestId('affordable-model-offer')).toHaveTextContent('will become your active model');
    expect(screen.getByTestId('affordable-model-offer')).toHaveTextContent('may need about');
    expect(screen.getByTestId('affordable-model-offer')).toHaveTextContent('attachments and tools');
    fireEvent.click(screen.getByTestId('affordable-model-use-btn'));
    expect(onSelect).toHaveBeenCalledWith(affordable);
  });

  it('renders no offer when the current model fits the balance', () => {
    render(
      <CssVarsProvider theme={appTheme}>
        <AffordableModelOffer
          enabled
          models={[expensive, affordable]}
          selectedModelId={expensive.id}
          credits={preflightAnswerCredits(expensive, inputTokens, maxTokens)!}
          inputTokens={inputTokens}
          selectedMaxTokens={maxTokens}
          onSelect={vi.fn()}
        />
      </CssVarsProvider>
    );
    expect(screen.queryByTestId('affordable-model-offer')).toBeNull();
  });

  it('hides the switch when another mode controls the models being dispatched', () => {
    render(
      <CssVarsProvider theme={appTheme}>
        <AffordableModelOffer
          enabled={false}
          models={[expensive, affordable]}
          selectedModelId={expensive.id}
          credits={preflightAnswerCredits(affordable, inputTokens, maxTokens)!}
          inputTokens={inputTokens}
          selectedMaxTokens={maxTokens}
          onSelect={vi.fn()}
        />
      </CssVarsProvider>
    );
    expect(screen.queryByTestId('affordable-model-offer')).toBeNull();
  });
});
