import { useEffect, useState } from 'react';
import type { ChatProject } from '@shared/chat';
import type { WorkspaceChanges } from '@shared/workspaceChanges';

interface KeyedReading {
  of: string | null;
  changes: WorkspaceChanges | null;
}

/**
 * The open Code session's changes against its base, for the changes bar.
 *
 * Re-read on the same two cues useBranches (SessionChips) uses: a reply ending, which is when the
 * agent's own edits land, and window focus, which is when the user may have committed or edited
 * in a terminal. Not polled - between those two nothing this bar shows can change on its own.
 *
 * Keyed on the session and where it runs, so a switch, or the first turn cutting the worktree,
 * never shows one folder's numbers under another's header.
 */
export function useWorkspaceChanges(
  sessionId: string | null,
  project: ChatProject | undefined,
  settledTurns: number
): WorkspaceChanges | null {
  const [reading, setReading] = useState<KeyedReading>({ of: null, changes: null });
  const [reread, setReread] = useState(0);

  useEffect(() => {
    const refresh = () => setReread(count => count + 1);
    window.addEventListener('focus', refresh);
    return () => window.removeEventListener('focus', refresh);
  }, []);

  const key =
    sessionId && project ? `${sessionId}\n${project.workingDirectory}\n${project.workspaceBranch ?? ''}` : null;

  useEffect(() => {
    if (!sessionId || !key) return;
    let current = true;
    window.b4m.chat.workspaceChanges(sessionId).then(
      changes => current && setReading({ of: key, changes }),
      // Main already logs its own failures and answers null; a rejected IPC call is the bridge
      // itself failing, and the right readout for that is still "nothing to show".
      () => current && setReading({ of: key, changes: null })
    );
    return () => {
      current = false;
    };
  }, [sessionId, key, settledTurns, reread]);

  return reading.of === key ? reading.changes : null;
}
