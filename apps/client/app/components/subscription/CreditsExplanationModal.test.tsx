import React from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { CssVarsProvider, extendTheme } from '@mui/joy/styles';
import { getThemeConfig } from '@client/app/utils/themes';

const { state } = vi.hoisted(() => ({
  state: { defaultFreeCredits: 100 as number | undefined, organizationId: null as string | null },
}));

vi.mock('@client/app/contexts/LLMContext', () => ({
  useLLM: (selector: (value: { model: string; organizationId: string | null }) => unknown) =>
    selector({ model: 'model-a', organizationId: state.organizationId }),
}));
vi.mock('@client/app/hooks/data/settings', () => ({
  useGetSettingsValue: (key: string) => (key === 'defaultFreeCredits' ? state.defaultFreeCredits : undefined),
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

vi.mock('./CreditsModal', () => ({
  default: ({ open }: { open: boolean }) => (open ? <div data-testid="usage-open" /> : null),
}));

import CreditsExplanationModal from './CreditsExplanationModal';

const appTheme = extendTheme({ ...getThemeConfig() });

const renderModal = () =>
  render(
    <CssVarsProvider theme={appTheme}>
      <CreditsExplanationModal open onClose={vi.fn()} />
    </CssVarsProvider>
  );

describe('CreditsExplanationModal', () => {
  beforeEach(() => {
    state.defaultFreeCredits = 100;
    state.organizationId = null;
  });

  it('opens the usage history from See usage', () => {
    renderModal();
    expect(screen.queryByTestId('usage-open')).toBeNull();
    fireEvent.click(screen.getByTestId('credits-explanation-usage'));
    expect(screen.queryByTestId('credits-explanation-modal')).toBeNull();
    expect(screen.getByTestId('usage-open')).toBeInTheDocument();
  });

  it('hides the no-card sentence when no free credits are configured', () => {
    state.defaultFreeCredits = 0;
    renderModal();
    expect(screen.queryByText(/require no card/)).toBeNull();
    expect(screen.getByText(/Your chats and files remain yours/)).toBeInTheDocument();
  });

  it('hides the no-card sentence when an organization pays', () => {
    state.organizationId = 'org-1';
    renderModal();
    expect(screen.queryByText(/require no card/)).toBeNull();
  });

  it('explains free credits and answers before opening top-up one click deeper', () => {
    render(
      <CssVarsProvider theme={appTheme}>
        <CreditsExplanationModal open onClose={vi.fn()} />
      </CssVarsProvider>
    );

    expect(screen.getByTestId('credits-explanation-modal')).toBeInTheDocument();
    expect(screen.getByTestId('credits-explanation-answers')).toHaveTextContent(/typical answers left/);
    expect(screen.getByText(/Free starting credits require no card/)).toBeInTheDocument();
    expect(screen.queryByTestId('billing-open')).toBeNull();

    fireEvent.click(screen.getByTestId('credits-explanation-top-up'));
    expect(screen.queryByTestId('credits-explanation-modal')).toBeNull();
    expect(screen.getByTestId('billing-open')).toHaveAttribute('data-focus', 'credits');
  });
});
