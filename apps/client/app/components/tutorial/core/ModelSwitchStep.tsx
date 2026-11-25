import { useEffect, useRef, useState } from 'react';
import { useLLM } from '@client/app/contexts/LLMContext';
import type { TutorialStepProps } from '../types';

/** Must stay in sync with AdvancedAIModal's root testid. */
export const MODEL_PICKER_MODAL = 'ai-settings-modal';

const pickerOpen = () => Boolean(document.querySelector(`[data-testid="${MODEL_PICKER_MODAL}"]`));

function usePickerOpen(): boolean {
  const [open, setOpen] = useState(pickerOpen);
  useEffect(() => {
    const sync = () => setOpen(pickerOpen());
    sync();
    const observer = new MutationObserver(sync);
    observer.observe(document.body, { childList: true, subtree: true });
    return () => observer.disconnect();
  }, []);
  return open;
}

/**
 * Waits for the user to pick a different model for the chat. Any model counts, so no deployment's catalogue can
 * strand the step. Only the user's own pick moves it on: restoring a notebook's pinned model on load changes the
 * model too, but leaves the explicit-selection flag down.
 *
 * While the picker is open the card docks (the picker fills a phone screen) and shows the step's shorter
 * `doneBody`, so it covers less of the list.
 */
export function ModelSwitchStep({ complete, setAnchor, markDone }: TutorialStepProps) {
  const open = usePickerOpen();
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
        if (state.model !== prior.model && state.hasExplicitSessionModelSelection) completeRef.current();
      }),
    []
  );

  return null;
}
