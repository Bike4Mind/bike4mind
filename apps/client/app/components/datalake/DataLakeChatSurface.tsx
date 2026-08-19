import { useCallback, useEffect } from 'react';
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
 * onManage/onCreateLake drive the tree header's gear (Manage Lakes) + blue "+" (Create Lake) via
 * the store-driven wizard/manager modals mounted app-wide in ProviderBundle (FileBrowser); without
 * them those header buttons don't render. Same wiring the retired /data-lakes route used.
 */
export default function DataLakeChatSurface({ chat }: { chat: React.ReactNode }) {
  const { currentSession } = useSessions();
  const enabled = useDataLakeMode(s => s.enabled);
  const seedFromSession = useDataLakeMode(s => s.seedFromSession);
  // Shared manage-knowledge capability (#841) - the gate and the open-manager wiring live in
  // core. No `requireAdmin`: as on /data-lakes, these are the user's OWN lakes.
  const { onManage } = useManageKnowledge();
  const openWizard = useDataLakeWizardStore(s => s.openWizard);
  const createDataLakeSession = useCreateDataLakeSession();

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
      chatSlot={chat}
      chatEmbedded
      onManage={onManage}
      onCreateLake={openWizard}
      createSessionForFile={createSessionForFile}
    />
  );
}
