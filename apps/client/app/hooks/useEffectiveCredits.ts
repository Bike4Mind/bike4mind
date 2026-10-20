import { useEffect, useState } from 'react';
import { useSelectedAccount } from '@client/app/components/Credits/AccountSelector';
import { useUser } from '@client/app/contexts/UserContext';
import { useCreditSyncSignal } from '@client/app/hooks/useCreditSyncSignal';
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
 * Backstop for the post-turn hold when no sync ever lands (listener unmounted, request lost).
 * Must outlast the last `BALANCE_SYNC_DELAYS_MS` entry plus its round trip.
 */
export const POST_STREAM_HOLD_MAX_MS = 10000;

/**
 * Server-side credit reservation dips the balance to a worst-case value for
 * the duration of a turn, then reconciles it back up on settlement - correct
 * overdraw protection, but shown raw it reads as a glitch (dip then bounce).
 * While any turn is streaming, hold the balance at its pre-turn value. Streaming
 * ending (completion, error, or abort all clear `isAnyStreaming()` via
 * `resetStreaming`/`completeStreaming`) does not release it yet: the live value is
 * still the hold-dipped one until the settled balance lands. Release on the first of
 * a live-value change, a finished post-turn sync, or the backstop timeout.
 */
export function useEffectiveCredits(options?: UseEffectiveCreditsOptions): number {
  const { selectedAccount } = useSelectedAccount();
  const { currentUser } = useUser();
  const isAnyStreaming = useStreamingState(state => state.isAnyStreaming());
  const syncCount = useCreditSyncSignal(state => state.syncCount);

  const isTeamAccount = !!selectedAccount && !selectedAccount.personal;
  const liveCredits = isTeamAccount ? selectedAccount.credits : currentUser?.currentCredits || 0;
  const accountKey = isTeamAccount ? selectedAccount.id : 'personal';

  // "Adjusting state when a prop changes" pattern (react.dev) - tracking the
  // previous streaming flag alongside the frozen value lets the snapshot/release
  // happen synchronously during render on the idle<->streaming edge, with no
  // effect and no extra render pass.
  const [prevIsStreaming, setPrevIsStreaming] = useState(isAnyStreaming);
  const [frozenCredits, setFrozenCredits] = useState<number | null>(null);
  // Live value and sync count at the moment streaming ended; non-null while awaiting settlement.
  const [settleBaseline, setSettleBaseline] = useState<{ credits: number; syncCount: number } | null>(null);
  const [heldAccountKey, setHeldAccountKey] = useState(accountKey);

  // After streaming ends the hold releases on a live change, a finished post-turn pull, or the
  // backstop. If settlement landed before streaming ended, only the last pull or the backstop can
  // fire, so the chip shows the pre-turn balance meanwhile; deliberate, it avoids flashing the
  // reservation dip.
  if (accountKey !== heldAccountKey) {
    // A held value belongs to the previous account; mid-stream, re-snapshot the new one instead.
    setHeldAccountKey(accountKey);
    setPrevIsStreaming(isAnyStreaming);
    setFrozenCredits(isAnyStreaming ? liveCredits : null);
    setSettleBaseline(null);
  } else if (isAnyStreaming !== prevIsStreaming) {
    setPrevIsStreaming(isAnyStreaming);
    if (isAnyStreaming) {
      // A new turn starting before the last one settled must keep the older pre-turn value: the live
      // value is still hold-dipped and would become the new snapshot. The balance is therefore
      // overstated by the previous turn's cost until this turn settles.
      setFrozenCredits(frozenCredits ?? liveCredits);
      setSettleBaseline(null);
    } else {
      setSettleBaseline({ credits: liveCredits, syncCount });
    }
  } else if (
    settleBaseline &&
    !isAnyStreaming &&
    (liveCredits !== settleBaseline.credits || syncCount !== settleBaseline.syncCount)
  ) {
    setFrozenCredits(null);
    setSettleBaseline(null);
  }

  const awaitingSettlement = settleBaseline !== null;
  useEffect(() => {
    if (!awaitingSettlement) return;
    const timer = setTimeout(() => {
      setFrozenCredits(null);
      setSettleBaseline(null);
    }, POST_STREAM_HOLD_MAX_MS);
    return () => clearTimeout(timer);
  }, [awaitingSettlement]);

  if (options?.live) {
    return liveCredits;
  }
  return frozenCredits ?? liveCredits;
}
