import { Button, DialogActions, DialogContent, DialogTitle, Modal, ModalDialog } from '@mui/joy';
import type { IFabFileDocument } from '@bike4mind/common';
import { useUser } from '@client/app/contexts/UserContext';
import { useRemoveFileFromDataLake } from '@client/app/hooks/data/dataLakes';

function cleanFileName(fileName: string): string {
  return fileName.replace(/\.[^/.]+$/, '').replace(/^\[.*?\]\s*/, '');
}

/**
 * The removal confirmation copy, branched on whether the acting user owns the file - shared so
 * `RemoveFileFromLakeDialog` below and `DataLakeExplorer`'s own hand-rolled confirm (which keeps
 * its distinct `datalake-tree-removefile-confirm` test id) cannot drift on what they promise.
 *
 * Both branches promise Undo: the restore path admits every removal the actor was able to
 * perform, with no ownership test and regardless of whether the lake held content tags on the
 * file, so the promise is safe either way and bounded only by the removal record's 30-minute TTL
 * (comfortably longer than the toast that offers it).
 *
 * The non-owner branch states only what is certain about post-removal reach. `file.userId` cannot
 * predict it: reach is the union of the per-file ACL (a direct share) and membership of any OTHER
 * accessible lake, and ownership is only one of three independent mechanisms - so a curator with
 * a direct share, or acting on a file that also lives in a second reachable lake, would be told
 * (wrongly) that they lose access.
 */
export function RemoveFileFromLakeCopy({
  isOwner,
  fileName,
  lakeName,
}: {
  isOwner: boolean;
  fileName: string;
  lakeName: string;
}) {
  const title = cleanFileName(fileName);
  if (isOwner) {
    return (
      <>
        &ldquo;{title}&rdquo; will be removed from &ldquo;{lakeName}&rdquo;. This is lake-scoped: the file stays in your
        Files list and any chats that use it, and its tags under this lake&apos;s prefix go with it. You can put it back
        with Undo, or by re-adding it to this lake.
      </>
    );
  }
  return (
    <>
      &ldquo;{title}&rdquo; will be removed from &ldquo;{lakeName}&rdquo;. This file is not deleted - it stays in its
      owner&apos;s Files list. If you reach it only through this lake, you will lose access once it leaves. You can put
      it back with Undo.
    </>
  );
}

interface RemoveFileFromLakeDialogProps {
  open: boolean;
  onClose: () => void;
  file: Pick<IFabFileDocument, 'id' | 'fileName' | 'userId'> | null;
  lakeName: string;
  dataLakeId: string;
  onRemoved?: () => void;
}

/**
 * The shared remove-from-lake confirmation, consolidating what were three near-verbatim modals
 * (DataLakeViewer's inner ArticlePanel, DataLakeArticlePanel) that had drifted apart on copy - all
 * three claimed the file "stays in your Files list", which is false for a curator / org admin /
 * platform admin acting on the lake owner's file. See `RemoveFileFromLakeCopy` for the fix.
 */
export default function RemoveFileFromLakeDialog({
  open,
  onClose,
  file,
  lakeName,
  dataLakeId,
  onRemoved,
}: RemoveFileFromLakeDialogProps) {
  const removeFile = useRemoveFileFromDataLake(dataLakeId);
  const currentUserId = useUser(s => s.currentUser?.id);

  if (!file) return null;
  const isOwner = !!currentUserId && file.userId === currentUserId;

  return (
    <Modal open={open} onClose={onClose}>
      <ModalDialog data-testid="datalake-removefile-confirm" role="alertdialog">
        <DialogTitle>Remove file from data lake?</DialogTitle>
        <DialogContent>
          <RemoveFileFromLakeCopy isOwner={isOwner} fileName={file.fileName} lakeName={lakeName} />
        </DialogContent>
        <DialogActions>
          <Button
            variant="solid"
            color="danger"
            data-testid="datalake-removefile-confirm-btn"
            loading={removeFile.isPending}
            onClick={() =>
              removeFile.mutate(file.id, {
                onSuccess: () => {
                  onClose();
                  onRemoved?.();
                },
              })
            }
          >
            Remove
          </Button>
          <Button variant="plain" color="neutral" onClick={onClose}>
            Cancel
          </Button>
        </DialogActions>
      </ModalDialog>
    </Modal>
  );
}
