import { useState } from 'react';
import { Button, DialogActions, DialogContent, DialogTitle, Modal, ModalDialog, Tooltip, Typography } from '@mui/joy';
import DeleteForeverIcon from '@mui/icons-material/DeleteForever';
import type { DataLakeDocumentPurgeReceipt, IFabFileDocument } from '@bike4mind/common';
import { usePurgeDataLakeDocument } from '@client/app/hooks/data/dataLakes';

interface PurgeLakeDocumentActionProps {
  file: Pick<IFabFileDocument, 'id' | 'fileName'>;
  /** Display title, already cleaned by the host panel. */
  title: string;
  dataLakeId: string;
  /**
   * Fires the moment the server confirms the destruction, before the receipt is dismissed, so the
   * host can stop treating the file as readable. Without it the host pane goes on re-fetching the
   * now-dead signed URL behind the dialog.
   */
  onPurgeComplete?: () => void;
  /** Fires once the owner dismisses the receipt, so the host can drop its selection. */
  onPurged?: () => void;
}

/**
 * The permanent-deletion door for one lake document: button, confirmation, and the receipt that
 * follows. Shared by every lake read pane rather than inlined per panel, because the copy is the
 * safety mechanism here - a surface that words the blast radius differently, or drops the receipt,
 * is the failure mode this action exists to prevent.
 *
 * The copy is deliberately narrower than "every trace": an embedding of a purged chunk can survive
 * in the global EmbeddingCache, which is keyed by content hash and model with no file id, so no
 * delete path (this one or the whole-lake purge) can reach it. What is claimed here is what the
 * receipt can actually verify.
 *
 * The receipt dialog is not optional chrome. It is the only thing that tells an owner apart a
 * deletion that ran from one that silently did nothing, and it reports the server's own `verified`
 * verdict rather than assuming a 200 means the content is gone.
 *
 * Owner-or-admin only, and one rung narrower than the reversible Remove beside it: hosts gate it on
 * the lake's effective ownership AND the caller owning the file (`canPurge`), not on `canManage`, so
 * neither a curator nor a lake owner looking at a contributor's document meets a red button that
 * refuses after the confirmation. `purgeDataLakeDocument` enforces the same two-part rule
 * server-side.
 */
export default function PurgeLakeDocumentAction({
  file,
  title,
  dataLakeId,
  onPurgeComplete,
  onPurged,
}: PurgeLakeDocumentActionProps) {
  const purgeFile = usePurgeDataLakeDocument(dataLakeId);
  const [confirming, setConfirming] = useState(false);
  const [receipt, setReceipt] = useState<DataLakeDocumentPurgeReceipt | null>(null);

  const dismissReceipt = () => {
    setReceipt(null);
    onPurged?.();
  };

  return (
    <>
      <Tooltip title="Destroy this file, its chunks and its vectors everywhere" size="sm">
        <Button
          size="sm"
          variant="solid"
          color="danger"
          data-testid={`datalake-purgefile-btn-${file.id}`}
          startDecorator={<DeleteForeverIcon sx={{ fontSize: 16 }} />}
          loading={purgeFile.isPending}
          onClick={() => setConfirming(true)}
          sx={{ flexShrink: 0, fontSize: '13px' }}
        >
          Delete permanently
        </Button>
      </Tooltip>

      <Modal open={confirming} onClose={() => setConfirming(false)}>
        <ModalDialog data-testid="datalake-purgefile-confirm" role="alertdialog">
          <DialogTitle>Delete &ldquo;{title}&rdquo; permanently?</DialogTitle>
          <DialogContent>
            This destroys the document, every stored copy of it including earlier versions, every chunk of it, and the
            vectors those chunks carry. It is not limited to this data lake: the file also leaves the owner&apos;s Files
            list, any chat that references it, any other data lake it belongs to, and the facts this data lake distilled
            from it. Nothing restores it. You will get a receipt confirming what was destroyed.
          </DialogContent>
          <DialogActions>
            <Button
              variant="solid"
              color="danger"
              data-testid="datalake-purgefile-confirm-btn"
              loading={purgeFile.isPending}
              onClick={() =>
                purgeFile.mutate(file.id, {
                  onSuccess: result => {
                    setConfirming(false);
                    setReceipt(result);
                    onPurgeComplete?.();
                  },
                })
              }
            >
              Delete permanently
            </Button>
            <Button variant="plain" color="neutral" onClick={() => setConfirming(false)}>
              Cancel
            </Button>
          </DialogActions>
        </ModalDialog>
      </Modal>

      <Modal open={!!receipt} onClose={dismissReceipt}>
        <ModalDialog data-testid="datalake-purgefile-receipt">
          <DialogTitle>{receipt?.verified ? 'Deleted permanently' : 'Deletion did not finish'}</DialogTitle>
          <DialogContent>
            <Typography level="body-sm" data-testid="datalake-purgefile-receipt-summary">
              {receipt?.verified
                ? `"${receipt.fileName}" is gone. ${receipt.chunksBefore} chunk(s) and their vectors were destroyed, and the document was confirmed absent afterwards.`
                : `"${receipt?.fileName}" was not fully destroyed: ${receipt?.chunksRemaining} chunk(s) still remain${
                    receipt?.documentDeleted ? '' : ' and the document is still present'
                  }. The attempt has been recorded - retry, or contact support.`}
            </Typography>
            <Typography level="body-xs" sx={{ mt: 1.5, color: 'text.tertiary' }}>
              {receipt?.embeddingModels.length
                ? `Vector indexes reached: ${receipt.embeddingModels.join(', ')}.`
                : 'This document had no vectors.'}
            </Typography>
            {receipt && !receipt.storageObjectDeleted && (
              <Typography
                level="body-xs"
                data-testid="datalake-purgefile-receipt-storage"
                sx={{ mt: 0.5, color: 'warning.500' }}
              >
                {receipt.storageObjectsRemaining} of {receipt.storageObjectsTotal} stored cop
                {receipt.storageObjectsTotal === 1 ? 'y' : 'ies'} of this file could not be removed, so the document was
                left intact rather than stranded. The failure has been recorded; retry, or contact support.
              </Typography>
            )}
            <Typography level="body-xs" sx={{ mt: 0.5, color: 'text.tertiary' }}>
              Recorded at {receipt ? new Date(receipt.purgedAt).toLocaleString() : ''}
            </Typography>
          </DialogContent>
          <DialogActions>
            <Button
              variant="solid"
              color="neutral"
              data-testid="datalake-purgefile-receipt-close"
              onClick={dismissReceipt}
            >
              Close
            </Button>
          </DialogActions>
        </ModalDialog>
      </Modal>
    </>
  );
}
