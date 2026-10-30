import React from 'react';
import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { CssVarsProvider, extendTheme } from '@mui/joy/styles';
import type { ModelInfo } from '@bike4mind/common';
import { getThemeConfig } from '../../utils/themes';
import { preflightAnswerCredits } from '../../utils/creditEstimate';
import { AffordableModelOffer } from './AffordableModelOffer';

vi.mock('./CreditOfferActions', () => ({
  CreditOfferActions: ({ moment }: { moment: string }) => (
    <div data-testid="credit-offer-actions" data-moment={moment} />
  ),
}));

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
  it.each(['output ceiling', 'pricing', 'context window'] as const)(
    'uses the live %s when access settings contain an older model snapshot',
    field => {
      const liveCandidate = {
        ...model(
          'stale-candidate',
          'Stale candidate',
          field === 'context window' ? 1 : field === 'output ceiling' ? 3 : 5
        ),
        contextWindow: field === 'context window' ? 8_000 : 200_000,
        max_tokens: field === 'output ceiling' ? 128_000 : 4_096,
      };
      const savedCandidate = {
        ...liveCandidate,
        ...(field === 'output ceiling' && { max_tokens: 4_096 }),
        ...(field === 'pricing' && { pricing: affordable.pricing }),
        ...(field === 'context window' && { contextWindow: 128_000 }),
      };
      const accessSettings = [expensive, savedCandidate, affordable];
      const onSelect = vi.fn();
      render(
        <CssVarsProvider theme={appTheme}>
          <AffordableModelOffer
            enabled
            models={[expensive, liveCandidate, affordable]}
            accessibleModelIds={accessSettings.map(candidate => candidate.id)}
            selectedModelId={expensive.id}
            credits={100}
            inputTokens={inputTokens}
            selectedMaxTokens={maxTokens}
            onSelect={onSelect}
          />
        </CssVarsProvider>
      );

      fireEvent.click(screen.getByTestId('affordable-model-use-btn'));
      expect(onSelect).toHaveBeenCalledExactlyOnceWith(affordable);
      expect(screen.getByTestId('affordable-model-offer')).toHaveTextContent(
        `Affordable is estimated at ${preflightAnswerCredits(affordable, inputTokens, maxTokens)}`
      );
    }
  );

  it('does not offer a live model excluded by the access settings', () => {
    render(
      <CssVarsProvider theme={appTheme}>
        <AffordableModelOffer
          enabled
          models={[expensive, affordable]}
          accessibleModelIds={[expensive.id]}
          selectedModelId={expensive.id}
          credits={100}
          inputTokens={inputTokens}
          selectedMaxTokens={maxTokens}
          onSelect={vi.fn()}
        />
      </CssVarsProvider>
    );
    expect(screen.queryByTestId('affordable-model-offer')).toBeNull();
  });

  it('triggers from the live selected price and ignores access IDs missing from the live catalog', () => {
    const savedSelected = { ...expensive, pricing: affordable.pricing };
    const missingCandidate = { ...affordable, id: 'removed-candidate', freeToRun: true };
    const accessSettings = [savedSelected, missingCandidate];
    const { rerender } = render(
      <CssVarsProvider theme={appTheme}>
        <AffordableModelOffer
          enabled
          models={[expensive, affordable]}
          accessibleModelIds={accessSettings.map(candidate => candidate.id)}
          selectedModelId={expensive.id}
          credits={100}
          inputTokens={inputTokens}
          selectedMaxTokens={maxTokens}
          onSelect={vi.fn()}
        />
      </CssVarsProvider>
    );
    expect(screen.queryByTestId('affordable-model-offer')).toBeNull();

    rerender(
      <CssVarsProvider theme={appTheme}>
        <AffordableModelOffer
          enabled
          models={[expensive, affordable]}
          accessibleModelIds={[...accessSettings.map(candidate => candidate.id), affordable.id]}
          selectedModelId={expensive.id}
          credits={100}
          inputTokens={inputTokens}
          selectedMaxTokens={maxTokens}
          onSelect={vi.fn()}
        />
      </CssVarsProvider>
    );
    expect(screen.getByTestId('affordable-model-use-btn')).toHaveTextContent('Switch to Affordable');
  });

  it('appears above the balance gate and switches to the offered model on demand', () => {
    const onSelect = vi.fn();
    render(
      <CssVarsProvider theme={appTheme}>
        <AffordableModelOffer
          enabled
          models={[expensive, affordable]}
          accessibleModelIds={[expensive.id, affordable.id]}
          selectedModelId={expensive.id}
          credits={preflightAnswerCredits(affordable, inputTokens, maxTokens)!}
          inputTokens={inputTokens}
          selectedMaxTokens={maxTokens}
          onSelect={onSelect}
        />
      </CssVarsProvider>
    );

    expect(screen.getByTestId('affordable-model-offer')).toHaveTextContent('Your default model stays the same');
    expect(screen.getByTestId('affordable-model-offer')).toHaveTextContent('needs an estimated');
    expect(screen.getByTestId('affordable-model-offer')).toHaveTextContent('attachments and tools');
    const paid = screen.getByTestId('credit-offer-actions');
    const switchButton = screen.getByTestId('affordable-model-use-btn');
    expect(paid).toHaveAttribute('data-moment', 'low');
    expect(paid.compareDocumentPosition(switchButton) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    fireEvent.click(switchButton);
    expect(onSelect).toHaveBeenCalledWith(affordable);
  });

  it('renders no offer when the current model fits the balance', () => {
    render(
      <CssVarsProvider theme={appTheme}>
        <AffordableModelOffer
          enabled
          models={[expensive, affordable]}
          accessibleModelIds={[expensive.id, affordable.id]}
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
          accessibleModelIds={[expensive.id, affordable.id]}
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
