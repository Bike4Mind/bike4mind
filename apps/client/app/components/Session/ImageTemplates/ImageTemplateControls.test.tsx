import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { CssVarsProvider } from '@mui/joy/styles';

const { holder } = vi.hoisted(() => ({
  holder: { templates: [] as any[] },
}));

vi.mock('../../../hooks/data/imageTemplates', () => ({
  useImageTemplates: () => ({ data: holder.templates }),
}));

vi.mock('../../../hooks/data/useModelInfo', () => ({
  useModelInfo: () => ({ data: [{ id: 'flux-pro-1.1', name: 'Flux Pro 1.1' }] }),
}));

import { useLLM } from '@client/app/contexts/LLMContext';
import { useAdvancedAISettings } from '../AISettings/useAdvancedAISettingsStore';
import { ImageTemplateControls } from './ImageTemplateControls';
import { imageTemplateSettingsSnapshot } from './settingsSnapshot';

const TestWrapper = ({ children }: { children: React.ReactNode }) => <CssVarsProvider>{children}</CssVarsProvider>;

const currentSnapshot = () => imageTemplateSettingsSnapshot(useLLM.getState());

describe('ImageTemplateControls (settings bar)', () => {
  beforeEach(() => {
    holder.templates = [];
    useLLM.getState().resetSettings();
    useLLM.setState({ model: 'flux-pro-1.1' });
    useAdvancedAISettings.getState().setModelDetailsOpen(false);
  });

  it('shows the applied indicator when current settings match a template, and clicking it opens the modal', () => {
    holder.templates = [
      {
        id: 't1',
        userId: 'u1',
        name: 'Matches Now',
        model: 'flux-pro-1.1',
        settings: currentSnapshot(),
        usageCount: 0,
      },
    ];
    render(
      <TestWrapper>
        <ImageTemplateControls />
      </TestWrapper>
    );
    expect(screen.getByTestId('applied-template-chip')).toHaveTextContent('Matches Now');

    expect(useAdvancedAISettings.getState().modelDetailsOpen).toBe(false);
    fireEvent.click(screen.getByTestId('applied-template-open'));
    expect(useAdvancedAISettings.getState().modelDetailsOpen).toBe(true);
  });

  it('hides the indicator once settings drift', () => {
    holder.templates = [
      {
        id: 't1',
        userId: 'u1',
        name: 'Matches Now',
        model: 'flux-pro-1.1',
        settings: currentSnapshot(),
        usageCount: 0,
      },
    ];
    useLLM.getState().setLLM({ seed: 12345 });
    render(
      <TestWrapper>
        <ImageTemplateControls />
      </TestWrapper>
    );
    expect(screen.queryByTestId('applied-template-chip')).toBeNull();
  });
});
