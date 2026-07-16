import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { CssVarsProvider } from '@mui/joy/styles';

const { mockApply } = vi.hoisted(() => ({ mockApply: vi.fn() }));

const templates = [
  { id: 't1', userId: 'u1', name: 'Flux One', model: 'flux-pro-1.1', settings: { quality: 'hd' }, usageCount: 0 },
  { id: 't2', userId: 'u1', name: 'GPT Two', model: 'gpt-image-1', settings: { quality: 'hd' }, usageCount: 0 },
];

vi.mock('../../../hooks/data/imageTemplates', () => ({
  useImageTemplates: () => ({ data: templates }),
  useApplyImageTemplate: () => ({ mutateAsync: mockApply }),
  useCreateImageTemplate: () => ({ mutateAsync: vi.fn(), isPending: false }),
  useDeleteImageTemplate: () => ({ mutateAsync: vi.fn() }),
}));

vi.mock('../../../hooks/data/useModelInfo', () => ({
  useModelInfo: () => ({ data: [{ id: 'flux-pro-1.1', name: 'Flux Pro 1.1' }] }),
}));

import { useLLM } from '@client/app/contexts/LLMContext';
import { ImageTemplateControls } from './ImageTemplateControls';

const TestWrapper = ({ children }: { children: React.ReactNode }) => <CssVarsProvider>{children}</CssVarsProvider>;

describe('ImageTemplateControls', () => {
  beforeEach(() => {
    mockApply.mockReset();
    useLLM.getState().resetSettings();
    useLLM.setState({ model: 'flux-pro-1.1', currentTemplateId: null });
  });

  it('offers only templates bound to the active model (exact-model)', () => {
    render(
      <TestWrapper>
        <ImageTemplateControls />
      </TestWrapper>
    );
    fireEvent.click(screen.getByTestId('image-templates-toggle'));

    const items = screen.getAllByTestId('image-template-apply-item');
    expect(items).toHaveLength(1);
    expect(items[0]).toHaveTextContent('Flux One');
    // The gpt-image-1 template must not be offered while a flux model is active.
    expect(screen.queryByText('GPT Two')).toBeNull();
  });

  it('shows the applied-template chip for the current template and clears it on click', () => {
    useLLM.setState({ currentTemplateId: 't1' });
    render(
      <TestWrapper>
        <ImageTemplateControls />
      </TestWrapper>
    );

    expect(screen.getByTestId('applied-template-chip')).toHaveTextContent('Flux One');

    fireEvent.click(screen.getByTestId('applied-template-clear'));
    expect(useLLM.getState().currentTemplateId).toBeNull();
  });
});
