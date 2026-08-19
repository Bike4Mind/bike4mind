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
  /** Fires once the owner dismisses the receipt, so the host can drop its selection. */
  onPurged?: () => void;
}

/**
 * The permanent-deletion door for one lake document: button, confirmation, and the receipt that
 * follows. Shared by every lake read pane rather than inlined per panel, because the copy is the
 * safety mechanism here - a surface that words the blast radius differently, or drops the receipt,
 * is the failure mode this action exists to prevent.
 *
 * The receipt dialog is not optional chrome. It is the only thing that tells an owner apart a
 * deletion that ran from one that silently did nothing, and it reports the server's own `verified`
 * verdict rather than assuming a 200 means the content is gone.
 *
 * Owner-or-admin only, and one rung narrower than the reversible Remove beside it: hosts gate it on
 * the lake's effective ownership (`canPurge`), not on `canManage`, so a curator or org admin never
 * meets a red button that refuses after the confirmation. `purgeDataLakeDocument` enforces the same
 * rule server-side.
 */
export default function PurgeLakeDocumentAction({ file, title, dataLakeId, onPurged }: PurgeLakeDocumentActionProps) {
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
            This destroys the document, every chunk of it, and the vectors those chunks carry. It is not limited to this
            data lake: the file also leaves your Files list, any chat that references it, and any other data lake it
            belongs to. Nothing restores it. You will get a receipt confirming what was destroyed.
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
            <Typography level="body-xs" sx={{ mt: 0.5, color: 'text.tertiary' }}>
              Recorded at {receipt?.purgedAt}
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
