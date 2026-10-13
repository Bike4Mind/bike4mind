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
const SELF_HOSTED = [ModelBackend.Ollama, ModelBackend.LocalImage];

describe('getModelDataHandlingText', () => {
  it('covers every backend', () => {
    const covered = new Set([...THIRD_PARTY.map(([backend]) => backend), ...SELF_HOSTED]);
    expect([...covered].sort()).toEqual([...Object.values(ModelBackend)].sort());
  });

  it.each(THIRD_PARTY)('names the serving provider for %s', (backend, provider) => {
    expect(getModelDataHandlingText(backend)).toContain(
      `This model is served by ${provider}. Your session content is processed by ${provider} under its API terms`
    );
  });

  it.each([ModelBackend.OpenAI, ModelBackend.Anthropic, ModelBackend.Gemini, ModelBackend.Bedrock, ModelBackend.AWS])(
    'states the training exclusion for %s',
    backend => {
      expect(getModelDataHandlingText(backend)).toContain('do not use your content for training');
    }
  );

  it.each([ModelBackend.XAI, ModelBackend.BFL, ModelBackend.Kimi, ModelBackend.DeepSeek, ModelBackend.VoyageAI])(
    'makes no training claim for %s, which the privacy page does not name',
    backend => {
      expect(getModelDataHandlingText(backend)).not.toContain('training');
    }
  );

  it('names Bedrock, not the model maker, for a Bedrock-served model', () => {
    expect(getModelDataHandlingText(ModelBackend.Bedrock)).not.toContain('Anthropic');
  });

  it.each(SELF_HOSTED)('names no third-party provider for %s', backend => {
    expect(getModelDataHandlingText(backend)).toBe(
      'This model runs on a self-hosted open-weight server, so no third-party model provider processes your session content.'
    );
  });

  it('makes no training claim for an unrecognised backend', () => {
    const text = getModelDataHandlingText('unknown' as ModelBackend);
    expect(text).toBe("Your session content is processed by this model's provider under its API terms.");
  });
});

describe('ModelDataHandlingNotice', () => {
  it('renders the line with a link to the privacy page', () => {
    render(<ModelDataHandlingNotice backend={ModelBackend.Anthropic} />, { wrapper: TestWrapper });

    expect(screen.getByTestId('model-details-data-handling-notice')).toHaveTextContent(
      'This model is served by Anthropic.'
    );
    const link = screen.getByTestId('model-details-data-handling-privacy-link');
    expect(link).toHaveAttribute('href', ExternalLinks.privacy);
    expect(link).toHaveAttribute('target', '_blank');
  });
});
