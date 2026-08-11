import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import { CssVarsProvider, extendTheme } from '@mui/joy/styles';
import { getThemeConfig } from '@client/app/utils/themes';
import { ApiKeyType, IApiKeyDocument } from '@bike4mind/common';

let apiKeys: Partial<IApiKeyDocument>[] = [];
const setActiveCalls: string[] = [];

vi.mock('@client/app/hooks/data/apiKeys', () => ({
  useGetAllApiKeys: () => ({ data: apiKeys, isFetching: false }),
  useSetActiveApiKey: (type: string) => ({
    mutate: () => setActiveCalls.push(type),
  }),
  useDeleteApiKey: () => ({ mutate: vi.fn(), isPending: false }),
  useAddNewApiKey: () => ({ mutate: vi.fn(), reset: vi.fn(), isError: false, isSuccess: false, isPending: false }),
}));

vi.mock('@client/app/hooks/data/voice', () => ({
  useGetAllVoice: () => ({ data: [], isLoading: false }),
  useSetVoice: () => ({ mutate: vi.fn() }),
  useDeleteVoice: () => ({ mutate: vi.fn() }),
}));

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));

vi.mock('@client/app/components/ProfileModal/AddVoiceModal', () => ({
  default: () => <div data-testid="add-voice-modal-stub" />,
}));

import ApiKeysSection from './ApiKeysSection';

const appTheme = extendTheme({ ...getThemeConfig() });

const renderSection = () =>
  render(
    <CssVarsProvider theme={appTheme}>
      <ApiKeysSection />
    </CssVarsProvider>
  );

// Every provider getEffectiveLLMApiKeys resolves a per-user key for must be addable,
// otherwise the BYOK tier is unreachable and usage silently bills the org demo key.
const BYOK_TYPES = [
  ApiKeyType.openai,
  ApiKeyType.anthropic,
  ApiKeyType.gemini,
  ApiKeyType.xai,
  ApiKeyType.kimi,
  ApiKeyType.bfl,
  ApiKeyType.voyageai,
  ApiKeyType.elevenlabs,
];

describe('ApiKeysSection', () => {
  beforeEach(() => {
    apiKeys = [];
    setActiveCalls.length = 0;
  });

  it.each(BYOK_TYPES)('exposes an add-key affordance for %s', type => {
    renderSection();

    expect(screen.getByTestId(`api-keys-provider-${type}`)).toBeTruthy();
    expect(screen.getByTestId(`api-keys-add-${type}-btn`)).toBeTruthy();
  });

  it('does not render sections for admin-configured types', () => {
    renderSection();

    expect(screen.queryByTestId(`api-keys-provider-${ApiKeyType.serpapi}`)).toBeNull();
    expect(screen.queryByTestId(`api-keys-provider-${ApiKeyType.ollama}`)).toBeNull();
  });

  it('files each key under its own provider rather than defaulting to openAi', () => {
    apiKeys = [
      {
        id: 'k1',
        apiKey: 'sk-ant-abcdefgh1234',
        type: ApiKeyType.anthropic,
        description: 'my anthropic key',
        isActive: false,
      },
    ];

    renderSection();

    const anthropic = screen.getByTestId(`api-keys-provider-${ApiKeyType.anthropic}`);
    expect(anthropic.textContent).toContain('my anthropic key');

    const openai = screen.getByTestId(`api-keys-provider-${ApiKeyType.openai}`);
    expect(openai.textContent).not.toContain('my anthropic key');
  });
});
