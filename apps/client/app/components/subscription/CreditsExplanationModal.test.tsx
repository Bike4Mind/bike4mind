import React from 'react';
import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { CssVarsProvider, extendTheme } from '@mui/joy/styles';
import { getThemeConfig } from '@client/app/utils/themes';

vi.mock('@client/app/contexts/LLMContext', () => ({
  useLLM: (selector: (state: { model: string }) => unknown) => selector({ model: 'model-a' }),
}));
vi.mock('@client/app/hooks/useEffectiveCredits', () => ({ useEffectiveCredits: () => 1000 }));
vi.mock('@client/app/hooks/data/useModelInfo', () => ({
  useModelInfo: () => ({
    data: [
      {
        id: 'model-a',
        name: 'Model A',
        type: 'text',
        backend: 'openai',
        pricing: { 1000000: { input: 0.000001, output: 0.000004 } },
      },
    ],
  }),
}));
vi.mock('./BillingModal', () => ({
  default: ({ open, focus }: { open: boolean; focus?: string }) =>
    open ? <div data-testid="billing-open" data-focus={focus} /> : null,
}));

import CreditsExplanationModal from './CreditsExplanationModal';

const appTheme = extendTheme({ ...getThemeConfig() });

describe('CreditsExplanationModal', () => {
  it('explains free credits and answers before opening top-up one click deeper', () => {
    render(
      <CssVarsProvider theme={appTheme}>
        <CreditsExplanationModal open onClose={vi.fn()} />
      </CssVarsProvider>
    );

    expect(screen.getByTestId('credits-explanation-modal')).toBeInTheDocument();
    expect(screen.getByTestId('credits-explanation-answers')).toHaveTextContent('answers left');
    expect(screen.getByText(/Free starting credits require no card/)).toBeInTheDocument();
    expect(screen.queryByTestId('billing-open')).toBeNull();

    fireEvent.click(screen.getByTestId('credits-explanation-top-up'));
    expect(screen.queryByTestId('credits-explanation-modal')).toBeNull();
    expect(screen.getByTestId('billing-open')).toHaveAttribute('data-focus', 'credits');
  });
});
