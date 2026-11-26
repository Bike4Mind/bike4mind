import { useEffect, useRef } from 'react';
import useSessionLayout from '@client/app/hooks/useSessionLayout';
import type { TutorialStepProps } from '../types';

/**
 * Waits for the user to open an artifact in the viewer beside the chat. Any artifact counts, and only an open
 * that happens while the step is up: a viewer restored from an earlier visit does not move it on.
 */
export function ArtifactOpenStep({ complete }: TutorialStepProps) {
  // The runner hands a fresh `complete` each render; the store listener stays subscribed once.
  const completeRef = useRef(complete);
  useEffect(() => {
    completeRef.current = complete;
  });
  useEffect(
    () =>
      useSessionLayout.subscribe((state, prior) => {
        if (state.layout !== 'hide' && state.artifactData && state.artifactData !== prior.artifactData) {
          completeRef.current();
        }
      }),
    []
  );
  return null;
}
