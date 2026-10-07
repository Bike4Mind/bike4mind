import { Alert, Button } from '@mui/joy';
import WarningAmberRoundedIcon from '@mui/icons-material/WarningAmberRounded';
import ErrorOutlineRoundedIcon from '@mui/icons-material/ErrorOutlineRounded';
import { FC } from 'react';
import { useUser } from '@client/app/contexts/UserContext';
import { useFileBrowser } from '@client/app/components/Files/fileBrowserStore';
import {
  checkStorageForUpload,
  getStorageQuota,
  storageExceededMessage,
  storageNearLimitMessage,
} from '@client/app/utils/storageQuota';

interface StorageLimitNoticeProps {
  /** Total size of the files about to be uploaded. */
  uploadBytes: number;
  /** Replaces the default of opening the file browser, e.g. when it is already open underneath. */
  onManageFiles?: () => void;
}

/** Renders nothing while the upload fits comfortably under the current user's storage limit. */
const StorageLimitNotice: FC<StorageLimitNoticeProps> = ({ uploadBytes, onManageFiles }) => {
  const currentUser = useUser(s => s.currentUser);
  const setFileBrowserOpen = useFileBrowser(s => s.setOpen);
  const check = checkStorageForUpload(getStorageQuota(currentUser), uploadBytes);

  if (check.status === 'ok') return null;

  const exceeds = check.status === 'exceeds';
  return (
    <Alert
      data-testid={exceeds ? 'storage-limit-exceeded-alert' : 'storage-limit-near-alert'}
      color={exceeds ? 'danger' : 'warning'}
      variant="soft"
      startDecorator={exceeds ? <ErrorOutlineRoundedIcon /> : <WarningAmberRoundedIcon />}
      endDecorator={
        <Button
          data-testid="storage-limit-manage-files-btn"
          size="sm"
          variant="plain"
          color={exceeds ? 'danger' : 'warning'}
          onClick={onManageFiles ?? (() => setFileBrowserOpen(true))}
        >
          Manage files
        </Button>
      }
    >
      {exceeds ? storageExceededMessage(check) : storageNearLimitMessage(check)}
    </Alert>
  );
};

export default StorageLimitNotice;
