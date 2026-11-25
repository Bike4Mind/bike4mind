import { useEffect, useRef } from 'react';
import { isImageModel } from '@bike4mind/common';
import { useAdvancedAISettings } from '@client/app/components/Session/AISettings/useAdvancedAISettingsStore';
import { useLLM } from '@client/app/contexts/LLMContext';
import type { TutorialStepProps } from '../types';

/**
 * Waits for the user to pick a different chat model. An image model does not count: the follow-up would go to
 * image generation instead of the recorded reply. Only the user's own pick moves the step on: restoring a
 * notebook's pinned model on load changes the model too, but leaves the explicit-selection flag down.
 *
 * While the picker is open the card docks (the picker fills a phone screen) and shows the step's shorter
 * `doneBody`, so it covers less of the list.
 */
export function ModelSwitchStep({ complete, setAnchor, markDone }: TutorialStepProps) {
  const open = useAdvancedAISettings(state => state.showAdvancedSettings);
  useEffect(() => {
    setAnchor(open ? '' : undefined);
    markDone?.(open);
  }, [open, setAnchor, markDone]);

  // The runner hands a fresh `complete` each render; the store listener stays subscribed once.
  const completeRef = useRef(complete);
  useEffect(() => {
    completeRef.current = complete;
  });
  useEffect(
    () =>
      useLLM.subscribe((state, prior) => {
        if (state.model !== prior.model && state.hasExplicitSessionModelSelection && !isImageModel(state.model))
          completeRef.current();
      }),
    []
  );

  return null;
}
