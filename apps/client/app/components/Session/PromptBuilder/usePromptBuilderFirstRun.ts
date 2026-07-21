import { useCallback, useState } from 'react';

const STORAGE_KEY = 'b4m.promptBuilder.seen';

/**
 * M3 first-run guidance: whether to nudge the user toward the (new) prompt
 * builder. Backed by localStorage (per-device), cleared the first time they open
 * the builder. Fails safe to "already seen" if localStorage is unavailable, so a
 * storage error never turns into a permanent nag.
 */
export function usePromptBuilderFirstRun() {
  const [seen, setSeen] = useState<boolean>(() => {
    try {
      return localStorage.getItem(STORAGE_KEY) === '1';
    } catch {
      return true;
    }
  });

  const markSeen = useCallback(() => {
    try {
      localStorage.setItem(STORAGE_KEY, '1');
    } catch {
      // ignore - the in-memory flag below still suppresses the nudge this session
    }
    setSeen(true);
  }, []);

  return { showHint: !seen, markSeen };
}
