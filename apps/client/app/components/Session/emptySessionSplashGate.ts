interface EmptySessionSplashGateArgs {
  /** Whether the host page provided splash content at all. */
  hasSplash: boolean;
  /** Raw (unfiltered) quest count for the session. */
  questCount: number;
  /** Quests query still in flight — bias to hidden so sessions with history never flash the splash. */
  isFetching: boolean;
  /** A message is streaming or optimistically pending (isStreaming || showOptimisticSpinner). */
  hasActiveQuest: boolean;
}

/**
 * Gate for SessionMiddle's opt-in empty-session splash: only a loaded,
 * genuinely empty session with nothing in flight shows it. Kept pure so the
 * hide-on-first-send semantics are unit-testable without SessionMiddle's
 * context web.
 */
export function shouldShowEmptySessionSplash({
  hasSplash,
  questCount,
  isFetching,
  hasActiveQuest,
}: EmptySessionSplashGateArgs): boolean {
  return hasSplash && questCount === 0 && !isFetching && !hasActiveQuest;
}
