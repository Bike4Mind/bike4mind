import { useEffect, useState } from 'react';
import { useChatInput } from '@client/app/hooks/useChatInput';
import { useStreamingState } from '@client/app/hooks/useStreamingState';
import { isAnyModalDialogOpen } from '@client/app/utils/anyDialogOpen';

/** How long the page must have been up before an offer may appear, in ms. */
export const CALM_SETTLE_MS = 1500;
/** How often a busy page is checked again, in ms. */
export const CALM_RECHECK_MS = 500;

/** Nothing competes for the user's attention: no modal, no reply streaming, nothing typed in the composer. */
export const pageIsCalm = (): boolean =>
  !isAnyModalDialogOpen() &&
  !useStreamingState.getState().isAnyStreaming() &&
  !useChatInput.getState().chatInputValue.trim();

/**
 * Turns true once the page has settled and is calm, then stays true, so an offer that appeared never flickers
 * away because the user started typing next to it.
 */
export function useCalmMoment(enabled = true): boolean {
  const [calm, setCalm] = useState(false);
  useEffect(() => {
    if (!enabled || calm) return;
    let timer: ReturnType<typeof setTimeout>;
    const check = () => {
      if (pageIsCalm()) setCalm(true);
      else timer = setTimeout(check, CALM_RECHECK_MS);
    };
    timer = setTimeout(check, CALM_SETTLE_MS);
    return () => clearTimeout(timer);
  }, [enabled, calm]);
  return calm;
}
