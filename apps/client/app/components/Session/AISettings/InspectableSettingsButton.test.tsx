// @vitest-environment jsdom
import { render, screen } from '@testing-library/react';
import { CssVarsProvider, extendTheme } from '@mui/joy/styles';
import { describe, expect, it } from 'vitest';
import { getThemeConfig } from '@client/app/utils/themes';
import InspectableSettingsButton from './InspectableSettingsButton';

const appTheme = extendTheme({ ...getThemeConfig() });
const renderButton = (modelName?: string) =>
  render(
    <CssVarsProvider theme={appTheme}>
      <InspectableSettingsButton onClick={() => {}} modelName={modelName} />
    </CssVarsProvider>
  );

describe('InspectableSettingsButton', () => {
  it('shows the model name and keeps it in the accessible name', () => {
    renderButton('GPT-5 Mini');
    const button = screen.getByTestId('ai-settings-btn');
    expect(button.textContent).toContain('GPT-5 Mini');
    expect(button.getAttribute('aria-label')).toBe('AI Settings, model: GPT-5 Mini');
  });

  it('falls back to a plain label without a model name', () => {
    renderButton();
    expect(screen.getByTestId('ai-settings-btn').getAttribute('aria-label')).toBe('AI Settings');
  });
});
