import { useState } from 'react';
import { useSelectedAccount } from '@client/app/components/Credits/AccountSelector';
import { useUser } from '@client/app/contexts/UserContext';
import { useStreamingState } from '@client/app/hooks/useStreamingState';

interface UseEffectiveCreditsOptions {
  /**
   * Bypass the mid-turn freeze below and read the live balance. Used by
   * send-gating checks (exhausted/low-credit warnings, send validation) so a
   * genuine mid-turn exhaustion is still enforced even while the *displayed*
   * balance is held.
   */
  live?: boolean;
}

/**
 * Server-side credit reservation dips the balance to a worst-case value for
 * the duration of a turn, then reconciles it back up on settlement - correct
 * overdraw protection, but shown raw it reads as a glitch (dip then bounce).
 * While any turn is streaming, hold the balance at its pre-turn value and
 * release to the live value once streaming ends (completion, error, or
 * abort all clear `isAnyStreaming()` via `resetStreaming`/`completeStreaming`).
 */
export function useEffectiveCredits(options?: UseEffectiveCreditsOptions): number {
  const { selectedAccount } = useSelectedAccount();
  const { currentUser } = useUser();
  const isAnyStreaming = useStreamingState(state => state.isAnyStreaming());

  const liveCredits =
    selectedAccount && !selectedAccount.personal ? selectedAccount.credits : currentUser?.currentCredits || 0;

  // "Adjusting state when a prop changes" pattern (react.dev) - tracking the
  // previous streaming flag alongside the frozen value lets the snapshot/release
  // happen synchronously during render on the idle<->streaming edge, with no
  // effect and no extra render pass.
  const [prevIsStreaming, setPrevIsStreaming] = useState(isAnyStreaming);
  const [frozenCredits, setFrozenCredits] = useState<number | null>(null);
  if (isAnyStreaming !== prevIsStreaming) {
    setPrevIsStreaming(isAnyStreaming);
    setFrozenCredits(isAnyStreaming ? liveCredits : null);
  }

  if (options?.live) {
    return liveCredits;
  }
  return frozenCredits ?? liveCredits;
}
