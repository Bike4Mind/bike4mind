import { useState, type MouseEvent } from 'react';
import { Button, DialogActions, DialogContent, DialogTitle, Modal, ModalDialog, Stack } from '@mui/joy';
import type { ILoop } from '@bike4mind/common';
import { useDeleteLoop, useRunLoop, useUpdateLoop } from '@client/app/hooks/data/loops';
import LoopFormModal from './LoopFormModal';
import { canPause, canRunNow, canSetLive } from './loopUi';

/** Set live / pause / run now / edit / delete for one loop; shared by the list rows and the detail header. */
export default function LoopActions({ loop, onDeleted }: { loop: ILoop; onDeleted?: () => void }) {
  const [editing, setEditing] = useState(false);
  const [confirmingDelete, setConfirmingDelete] = useState(false);
  const updateLoop = useUpdateLoop();
  const runLoop = useRunLoop();
  const deleteLoop = useDeleteLoop();

  // Row clicks open the loop; the buttons must not.
  const act = (fn: () => void) => (e: MouseEvent) => {
    e.stopPropagation();
    fn();
  };

  return (
    <Stack direction="row" gap={0.5} onClick={e => e.stopPropagation()}>
      {canSetLive(loop.status) && (
        <Button
          size="sm"
          color="success"
          variant="soft"
          loading={updateLoop.isPending}
          onClick={act(() => updateLoop.mutate({ id: loop.id, status: 'live' }))}
          data-testid="loop-set-live-btn"
        >
          Set live
        </Button>
      )}
      {canPause(loop) && (
        <Button
          size="sm"
          color="warning"
          variant="soft"
          loading={updateLoop.isPending}
          onClick={act(() => updateLoop.mutate({ id: loop.id, status: 'paused' }))}
          data-testid="loop-pause-btn"
        >
          Pause
        </Button>
      )}
      {canRunNow(loop.status) && (
        <Button
          size="sm"
          variant="soft"
          loading={runLoop.isPending}
          onClick={act(() => runLoop.mutate(loop.id))}
          data-testid="loop-run-now-btn"
        >
          Run now
        </Button>
      )}
      <Button
        size="sm"
        variant="plain"
        color="neutral"
        onClick={act(() => setEditing(true))}
        data-testid="loop-edit-btn"
      >
        Edit
      </Button>
      <Button
        size="sm"
        variant="plain"
        color="danger"
        onClick={act(() => setConfirmingDelete(true))}
        data-testid="loop-delete-btn"
      >
        Delete
      </Button>

      {editing && <LoopFormModal open loop={loop} onClose={() => setEditing(false)} />}
      <Modal open={confirmingDelete} onClose={() => setConfirmingDelete(false)}>
        <ModalDialog role="alertdialog">
          <DialogTitle>Delete {loop.name}?</DialogTitle>
          <DialogContent>
            The loop stops and its tickets are removed. Its notebook and past runs are kept.
          </DialogContent>
          <DialogActions>
            <Button
              color="danger"
              loading={deleteLoop.isPending}
              onClick={() =>
                deleteLoop.mutate(loop.id, {
                  onSuccess: () => {
                    setConfirmingDelete(false);
                    onDeleted?.();
                  },
                })
              }
              data-testid="loop-delete-confirm-btn"
            >
              Delete
            </Button>
            <Button
              variant="plain"
              color="neutral"
              onClick={() => setConfirmingDelete(false)}
              data-testid="loop-delete-cancel-btn"
            >
              Cancel
            </Button>
          </DialogActions>
        </ModalDialog>
      </Modal>
    </Stack>
  );
}
