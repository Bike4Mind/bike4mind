import { useCallback } from 'react';
import { isImageModel } from '@client/app/utils/commands';
import { useLLM } from '@client/app/contexts/LLMContext';
import { useFeatureEnabled } from '@client/app/hooks/useFeatureEnabled';
import { useAdvancedAISettings } from '../AISettings/useAdvancedAISettingsStore';
import { useImageTemplates, useRecordTemplateUse } from '../../../hooks/data/imageTemplates';
import { findMatchingTemplate, imageTemplateSettingsSnapshot } from './settingsSnapshot';

/**
 * Whether a sent prompt should count a template use: only normal generation
 * sends, not user-typed slash commands. Check the ORIGINAL prompt here - the
 * send path later derives a `/gen_image` "command" from it, so gating on that
 * derived command would (wrongly) suppress every real generation.
 */
export function isTemplateUseEligiblePrompt(prompt: string): boolean {
  return !prompt.trimStart().startsWith('/');
}

/**
 * Returns a fire-and-forget callback that increments usageCount for the template
 * matching the CURRENT image settings, if any. Call it when a prompt is sent, so
 * usageCount reflects actual usage (settings-matched sends) rather than merely
 * applying a template. No-op unless the feature is enabled, the AI toggle is on,
 * and an image model is active.
 */
export function useRecordImageTemplateUse() {
  const { isAdminFeatureEnabled } = useFeatureEnabled();
  const enabled = isAdminFeatureEnabled('EnableImageTemplates');
  const { data: templates } = useImageTemplates(enabled);
  const { mutate } = useRecordTemplateUse();

  return useCallback(() => {
    if (!enabled) return;
    // Only count when the AI is actually generating (the Use AI toggle is on);
    // with it off the send produces no image.
    if (!useAdvancedAISettings.getState().liveAI) return;
    // Read fresh settings: the send happens after the user may have tweaked them.
    const s = useLLM.getState();
    if (!isImageModel(s.model)) return;
    const match = findMatchingTemplate(templates ?? [], s.model, imageTemplateSettingsSnapshot(s));
    if (match) mutate(match.id);
  }, [enabled, templates, mutate]);
}
