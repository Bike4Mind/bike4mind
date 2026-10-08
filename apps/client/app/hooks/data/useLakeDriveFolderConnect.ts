import { toast } from 'sonner';
import { useUser } from '@client/app/contexts/UserContext';
import { activeOrgId } from '@client/app/hooks/data/dataLakes';
import { useConnectDriveFolderToLake } from '@client/app/hooks/data/googleDrive';
import { useDriveFolderPicker } from '@client/app/hooks/data/useDriveFolderPicker';
import { saveDriveConnectHandoff } from '@client/app/utils/driveConnectHandoff';
import { getServerErrorField } from '@client/app/utils/error';

/**
 * Pick a Drive folder and bind it to an existing lake straight away, toasting the outcome. Shared by
 * DriveConnectAction and FinishSourceConnectBanner. A user with no linked Google account is sent to
 * Google's consent screen by the picker (see useDriveFolderPicker); a handoff saved for that attempt
 * lets the Drive callback route reopen this lake in the manager, where they pick the folder.
 */
export function useLakeDriveFolderConnect(lakeId: string) {
  const connect = useConnectDriveFolderToLake();

  const { openFolderPicker, isPicking } = useDriveFolderPicker({
    busy: connect.isPending,
    onBeforeRedirect: authUrl => {
      const userId = useUser.getState().currentUser?.id;
      if (!userId) return;
      saveDriveConnectHandoff(
        { kind: 'lake', userId, organizationId: activeOrgId() ?? null, dataLakeId: lakeId },
        authUrl
      );
    },
    onPicked: folder =>
      connect.mutate(
        { dataLakeId: lakeId, ...folder },
        {
          onSuccess: () =>
            toast.success(`Syncing "${folder.folderName || folder.driveFolderId}" into this data lake...`),
          // Surface the server's specific message (folder claimed elsewhere, lake already bound to a
          // different folder, "connect Drive first", ...) rather than one generic string for every 409.
          onError: (e: unknown) =>
            toast.error(getServerErrorField(e) || 'Could not connect that folder. Please try again.'),
        }
      ),
  });

  return { openFolderPicker, isPicking, isConnecting: connect.isPending };
}
