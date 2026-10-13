import { useEffect, useRef, useState } from 'react';
import { useUser } from '@client/app/contexts/UserContext';
import { useLakeDriveCanManage, useLakeDriveConnection } from '@client/app/hooks/data/googleDrive';
import { useLakeDriveFolderConnect } from '@client/app/hooks/data/useLakeDriveFolderConnect';
import { takeDriveLakeResyncResume } from '@client/app/utils/driveConnectHandoff';

/**
 * Finishes the Re-sync/Reconnect that sent the user to Google consent from DriveConnectAction. The
 * callback route reopens the manager on that lake, but the manager does not render DriveConnectAction
 * for a bound folder, so this - mounted once in DataLakeManagerPanel - is the signal's only consumer.
 * Renders nothing.
 */
export default function DriveLakeResyncResume() {
  const [lakeId, setLakeId] = useState<string | null>(null);

  useEffect(() => {
    const pending = takeDriveLakeResyncResume(useUser.getState().currentUser?.id);
    if (pending) setLakeId(pending);
    // Mount-only: the panel mounts as the callback opens it, which is when the signal is meaningful.
  }, []);

  return lakeId ? <ResyncOnceLoaded lakeId={lakeId} /> : null;
}

function ResyncOnceLoaded({ lakeId }: { lakeId: string }) {
  const { data: connection } = useLakeDriveConnection(lakeId);
  const canManage = useLakeDriveCanManage(lakeId).data === true;
  const { resync } = useLakeDriveFolderConnect(lakeId);
  const fired = useRef(false);

  useEffect(() => {
    if (fired.current || !connection || !canManage || connection.disconnecting) return;
    fired.current = true;
    void resync({ driveFolderId: connection.driveFolderId, folderName: connection.folderName ?? undefined });
    // eslint-disable-next-line react-hooks/exhaustive-deps -- fires once, on the first load that can act
  }, [connection, canManage]);

  return null;
}
