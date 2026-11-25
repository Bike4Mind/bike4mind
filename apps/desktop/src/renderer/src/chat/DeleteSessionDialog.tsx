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
import type { SessionWorktreeRemoval } from '@shared/worktreeRemoval';

type Inspections = { alone: SessionWorktreeRemoval | null; withNested: SessionWorktreeRemoval | null };

export function DeleteSessionDialog({
  sessionId,
  title,
  nested = [],
  onDelete,
  onClose,
}: {
  sessionId: string;
  title: string;
  /** Live sessions started from this one, at any depth; offered for deletion with it. */
  nested?: readonly { id: string }[];
  onDelete: (sessionId: string, removeWorktree: boolean, nestedIds?: readonly string[]) => Promise<void>;
  onClose: () => void;
}) {
  const [inspections, setInspections] = useState<Inspections | null>(null);
  const [loading, setLoading] = useState(true);
  const [removeWorktree, setRemoveWorktree] = useState(false);
  const [deleting, setDeleting] = useState<'alone' | 'withNested' | null>(null);
  const [error, setError] = useState<string | null>(null);
  const nestedIds = nested.map(session => session.id);
  const nestedKey = nestedIds.join(',');

  useEffect(() => {
    let cancelled = false;
    async function inspect() {
      try {
        const ids = nestedKey ? nestedKey.split(',') : [];
        const alone = await window.b4m.chat.inspectWorktreeRemoval(sessionId);
        // Nested sessions often share the parent's checkout, so it may only be removable with them.
        const withNested =
          ids.length > 0 && alone && !alone.removable
            ? await window.b4m.chat.inspectWorktreeRemoval(sessionId, ids)
            : alone;
        if (cancelled) return;
        setInspections({ alone, withNested });
        setRemoveWorktree(alone?.removable === true || withNested?.removable === true);
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
  }, [sessionId, nestedKey]);

  async function confirm(scope: 'alone' | 'withNested') {
    setDeleting(scope);
    setError(null);
    try {
      const removable = inspections?.[scope]?.removable === true;
      await onDelete(sessionId, removeWorktree && removable, scope === 'withNested' ? nestedIds : undefined);
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not delete the conversation');
      setRemoveWorktree(false);
    } finally {
      setDeleting(null);
    }
  }

  const alone = inspections?.alone ?? null;
  const withNested = inspections?.withNested ?? null;
  const shown = alone?.removable || !withNested?.removable ? alone : withNested;
  const onlyWithNested = !alone?.removable && withNested?.removable === true;
  const nestedCount = nested.length;
  const busy = deleting !== null;

  return (
    <Modal open onClose={busy ? undefined : onClose}>
      <ModalDialog data-testid="delete-session-dialog" sx={{ maxWidth: 520 }}>
        <DialogTitle>{nestedCount > 0 ? 'Delete session?' : 'Delete conversation?'}</DialogTitle>
        <DialogContent data-testid="delete-session-message">
          {nestedCount > 0
            ? `"${title}" has ${nestedCount === 1 ? 'a nested session' : `${nestedCount} nested sessions`}. ` +
              `Delete only this session and ${nestedCount === 1 ? 'the nested one moves' : 'they move'} to the ` +
              'top level. Deleted sessions are permanently removed.'
            : 'This permanently deletes the conversation.'}
        </DialogContent>
        {shown && (
          <>
            <Checkbox
              data-testid="delete-session-worktree-checkbox"
              label={nestedCount > 0 ? 'Also remove worktrees and branches' : 'Also remove its worktree and branch'}
              checked={removeWorktree}
              disabled={busy || !shown.removable}
              onChange={event => setRemoveWorktree(event.target.checked)}
            />
            <Typography
              level="body-sm"
              color={removeWorktree && !shown.safe ? 'warning' : undefined}
              data-testid="delete-session-worktree-note"
            >
              {shown.reason ?? shown.path}
              {onlyWithNested && ' (only when its nested sessions are deleted too)'}
            </Typography>
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
            loading={deleting === 'alone'}
            disabled={loading || (busy && deleting !== 'alone')}
            onClick={() => void confirm('alone')}
            data-testid="delete-session-confirm-btn"
          >
            {nestedCount > 0 ? 'Delete this session' : 'Delete'}
          </Button>
          {nestedCount > 0 && (
            <Button
              color="danger"
              variant="soft"
              loading={deleting === 'withNested'}
              disabled={loading || (busy && deleting !== 'withNested')}
              onClick={() => void confirm('withNested')}
              data-testid="delete-session-with-nested-btn"
            >
              {`Delete ${nestedCount + 1} sessions`}
            </Button>
          )}
          <Button
            variant="outlined"
            color="neutral"
            disabled={busy}
            onClick={onClose}
            data-testid="delete-session-cancel-btn"
          >
            Cancel
          </Button>
        </DialogActions>
      </ModalDialog>
    </Modal>
  );
}
