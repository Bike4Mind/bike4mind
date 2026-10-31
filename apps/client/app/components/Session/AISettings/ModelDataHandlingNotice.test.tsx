import React from 'react';
import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import { CssVarsProvider, extendTheme } from '@mui/joy/styles';
import { ModelBackend } from '@bike4mind/common';
import { getThemeConfig } from '@client/app/utils/themes';
import { ExternalLinks } from '@client/app/utils/externalLinks';
import { ModelDataHandlingNotice, getModelDataHandlingText } from './ModelDataHandlingNotice';

const appTheme = extendTheme({ ...getThemeConfig() });
const TestWrapper = ({ children }: { children: React.ReactNode }) => (
  <CssVarsProvider theme={appTheme}>{children}</CssVarsProvider>
);

const THIRD_PARTY: Array<[ModelBackend, string]> = [
  [ModelBackend.OpenAI, 'OpenAI'],
  [ModelBackend.Anthropic, 'Anthropic'],
  [ModelBackend.Bedrock, 'AWS Bedrock'],
  [ModelBackend.AWS, 'AWS'],
  [ModelBackend.Gemini, 'Google'],
  [ModelBackend.XAI, 'xAI'],
  [ModelBackend.BFL, 'Black Forest Labs'],
  [ModelBackend.Kimi, 'Moonshot AI'],
  [ModelBackend.DeepSeek, 'DeepSeek'],
  [ModelBackend.VoyageAI, 'Voyage AI'],
];
const SELF_HOSTED = [ModelBackend.Ollama, ModelBackend.OpenAICompatible, ModelBackend.LocalImage];

const route = (backend: ModelBackend) => ({ id: 'some-model', backend });

describe('getModelDataHandlingText', () => {
  it('covers every backend', () => {
    const covered = new Set([...THIRD_PARTY.map(([backend]) => backend), ...SELF_HOSTED]);
    expect([...covered].sort()).toEqual([...Object.values(ModelBackend)].sort());
  });

  it.each(THIRD_PARTY)('names the serving provider for %s', (backend, provider) => {
    expect(getModelDataHandlingText(route(backend))).toContain(`This model is served by ${provider}.`);
  });

  it.each([ModelBackend.OpenAI, ModelBackend.Anthropic, ModelBackend.Bedrock, ModelBackend.AWS])(
    'states the training exclusion for %s',
    backend => {
      const provider = THIRD_PARTY.find(([b]) => b === backend)?.[1];
      expect(getModelDataHandlingText(route(backend))).toBe(
        `This model is served by ${provider}. Your session content is processed by ${provider} under its API terms, which do not use your content for training.`
      );
    }
  );

  // The platform key is on the paid tier; a user's own key may not be, and the client cannot tell
  // which key serves the call.
  it('scopes the Gemini training exclusion to the platform key and defers to a user key', () => {
    expect(getModelDataHandlingText(route(ModelBackend.Gemini))).toBe(
      "This model is served by Google. With Bike4Mind's key, your session content is processed under Google's paid API terms, which do not use your content for training. If you use your own Google API key, your key's terms apply."
    );
  });

  it.each([ModelBackend.XAI, ModelBackend.BFL, ModelBackend.Kimi, ModelBackend.DeepSeek, ModelBackend.VoyageAI])(
    'makes no training claim for %s',
    backend => {
      const provider = THIRD_PARTY.find(([b]) => b === backend)?.[1];
      expect(getModelDataHandlingText(route(backend))).toBe(
        `This model is served by ${provider}. Your session content is processed by ${provider} under its API terms.`
      );
    }
  );

  it('names Bedrock, not the model maker, for a Bedrock-served model', () => {
    const text = getModelDataHandlingText({ id: 'global.anthropic.claude-haiku-5-5', backend: ModelBackend.Bedrock });
    expect(text).not.toContain('Anthropic');
  });

  it.each(SELF_HOSTED)('names no third-party provider for %s', backend => {
    expect(getModelDataHandlingText(route(backend))).toBe(
      'This model runs on a self-hosted open-weight server, so no third-party model provider processes your session content.'
    );
  });

  it.each(['gpt-oss:120b-cloud', 'glm-4.6:cloud'])('names Ollama for the Ollama cloud model %s', id => {
    expect(getModelDataHandlingText({ id, backend: ModelBackend.Ollama })).toBe(
      'This model is served by Ollama. Your session content is processed by Ollama under its API terms.'
    );
  });

  it('keeps the self-hosted line for a local Ollama model whose name contains "cloud"', () => {
    expect(getModelDataHandlingText({ id: 'cloudy-llama:7b', backend: ModelBackend.Ollama })).toContain('self-hosted');
  });

  it('makes no training claim for an unrecognised backend', () => {
    const text = getModelDataHandlingText(route('unknown' as ModelBackend));
    expect(text).toBe("Your session content is processed by this model's provider under its API terms.");
  });
});

describe('ModelDataHandlingNotice', () => {
  it('renders the line with a link to the privacy page', () => {
    render(<ModelDataHandlingNotice model={route(ModelBackend.Anthropic)} />, { wrapper: TestWrapper });

    expect(screen.getByTestId('model-details-data-handling-notice')).toHaveTextContent(
      'This model is served by Anthropic.'
    );
    const link = screen.getByTestId('model-details-data-handling-privacy-link');
    expect(link).toHaveAttribute('href', ExternalLinks.privacy);
    expect(link).toHaveAttribute('target', '_blank');
  });
});
