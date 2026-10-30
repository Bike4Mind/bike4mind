import { useEffect, useState } from 'react';
import Alert from '@mui/joy/Alert';
import Button from '@mui/joy/Button';
import Checkbox from '@mui/joy/Checkbox';
import DialogActions from '@mui/joy/DialogActions';
import DialogContent from '@mui/joy/DialogContent';
import DialogTitle from '@mui/joy/DialogTitle';
import Modal from '@mui/joy/Modal';
import ModalDialog from '@mui/joy/ModalDialog';
import Typography from '@mui/joy/Typography';
import type { WorktreeRemoval } from '@shared/worktreeRemoval';

export function DeleteSessionDialog({
  sessionId,
  onDelete,
  onClose,
}: {
  sessionId: string;
  onDelete: (sessionId: string, removeWorktree: boolean) => Promise<void>;
  onClose: () => void;
}) {
  const [inspection, setInspection] = useState<WorktreeRemoval | null>(null);
  const [loading, setLoading] = useState(true);
  const [removeWorktree, setRemoveWorktree] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    async function inspect() {
      try {
        const result = await window.b4m.chat.inspectWorktreeRemoval(sessionId);
        if (cancelled) return;
        setInspection(result);
        setRemoveWorktree(result?.safe === true);
      } catch (err) {
        if (!cancelled) setError(err instanceof Error ? err.message : 'Could not check the worktree');
      } finally {
        if (!cancelled) setLoading(false);
      }
    }
    void inspect();
    return () => {
      cancelled = true;
    };
  }, [sessionId]);

  async function confirm() {
    setDeleting(true);
    setError(null);
    try {
      await onDelete(sessionId, removeWorktree);
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not delete the conversation');
      setRemoveWorktree(false);
    } finally {
      setDeleting(false);
    }
  }

  return (
    <Modal open onClose={deleting ? undefined : onClose}>
      <ModalDialog data-testid="delete-session-dialog">
        <DialogTitle>Delete conversation?</DialogTitle>
        <DialogContent>This permanently deletes the conversation.</DialogContent>
        {inspection && (
          <>
            <Checkbox
              data-testid="delete-session-worktree-checkbox"
              label="Also remove its worktree and branch"
              checked={removeWorktree}
              disabled={deleting || !inspection.safe}
              onChange={event => setRemoveWorktree(event.target.checked)}
            />
            <Typography level="body-sm">{inspection.reason ?? inspection.path}</Typography>
          </>
        )}
        {error && (
          <Alert color="danger" data-testid="delete-session-error">
            {error}
          </Alert>
        )}
        <DialogActions>
          <Button
            color="danger"
            loading={deleting}
            disabled={loading}
            onClick={() => void confirm()}
            data-testid="delete-session-confirm-btn"
          >
            Delete
          </Button>
          <Button variant="plain" disabled={deleting} onClick={onClose} data-testid="delete-session-cancel-btn">
            Cancel
          </Button>
        </DialogActions>
      </ModalDialog>
    </Modal>
  );
}
