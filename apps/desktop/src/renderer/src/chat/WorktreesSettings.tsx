import Box from '@mui/joy/Box';
import Button from '@mui/joy/Button';
import Chip from '@mui/joy/Chip';
import Stack from '@mui/joy/Stack';
import Typography from '@mui/joy/Typography';
import type { AppWorktree, WorktreeState } from '@shared/worktreeRemoval';
import { useWorktrees, type WorktreesState } from './useWorktrees';

const STATE_LABEL: Record<WorktreeState, string> = {
  clean: 'Clean',
  dirty: 'Uncommitted changes',
  unpushed: 'Unpushed commits',
  unverified: 'Unverified',
  owned: 'In use',
  nested: 'Nested',
  foreign: 'Not an app worktree',
};

/** An orphan is one no conversation uses; only those are ever offered for removal. */
const isOrphan = (worktree: AppWorktree) => worktree.owner === null;

function WorktreeRow({
  worktree,
  directory,
  busy,
  onRemove,
  onReveal,
}: {
  worktree: AppWorktree;
  directory: string;
  busy: boolean;
  onRemove: WorktreesState['removeOne'];
  onReveal: WorktreesState['reveal'];
}) {
  const orphan = isOrphan(worktree);
  return (
    <Stack
      direction="row"
      alignItems="flex-start"
      spacing={1}
      sx={{ py: 1, borderTop: '1px solid', borderColor: 'divider' }}
      data-testid="worktrees-row"
      data-path={worktree.path}
    >
      <Stack sx={{ flex: 1, minWidth: 0 }}>
        <Stack direction="row" spacing={1} alignItems="center">
          <Typography level="title-sm" data-testid="worktrees-branch-label">
            {worktree.branch}
          </Typography>
          <Chip
            size="sm"
            variant="soft"
            color={worktree.safe ? 'success' : 'warning'}
            data-testid="worktrees-state-chip"
          >
            {STATE_LABEL[worktree.state]}
          </Chip>
        </Stack>
        <Typography
          level="body-xs"
          textColor="text.tertiary"
          sx={{ wordBreak: 'break-all' }}
          data-testid="worktrees-path-label"
        >
          {worktree.path}
        </Typography>
        <Typography level="body-xs" textColor="text.tertiary" data-testid="worktrees-owner-label">
          {worktree.owner ? `Used by ${worktree.owner}` : 'No conversation uses it'}
          {worktree.lastCommit ? ` - last commit ${formatCommitDate(worktree.lastCommit)}` : ''}
        </Typography>
        {orphan && !worktree.safe && worktree.reason && (
          <Typography level="body-xs" color="warning" data-testid="worktrees-reason-label">
            {worktree.reason}
          </Typography>
        )}
      </Stack>
      {orphan && (
        <Stack direction="row" spacing={0.5}>
          {worktree.safe ? (
            <Button
              size="sm"
              color="danger"
              variant="soft"
              disabled={busy}
              onClick={() => void onRemove(directory, worktree.path)}
              data-testid="worktrees-remove-btn"
            >
              Remove
            </Button>
          ) : (
            <Button
              size="sm"
              variant="plain"
              color="neutral"
              onClick={() => void onReveal(directory, worktree.path)}
              data-testid="worktrees-reveal-btn"
            >
              Show in folder
            </Button>
          )}
        </Stack>
      )}
    </Stack>
  );
}

function formatCommitDate(iso: string): string {
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? iso : date.toLocaleDateString();
}

export function WorktreesView({ state }: { state: WorktreesState }) {
  const { projects, loading, busy, report, removeOne, removeAllSafe, reveal } = state;
  const problems = report.filter(item => item.status !== 'removed');
  const removed = report.length - problems.length;
  const skipped = problems.filter(item => item.status === 'skipped').length;
  const failed = problems.length - skipped;

  return (
    <Stack spacing={2} data-testid="worktrees-panel">
      {loading && (
        <Typography level="body-sm" data-testid="worktrees-loading-label">
          Looking for worktrees...
        </Typography>
      )}
      {!loading && projects.length === 0 && (
        <Typography level="body-sm" textColor="text.tertiary" data-testid="worktrees-empty-label">
          No app-created worktrees found in your recent projects.
        </Typography>
      )}
      {projects.map(project => {
        const safeCount = project.worktrees.filter(item => isOrphan(item) && item.safe).length;
        return (
          <Box key={project.directory} data-testid="worktrees-project" data-directory={project.directory}>
            <Stack direction="row" alignItems="center" spacing={1}>
              <Typography level="title-md" sx={{ flex: 1 }} data-testid="worktrees-project-label">
                {project.name}
              </Typography>
              {safeCount > 0 && (
                <Button
                  size="sm"
                  color="danger"
                  variant="soft"
                  disabled={busy}
                  onClick={() => void removeAllSafe(project.directory)}
                  data-testid="worktrees-remove-all-btn"
                >
                  Remove all safe ({safeCount})
                </Button>
              )}
            </Stack>
            {project.error && (
              <Typography level="body-sm" color="danger" role="alert" data-testid="worktrees-load-error">
                Could not read worktrees. {project.error}
              </Typography>
            )}
            {project.worktrees.map(worktree => (
              <WorktreeRow
                key={worktree.path}
                worktree={worktree}
                directory={project.directory}
                busy={busy}
                onRemove={removeOne}
                onReveal={reveal}
              />
            ))}
          </Box>
        );
      })}
      {report.length > 0 && (
        <Stack spacing={0.5} role="status" data-testid="worktrees-report">
          <Typography level="body-sm" data-testid="worktrees-report-summary">
            {`Removed ${removed}, skipped ${skipped}, failed ${failed}.`}
          </Typography>
          {problems.map((item, index) => (
            <Typography
              key={`${item.path}:${index}`}
              level="body-xs"
              color={item.status === 'failed' ? 'danger' : 'warning'}
              data-testid={`worktrees-report-${item.status}-item`}
            >
              {item.branch || item.path}: {item.message ?? item.status}
            </Typography>
          ))}
        </Stack>
      )}
    </Stack>
  );
}

export function WorktreesSettings() {
  return <WorktreesView state={useWorktrees()} />;
}
