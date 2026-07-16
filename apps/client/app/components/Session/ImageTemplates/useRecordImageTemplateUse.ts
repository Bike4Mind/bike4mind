import { useCallback } from 'react';
import { isImageModel } from '@client/app/utils/commands';
import { useLLM } from '@client/app/contexts/LLMContext';
import { useFeatureEnabled } from '@client/app/hooks/useFeatureEnabled';
import { useImageTemplates, useRecordTemplateUse } from '../../../hooks/data/imageTemplates';
import { findMatchingTemplate, imageTemplateSettingsSnapshot } from './settingsSnapshot';

/**
 * Returns a fire-and-forget callback that increments usageCount for the template
 * matching the CURRENT image settings, if any. Call it when a prompt is sent, so
 * usageCount reflects actual usage (settings-matched sends) rather than merely
 * applying a template. No-op unless the feature is enabled and an image model is active.
 */
export function useRecordImageTemplateUse() {
  const { isAdminFeatureEnabled } = useFeatureEnabled();
  const enabled = isAdminFeatureEnabled('EnableImageTemplates');
  const { data: templates } = useImageTemplates(enabled);
  const { mutate } = useRecordTemplateUse();

  return useCallback(() => {
    if (!enabled) return;
    // Read fresh settings: the send happens after the user may have tweaked them.
    const s = useLLM.getState();
    if (!isImageModel(s.model)) return;
    const match = findMatchingTemplate(templates ?? [], s.model, imageTemplateSettingsSnapshot(s));
    if (match) mutate(match.id);
  }, [enabled, templates, mutate]);
}
