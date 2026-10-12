import { useState } from 'react';
import { toast } from 'sonner';
import { useUser } from '@client/app/contexts/UserContext';
import { activeOrgId } from '@client/app/hooks/data/dataLakes';
import { fetchDriveAccessToken } from '@client/app/hooks/data/driveAccessToken';
import { startGoogleDriveConnect, useConnectDriveFolderToLake } from '@client/app/hooks/data/googleDrive';
import { useDriveFolderPicker, type PickedDriveFolder } from '@client/app/hooks/data/useDriveFolderPicker';
import { saveDriveConnectHandoff } from '@client/app/utils/driveConnectHandoff';
import { getServerErrorField } from '@client/app/utils/error';

/**
 * Bind a Drive folder to an existing lake, toasting the outcome. Shared by DriveConnectAction and
 * FinishSourceConnectBanner.
 *
 * - `openFolderPicker`: pick a folder, then connect it. A user with no linked Google account is sent
 *   to consent by the picker (see useDriveFolderPicker); the handoff saved for that attempt lets the
 *   Drive callback route reopen this lake in the manager, where they pick the folder.
 * - `resync`: re-sync the folder the lake is already bound to - no picker. The grant is checked first,
 *   and one that no longer refreshes goes through consent and syncs on return (DriveLakeResyncResume).
 *   A grant revoked while its cached access token is still in date passes the check; drive-sync then
 *   reports the folder unreadable.
 * - `reconnect`: always through consent, then the same re-sync. For a connection in credential_error,
 *   where only a fresh grant helps: drive-sync copies it onto the connection and clears the error.
 */
export function useLakeDriveFolderConnect(lakeId: string) {
  const connect = useConnectDriveFolderToLake();
  const [isCheckingGrant, setIsCheckingGrant] = useState(false);

  const saveHandoff = (authUrl: string, resync: boolean) => {
    const userId = useUser.getState().currentUser?.id;
    if (!userId) return;
    saveDriveConnectHandoff(
      { kind: 'lake', userId, organizationId: activeOrgId() ?? null, dataLakeId: lakeId, ...(resync && { resync }) },
      authUrl
    );
  };

  const connectFolder = (folder: PickedDriveFolder) =>
    connect.mutate(
      { dataLakeId: lakeId, ...folder },
      {
        onSuccess: () => toast.success(`Syncing "${folder.folderName || folder.driveFolderId}" into this data lake...`),
        // Surface the server's specific message (folder claimed elsewhere, lake already bound to a
        // different folder, "reconnect required", ...) rather than one generic string for every 4xx.
        onError: (e: unknown) =>
          toast.error(getServerErrorField(e) || 'Could not connect that folder. Please try again.'),
      }
    );

  const { openFolderPicker, isPicking } = useDriveFolderPicker({
    busy: connect.isPending || isCheckingGrant,
    onBeforeRedirect: authUrl => saveHandoff(authUrl, false),
    onPicked: connectFolder,
  });

  const isBusy = isPicking || isCheckingGrant || connect.isPending;

  const resync = async (folder: PickedDriveFolder) => {
    if (isBusy) return;
    setIsCheckingGrant(true);
    try {
      const token = await fetchDriveAccessToken();
      if (token.kind === 'consent') {
        saveHandoff(token.authUrl, true);
        window.location.href = token.authUrl; // stays busy until the page unloads
        return;
      }
      setIsCheckingGrant(false);
      if (token.kind === 'unavailable') {
        toast.error('Google Drive is unavailable right now. Please try again.');
        return;
      }
      connectFolder(folder);
    } catch {
      setIsCheckingGrant(false);
      toast.error('Could not reach Google Drive. Please try again.');
    }
  };

  const reconnect = async () => {
    if (isBusy) return;
    setIsCheckingGrant(true);
    try {
      await startGoogleDriveConnect(authUrl => saveHandoff(authUrl, true));
    } catch {
      setIsCheckingGrant(false);
      toast.error('Could not reach Google Drive. Please try again.');
    }
  };

  return {
    openFolderPicker,
    resync,
    reconnect,
    isPicking,
    isCheckingGrant,
    isConnecting: connect.isPending,
  };
}
