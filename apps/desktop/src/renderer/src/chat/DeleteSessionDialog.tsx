import { useEffect, useRef, useState } from 'react';
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

type NestedWorktree = { id: string; title: string; inspection: SessionWorktreeRemoval };

type Inspections = {
  alone: SessionWorktreeRemoval | null;
  withNested: SessionWorktreeRemoval | null;
  /** Nested sessions with an app worktree of their own, each judged on its own. */
  nested: NestedWorktree[];
};

export function DeleteSessionDialog({
  sessionId,
  title,
  nested = [],
  inspectWorktrees = true,
  onDelete,
  onClose,
}: {
  sessionId: string;
  title: string;
  /** Live sessions started from this one, at any depth; offered for deletion with it. */
  nested?: readonly { id: string; title: string }[];
  /**
   * Whether worktree cleanup is offered. Inspecting a worktree is a call to Desktop's own main
   * process, so a session on another host is deleted without it (see sessionCapabilities).
   */
  inspectWorktrees?: boolean;
  onDelete: (
    sessionId: string,
    removeWorktree: boolean,
    nestedIds?: readonly string[],
    nestedWorktreeIds?: readonly string[]
  ) => Promise<void>;
  onClose: () => void;
}) {
  const [inspections, setInspections] = useState<Inspections | null>(null);
  const [loading, setLoading] = useState(true);
  const [removeWorktree, setRemoveWorktree] = useState(false);
  const [deleting, setDeleting] = useState<'alone' | 'withNested' | null>(null);
  const [error, setError] = useState<string | null>(null);
  const seeded = useRef(false);
  const nestedIds = nested.map(session => session.id);
  const nestedKey = JSON.stringify(nested.map(session => [session.id, session.title]));

  useEffect(() => {
    if (!inspectWorktrees) {
      setInspections({ alone: null, withNested: null, nested: [] });
      setLoading(false);
      return;
    }
    let cancelled = false;
    setLoading(true);
    async function inspect() {
      try {
        const titles = new Map(JSON.parse(nestedKey) as [string, string][]);
        const ids = [...titles.keys()];
        const alone = await window.b4m.chat.inspectWorktreeRemoval(sessionId);
        // Nested sessions often share the parent's checkout, so it may only be removable with them.
        const withNested =
          ids.length > 0 && alone && !alone.removable
            ? await window.b4m.chat.inspectWorktreeRemoval(sessionId, ids)
            : alone;
        const nestedFound = await Promise.all(
          ids.map(async id => ({ id, inspection: await window.b4m.chat.inspectWorktreeRemoval(id) }))
        );
        if (cancelled) return;
        const own = nestedFound.flatMap(({ id, inspection }) =>
          inspection ? [{ id, title: titles.get(id) ?? id, inspection }] : []
        );
        setInspections({ alone, withNested, nested: own });
        if (!seeded.current) {
          seeded.current = true;
          setRemoveWorktree(
            alone?.removable === true || withNested?.removable === true || own.some(entry => entry.inspection.removable)
          );
        }
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
  }, [sessionId, nestedKey, inspectWorktrees]);

  async function confirm(scope: 'alone' | 'withNested') {
    setDeleting(scope);
    setError(null);
    try {
      const removable = inspections?.[scope]?.removable === true;
      if (scope === 'alone') {
        await onDelete(sessionId, removeWorktree && removable, undefined);
      } else {
        // Only the nested worktrees listed here, so nothing goes that the user was not shown.
        const nestedWorktreeIds = removeWorktree
          ? (inspections?.nested ?? []).filter(entry => entry.inspection.removable).map(entry => entry.id)
          : [];
        await onDelete(sessionId, removeWorktree && removable, nestedIds, nestedWorktreeIds);
      }
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
  const nestedWorktrees = inspections?.nested ?? [];
  const anyRemovable = shown?.removable === true || nestedWorktrees.some(entry => entry.inspection.removable);
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
        {(shown || nestedWorktrees.length > 0) && (
          <>
            <Checkbox
              data-testid="delete-session-worktree-checkbox"
              label={nestedCount > 0 ? 'Also remove worktrees and branches' : 'Also remove its worktree and branch'}
              checked={removeWorktree}
              disabled={busy || !anyRemovable}
              onChange={event => setRemoveWorktree(event.target.checked)}
            />
            {shown && (
              <Typography
                level="body-sm"
                color={removeWorktree && !shown.safe ? 'warning' : undefined}
                data-testid="delete-session-worktree-note"
              >
                {shown.reason ?? shown.path}
                {onlyWithNested && ' (only when its nested sessions are deleted too)'}
              </Typography>
            )}
            {nestedWorktrees.length > 0 && (
              <Typography level="body-sm" component="div" data-testid="delete-session-nested-worktrees">
                With {nestedCount + 1} sessions deleted:
                {nestedWorktrees.map(({ id, title: nestedTitle, inspection }) => (
                  <Typography
                    key={id}
                    level="body-sm"
                    display="block"
                    color={removeWorktree && inspection.removable && !inspection.safe ? 'warning' : undefined}
                    data-testid={`delete-session-nested-worktree-${id}`}
                  >
                    {`${nestedTitle}: ${nestedNote(inspection)}`}
                  </Typography>
                ))}
              </Typography>
            )}
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

function nestedNote(inspection: SessionWorktreeRemoval): string {
  if (!inspection.removable) return `worktree kept: ${inspection.reason ?? 'cannot be removed'}`;
  return inspection.reason ?? 'worktree and branch removed';
}
