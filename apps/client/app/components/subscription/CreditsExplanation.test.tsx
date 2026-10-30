import React from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { CssVarsProvider, extendTheme } from '@mui/joy/styles';
import { getThemeConfig } from '@client/app/utils/themes';

const { state } = vi.hoisted(() => ({
  state: { defaultFreeCredits: 100 as number | undefined, organizationId: null as string | null, freeToRun: false },
}));

vi.mock('@client/app/contexts/LLMContext', () => ({
  useLLM: (selector: (value: { model: string; organizationId: string | null }) => unknown) =>
    selector({ model: 'model-a', organizationId: state.organizationId }),
}));
vi.mock('@client/app/hooks/data/settings', () => ({
  useGetSettingsValue: (key: string) => (key === 'defaultFreeCredits' ? state.defaultFreeCredits : undefined),
  useSettingsFromServer: () => ({ data: undefined }),
}));
vi.mock('@client/app/hooks/useEffectiveCredits', () => ({ useEffectiveCredits: () => 1000 }));
vi.mock('@client/app/hooks/data/useModelInfo', () => ({
  useModelInfo: () => ({
    data: [
      {
        id: 'model-a',
        name: 'Model A',
        type: 'text',
        freeToRun: state.freeToRun,
        backend: 'openai',
        pricing: { 1000000: { input: 0.000001, output: 0.000004 } },
      },
    ],
  }),
}));
import CreditsExplanation from './CreditsExplanation';

const appTheme = extendTheme({ ...getThemeConfig() });

const renderModal = () =>
  render(
    <CssVarsProvider theme={appTheme}>
      <CreditsExplanation />
    </CssVarsProvider>
  );

describe('CreditsExplanation', () => {
  beforeEach(() => {
    state.defaultFreeCredits = 100;
    state.organizationId = null;
    state.freeToRun = false;
  });

  it('explains that free models do not use credits', () => {
    state.freeToRun = true;
    renderModal();
    expect(screen.getByTestId('credits-explanation-answers')).toHaveTextContent("This model doesn't use credits");
    expect(screen.queryByText(/based on a typical answer/i)).toBeNull();
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

  it('explains credits inline without putting another dialog in front of buying', () => {
    renderModal();
    expect(screen.getByTestId('credits-explanation')).toBeInTheDocument();
    expect(screen.getByTestId('credits-explanation-answers')).toHaveTextContent(/typical answers left/);
    expect(screen.getByText(/Free starting credits require no card/)).toBeInTheDocument();
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(screen.queryByRole('button')).toBeNull();
  });
});
