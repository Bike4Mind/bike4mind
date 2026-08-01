import { toast } from 'sonner';
import { useSessions } from '@client/app/contexts/SessionsContext';
import { useUpdateSession } from '@client/app/hooks/data/sessions';
import useDataLakeMode from '@client/app/hooks/useDataLakeMode';

/**
 * Returns a setter that grounds/ungrounds the current chat in the user's Data Lakes.
 * It flips `forceKnowledgeRetrieval` on the session (never `surface`, so the chat stays in
 * the sidebar list) and drives the tree-left/chat-right surface via useDataLakeMode.
 * On /new (no session yet) it flips only the store; the first send then creates the grounded
 * session (see useSendMessage). A failed persist rolls the store + session back.
 *
 * Shared by the header DataLakeToggle and the tree's in-surface close button so the two
 * entry points can't drift on the never-touch-`surface` invariant.
 */
export default function useSetDataLakeMode() {
  const { currentSession, setCurrentSession } = useSessions();
  const setEnabled = useDataLakeMode(s => s.setEnabled);
  const { mutate: updateSession } = useUpdateSession();

  return (next: boolean) => {
    setEnabled(next);
    if (!currentSession) return;
    setCurrentSession({ ...currentSession, forceKnowledgeRetrieval: next });
    // Send ONLY the flipped field. Echoing the whole cached session would make the server
    // treat a stale knowledgeIds as an authoritative overwrite - re-adding a file another
    // actor removed and fanning it out to projects - which is far outside what a UI toggle
    // promises. The update schema is optional-per-field, so a minimal payload is complete.
    updateSession(
      { id: currentSession.id, forceKnowledgeRetrieval: next },
      {
        onError: () => {
          setEnabled(!next);
          setCurrentSession(currentSession);
          toast.error('Could not update Data Lake mode - please try again.');
        },
      }
    );
  };
}
