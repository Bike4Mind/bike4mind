import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { CssVarsProvider } from '@mui/joy/styles';

vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

import { useChatInput } from '@client/app/hooks/useChatInput';
import { useLLM } from '@client/app/contexts/LLMContext';
import { useAdvancedAISettings } from '../AISettings/useAdvancedAISettingsStore';
import { PromptBuilderModal } from './PromptBuilderModal';

const TestWrapper = ({ children }: { children: React.ReactNode }) => <CssVarsProvider>{children}</CssVarsProvider>;
const renderModal = () =>
  render(
    <TestWrapper>
      <PromptBuilderModal />
    </TestWrapper>
  );

describe('PromptBuilderModal', () => {
  beforeEach(() => {
    useAdvancedAISettings.getState().setPromptBuilderOpen(true);
    useChatInput.getState().setChatInputValue('');
    useLLM.getState().resetSettings();
  });

  it('assembles a live preview from selected chips and applies it to the composer', () => {
    renderModal();

    // Select one chip from the subject group and one from the style group.
    fireEvent.click(screen.getByTestId('pb-chip-a lone figure'));
    fireEvent.click(screen.getByTestId('pb-chip-cinematic'));

    const preview = screen.getByTestId('prompt-builder-preview');
    expect(preview).toHaveTextContent('A cinematic image of a lone figure.');

    fireEvent.click(screen.getByTestId('prompt-builder-apply-btn'));
    expect(useChatInput.getState().chatInputValue).toBe('A cinematic image of a lone figure.');
    expect(useAdvancedAISettings.getState().promptBuilderOpen).toBe(false);
  });

  it('toggles a chip off and reflects it in the preview', () => {
    renderModal();
    const chip = screen.getByTestId('pb-chip-a mountain landscape');
    fireEvent.click(chip);
    expect(screen.getByTestId('prompt-builder-preview')).toHaveTextContent('A mountain landscape.');
    fireEvent.click(chip);
    expect(screen.getByTestId('prompt-builder-preview')).toHaveTextContent(
      'Select building blocks or type to build a prompt.'
    );
  });

  it('Apply is disabled with an empty prompt', () => {
    renderModal();
    expect(screen.getByTestId('prompt-builder-apply-btn')).toBeDisabled();
  });

  it('recommends an aspect ratio from the prompt and applies it to settings (M3)', () => {
    renderModal();
    // Default aspect_ratio is 16:9; a portrait subject should recommend 3:4.
    fireEvent.click(screen.getByTestId('pb-chip-a portrait of a person'));
    const rec = screen.getByTestId('prompt-builder-recommendation');
    expect(rec).toHaveTextContent('portrait');
    expect(rec).toHaveTextContent('aspect ratio');

    fireEvent.click(screen.getByTestId('prompt-builder-apply-recommendation-btn'));
    expect(useLLM.getState().aspect_ratio).toBe('3:4');
    // Once applied, the recommendation (which only shows on a mismatch) disappears.
    expect(screen.queryByTestId('prompt-builder-recommendation')).toBeNull();
  });

  it('recommends a size (not aspect ratio) on a GPT-Image model and applies it (M3)', () => {
    // GPT-Image steers orientation via size; default size 1024x1024, so a portrait
    // subject should recommend 1024x1536 as a size change.
    useLLM.getState().setLLM({ model: 'gpt-image-1' });
    renderModal();
    fireEvent.click(screen.getByTestId('pb-chip-a portrait of a person'));
    const rec = screen.getByTestId('prompt-builder-recommendation');
    expect(rec).toHaveTextContent('size');

    fireEvent.click(screen.getByTestId('prompt-builder-apply-recommendation-btn'));
    expect(useLLM.getState().size).toBe('1024x1536');
    expect(useLLM.getState().aspect_ratio).toBe('16:9'); // aspect_ratio left untouched
    expect(screen.queryByTestId('prompt-builder-recommendation')).toBeNull();
  });

  it('Clear resets the selections', () => {
    renderModal();
    fireEvent.click(screen.getByTestId('pb-chip-a lone figure'));
    expect(screen.getByTestId('prompt-builder-preview')).toHaveTextContent('A lone figure.');
    fireEvent.click(screen.getByTestId('prompt-builder-clear-btn'));
    expect(screen.getByTestId('prompt-builder-apply-btn')).toBeDisabled();
  });
});
