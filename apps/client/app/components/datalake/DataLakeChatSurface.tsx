import { useEffect } from 'react';
import { useSessions } from '@client/app/contexts/SessionsContext';
import useDataLakeMode from '@client/app/hooks/useDataLakeMode';
import DataLakeExplorer from './DataLakeExplorer';

/**
 * Wraps a chat node with the Data Lake tree (left) when Data Lake mode is on for the current
 * session; otherwise renders the chat as-is. Seeds the mode store from the session's
 * forceKnowledgeRetrieval whenever the session identity changes. See datalake-in-chat-mode design.
 */
export default function DataLakeChatSurface({ chat }: { chat: React.ReactNode }) {
  const { currentSession } = useSessions();
  const enabled = useDataLakeMode(s => s.enabled);
  const seedFromSession = useDataLakeMode(s => s.seedFromSession);

  useEffect(() => {
    seedFromSession(currentSession);
  }, [currentSession, seedFromSession]);

  if (!enabled) return <>{chat}</>;

  return <DataLakeExplorer source="datalakes" rootLabel="Data Lakes" chatSlot={chat} />;
}
