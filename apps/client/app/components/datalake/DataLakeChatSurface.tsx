import { useCallback, useEffect } from 'react';
import { useSearch } from '@tanstack/react-router';
import { useSessions } from '@client/app/contexts/SessionsContext';
import { useDataLakeWizardStore } from '@client/app/stores/useDataLakeWizardStore';
import useDataLakeMode from '@client/app/hooks/useDataLakeMode';
import useCreateDataLakeSession from '@client/app/hooks/useCreateDataLakeSession';
import DataLakeExplorer from './DataLakeExplorer';
import type { IFabFileDocument } from '@bike4mind/common';
import { useManageKnowledge } from './manageKnowledge';

/**
 * Wraps a chat node with the Data Lake tree (left) when Data Lake mode is on for the current
 * session; otherwise renders the chat as-is. Seeds the mode store from the session's
 * forceKnowledgeRetrieval whenever the session identity changes. See datalake-in-chat-mode design.
 *
 * This is the app's ONLY Data Lake surface (#1943), so it owns the wiring the retired /data-lakes
 * page used to: onManage/onCreateLake drive the tree's Manage / Create via the store-driven
 * wizard/manager modals mounted app-wide in ProviderBundle (FileBrowser), onDiscover opens that
 * manager's public-lake catalog, and `?article=` deep links (forwarded here by the retired route)
 * open in the viewer. Without those handlers the corresponding affordances don't render.
 */
export default function DataLakeChatSurface({ chat }: { chat: React.ReactNode }) {
  const { currentSession } = useSessions();
  const { article } = useSearch({ strict: false }) as { article?: string };
  const enabled = useDataLakeMode(s => s.enabled);
  const seedFromSession = useDataLakeMode(s => s.seedFromSession);
  // Shared manage-knowledge capability (#841) - the gate and the open-manager wiring live in
  // core. No `requireAdmin`: these are the user's OWN lakes.
  const { canManage, onManage } = useManageKnowledge();
  const openWizard = useDataLakeWizardStore(s => s.openWizard);
  const openManager = useDataLakeWizardStore(s => s.openManager);
  const createDataLakeSession = useCreateDataLakeSession();

  // Discover shares Manage's gate rather than carrying none: it deep-links the SAME
  // store-driven manager modal, whose panel renders nothing without EnableDataLakes (and
  // whose /api/data-lakes/public read is flag-gated too). Ungated it opened a full-screen
  // modal holding only a close button - the same dead end the manage button had.
  const onDiscover = canManage ? () => openManager('discover') : undefined;

  useEffect(() => {
    seedFromSession(currentSession);
  }, [currentSession, seedFromSession]);

  // Open/attach on /new: mint the grounded session right away (same creation the first-send
  // seam uses), born holding the file - adoption rehydrates the workbench from the session's
  // knowledgeIds, so a file written into the store after creation would be wiped by that reset.
  const createSessionForFile = useCallback(
    async (file: IFabFileDocument) => (await createDataLakeSession({ knowledgeIds: [file.id] })).id,
    [createDataLakeSession]
  );

  if (!enabled) return <>{chat}</>;

  return (
    <DataLakeExplorer
      source="datalakes"
      rootLabel="Data Lakes"
      articleId={article ?? null}
      chatSlot={chat}
      chatEmbedded
      onManage={onManage}
      onDiscover={onDiscover}
      onCreateLake={openWizard}
      createSessionForFile={createSessionForFile}
    />
  );
}
