import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook } from '@testing-library/react';

const { mockMutate, holder } = vi.hoisted(() => ({
  mockMutate: vi.fn(),
  holder: { templates: [] as any[], enabled: true },
}));

vi.mock('../../../hooks/data/imageTemplates', () => ({
  useImageTemplates: () => ({ data: holder.templates }),
  useRecordTemplateUse: () => ({ mutate: mockMutate }),
}));

vi.mock('@client/app/hooks/useFeatureEnabled', () => ({
  useFeatureEnabled: () => ({ isAdminFeatureEnabled: () => holder.enabled }),
}));

import { useLLM } from '@client/app/contexts/LLMContext';
import { useRecordImageTemplateUse } from './useRecordImageTemplateUse';
import { imageTemplateSettingsSnapshot } from './settingsSnapshot';

const matchingTemplate = () => ({
  id: 't1',
  userId: 'u1',
  name: 'Match',
  model: 'flux-pro-1.1',
  settings: imageTemplateSettingsSnapshot(useLLM.getState()),
  usageCount: 0,
});

describe('useRecordImageTemplateUse', () => {
  beforeEach(() => {
    mockMutate.mockReset();
    holder.templates = [];
    holder.enabled = true;
    useLLM.getState().resetSettings();
    useLLM.setState({ model: 'flux-pro-1.1' });
  });

  it('fires increment for the template matching current settings', () => {
    holder.templates = [matchingTemplate()];
    const { result } = renderHook(() => useRecordImageTemplateUse());
    result.current();
    expect(mockMutate).toHaveBeenCalledWith('t1');
  });

  it('no-op when no template matches the current settings', () => {
    holder.templates = [{ id: 't1', model: 'flux-pro-1.1', settings: { seed: 99999 } }];
    const { result } = renderHook(() => useRecordImageTemplateUse());
    result.current();
    expect(mockMutate).not.toHaveBeenCalled();
  });

  it('no-op on a non-image model', () => {
    holder.templates = [matchingTemplate()];
    useLLM.setState({ model: 'gpt-4o' });
    const { result } = renderHook(() => useRecordImageTemplateUse());
    result.current();
    expect(mockMutate).not.toHaveBeenCalled();
  });

  it('no-op when the feature flag is off', () => {
    holder.enabled = false;
    holder.templates = [matchingTemplate()];
    const { result } = renderHook(() => useRecordImageTemplateUse());
    result.current();
    expect(mockMutate).not.toHaveBeenCalled();
  });
});
