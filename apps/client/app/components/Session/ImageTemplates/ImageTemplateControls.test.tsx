import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { CssVarsProvider } from '@mui/joy/styles';

const { mockApply, holder } = vi.hoisted(() => ({
  mockApply: vi.fn(),
  holder: { templates: [] as any[] },
}));

vi.mock('../../../hooks/data/imageTemplates', () => ({
  useImageTemplates: () => ({ data: holder.templates }),
  useApplyImageTemplate: () => ({ mutateAsync: mockApply }),
  useCreateImageTemplate: () => ({ mutateAsync: vi.fn(), isPending: false }),
  useDeleteImageTemplate: () => ({ mutateAsync: vi.fn() }),
}));

vi.mock('../../../hooks/data/useModelInfo', () => ({
  useModelInfo: () => ({ data: [{ id: 'flux-pro-1.1', name: 'Flux Pro 1.1' }] }),
}));

import { useLLM } from '@client/app/contexts/LLMContext';
import { ImageTemplateControls } from './ImageTemplateControls';
import { imageTemplateSettingsSnapshot } from './settingsSnapshot';

const TestWrapper = ({ children }: { children: React.ReactNode }) => <CssVarsProvider>{children}</CssVarsProvider>;

/** Snapshot of the CURRENT store settings - what a saved template must equal to match. */
const currentSnapshot = () => imageTemplateSettingsSnapshot(useLLM.getState());

describe('ImageTemplateControls', () => {
  beforeEach(() => {
    mockApply.mockReset();
    holder.templates = [];
    useLLM.getState().resetSettings();
    useLLM.setState({ model: 'flux-pro-1.1' });
  });

  it('offers only templates bound to the active model (exact-model)', () => {
    holder.templates = [
      { id: 't1', userId: 'u1', name: 'Flux One', model: 'flux-pro-1.1', settings: { quality: 'hd' }, usageCount: 0 },
      { id: 't2', userId: 'u1', name: 'GPT Two', model: 'gpt-image-1', settings: { quality: 'hd' }, usageCount: 0 },
    ];
    render(
      <TestWrapper>
        <ImageTemplateControls />
      </TestWrapper>
    );
    fireEvent.click(screen.getByTestId('image-templates-toggle'));

    const items = screen.getAllByTestId('image-template-apply-item');
    expect(items).toHaveLength(1);
    expect(items[0]).toHaveTextContent('Flux One');
    expect(screen.queryByText('GPT Two')).toBeNull();
  });

  it('shows the indicator when current settings match a template - without an explicit apply', () => {
    // Template whose settings equal the CURRENT store snapshot -> derived match.
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
  });

  it('hides the indicator once settings drift away from the template', () => {
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
    // Drift a setting so the snapshot no longer equals the template.
    useLLM.getState().setLLM({ seed: 12345 });
    render(
      <TestWrapper>
        <ImageTemplateControls />
      </TestWrapper>
    );
    expect(screen.queryByTestId('applied-template-chip')).toBeNull();
  });
});
