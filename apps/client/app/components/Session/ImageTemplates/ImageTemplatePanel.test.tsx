import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { CssVarsProvider } from '@mui/joy/styles';

const { mockCreate, mockDelete, holder } = vi.hoisted(() => ({
  mockCreate: vi.fn(),
  mockDelete: vi.fn(),
  holder: { templates: [] as any[], enabled: true },
}));

vi.mock('../../../hooks/data/imageTemplates', () => ({
  useImageTemplates: () => ({ data: holder.templates, isLoading: false }),
  useCreateImageTemplate: () => ({ mutateAsync: mockCreate, isPending: false }),
  useDeleteImageTemplate: () => ({ mutateAsync: mockDelete, isPending: false }),
}));

vi.mock('@client/app/hooks/useFeatureEnabled', () => ({
  useFeatureEnabled: () => ({ isAdminFeatureEnabled: () => holder.enabled }),
}));

import { useLLM } from '@client/app/contexts/LLMContext';
import { ImageTemplatePanel } from './ImageTemplatePanel';
import { imageTemplateSettingsSnapshot } from './settingsSnapshot';

const TestWrapper = ({ children }: { children: React.ReactNode }) => <CssVarsProvider>{children}</CssVarsProvider>;
const renderPanel = () =>
  render(
    <TestWrapper>
      <ImageTemplatePanel />
    </TestWrapper>
  );

describe('ImageTemplatePanel', () => {
  beforeEach(() => {
    mockCreate.mockReset().mockResolvedValue({ id: 'new' });
    mockDelete.mockReset().mockResolvedValue(undefined);
    holder.templates = [];
    holder.enabled = true;
    useLLM.getState().resetSettings();
    useLLM.setState({ model: 'flux-pro-1.1' });
  });

  it('renders nothing when the feature flag is off', () => {
    holder.enabled = false;
    renderPanel();
    expect(screen.queryByTestId('image-template-panel')).toBeNull();
  });

  it('lists only active-model templates and flags the applied one', () => {
    holder.templates = [
      {
        id: 't1',
        userId: 'u1',
        name: 'Applied One',
        model: 'flux-pro-1.1',
        settings: imageTemplateSettingsSnapshot(useLLM.getState()),
        usageCount: 0,
      },
      { id: 't2', userId: 'u1', name: 'GPT One', model: 'gpt-image-1', settings: { quality: 'hd' }, usageCount: 0 },
    ];
    renderPanel();
    const cards = screen.getAllByTestId('panel-template-card');
    expect(cards).toHaveLength(1);
    expect(cards[0]).toHaveTextContent('Applied One');
    expect(screen.getByTestId('panel-applied-chip')).toBeTruthy();
  });

  it('applies a template on card click (settings load into the store)', () => {
    holder.templates = [
      { id: 't1', userId: 'u1', name: 'HD Preset', model: 'flux-pro-1.1', settings: { quality: 'hd' }, usageCount: 0 },
    ];
    renderPanel();
    fireEvent.click(screen.getByTestId('panel-template-card'));
    expect(useLLM.getState().quality).toBe('hd');
  });

  it('saves the current settings as a new template', () => {
    renderPanel();
    fireEvent.change(screen.getByTestId('panel-save-name-input'), { target: { value: 'My Preset' } });
    fireEvent.click(screen.getByTestId('panel-save-btn'));
    expect(mockCreate).toHaveBeenCalledWith(expect.objectContaining({ name: 'My Preset', model: 'flux-pro-1.1' }));
  });

  it('requires a confirm before deleting', () => {
    holder.templates = [
      { id: 't1', userId: 'u1', name: 'Doomed', model: 'flux-pro-1.1', settings: { quality: 'hd' }, usageCount: 0 },
    ];
    renderPanel();
    fireEvent.click(screen.getByTestId('panel-delete-btn'));
    expect(mockDelete).not.toHaveBeenCalled();
    fireEvent.click(screen.getByTestId('panel-confirm-delete-btn'));
    expect(mockDelete).toHaveBeenCalledWith('t1');
  });
});
