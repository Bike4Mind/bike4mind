import { useCallback, useEffect, useState } from 'react';
import Alert from '@mui/joy/Alert';
import Autocomplete from '@mui/joy/Autocomplete';
import Button from '@mui/joy/Button';
import Chip from '@mui/joy/Chip';
import FormControl from '@mui/joy/FormControl';
import FormHelperText from '@mui/joy/FormHelperText';
import FormLabel from '@mui/joy/FormLabel';
import Modal from '@mui/joy/Modal';
import ModalDialog from '@mui/joy/ModalDialog';
import Stack from '@mui/joy/Stack';
import Switch from '@mui/joy/Switch';
import Typography from '@mui/joy/Typography';
import type { CreateCodeSessionRequest, ProjectInspection } from '@shared/chat';

/** Mirrors worktreeFolderName in main/chat/project/workspace.ts, for the path preview only. */
function worktreeFolderName(branch: string): string {
  return branch.replaceAll('/', '+');
}

function shorten(path: string): string {
  const parts = path.split('/').filter(Boolean);
  return parts.length <= 3 ? path : `.../${parts.slice(-3).join('/')}`;
}

/**
 * What a new Code session is grounded in: a project directory, a branch, whether it runs in
 * its own worktree, and any extra folders for context.
 *
 * The branch list is read from the directory the moment it is picked, so it is the repository's
 * real branches rather than something typed from memory. A name not in the list is still
 * accepted - that is how a session starts a new branch.
 */
export function NewCodeSessionDialog({
  open,
  onClose,
  onCreate,
  error,
  busy,
}: {
  open: boolean;
  onClose: () => void;
  onCreate: (request: CreateCodeSessionRequest) => void;
  /** Set when main refused the last attempt; the dialog stays open so the choice can be fixed. */
  error: string | null;
  busy: boolean;
}) {
  const [project, setProject] = useState<ProjectInspection | null>(null);
  const [branch, setBranch] = useState('');
  const [workspace, setWorkspace] = useState(false);
  const [contextDirectories, setContextDirectories] = useState<string[]>([]);
  const [inspecting, setInspecting] = useState(false);

  useEffect(() => {
    if (open) return;
    setProject(null);
    setBranch('');
    setWorkspace(false);
    setContextDirectories([]);
  }, [open]);

  const pickProject = useCallback(async () => {
    const directory = await window.b4m.chat.pickProjectDirectory();
    if (!directory) return;
    setInspecting(true);
    const inspected = await window.b4m.chat.inspectProject(directory);
    setProject(inspected);
    setBranch(inspected.currentBranch ?? '');
    setInspecting(false);
  }, []);

  const addContextDirectory = useCallback(async () => {
    const directory = await window.b4m.chat.pickProjectDirectory();
    if (!directory) return;
    setContextDirectories(current => (current.includes(directory) ? current : [...current, directory]));
  }, []);

  const canCreate = !!project && !busy && (!workspace || !!branch.trim());

  return (
    <Modal open={open} onClose={onClose}>
      <ModalDialog sx={{ width: 520, maxWidth: '90vw' }} data-testid="new-code-session-dialog">
        <Typography level="title-md">New Code session</Typography>
        <Typography level="body-xs" textColor="text.tertiary">
          Ground this conversation in a project. Its tools read, write and run commands there.
        </Typography>

        <Stack spacing={2} sx={{ mt: 1.5 }}>
          <FormControl>
            <FormLabel>Project directory</FormLabel>
            <Button
              variant="outlined"
              color="neutral"
              size="sm"
              loading={inspecting}
              onClick={() => void pickProject()}
              data-testid="code-pick-project-btn"
            >
              {project ? project.name : 'Choose a folder...'}
            </Button>
            {project && (
              <FormHelperText data-testid="code-project-path">
                {project.directory}
                {!project.isRepository && ' (not a git repository)'}
              </FormHelperText>
            )}
          </FormControl>

          {project?.error && (
            <Alert size="sm" color="warning" variant="soft">
              {project.error}
            </Alert>
          )}

          {project?.isRepository && (
            <FormControl>
              <FormLabel>Branch</FormLabel>
              <Autocomplete
                size="sm"
                freeSolo
                options={project.branches}
                value={branch}
                onChange={(_event, value) => setBranch(value ?? '')}
                onInputChange={(_event, value) => setBranch(value)}
                placeholder="Branch name"
                slotProps={{ input: { 'data-testid': 'code-branch-input' } }}
              />
              <FormHelperText>
                {project.branches.includes(branch)
                  ? `${project.branches.length} branches in this repository.`
                  : 'Not an existing branch - it will be created from origin/main.'}
              </FormHelperText>
            </FormControl>
          )}

          {project?.isRepository && (
            <FormControl orientation="horizontal" sx={{ justifyContent: 'space-between', alignItems: 'flex-start' }}>
              <Stack sx={{ minWidth: 0, pr: 2 }}>
                <FormLabel sx={{ mb: 0.25 }}>Workspace</FormLabel>
                <Typography level="body-xs" textColor="text.tertiary">
                  {workspace && branch
                    ? `Runs in a git worktree at .../${worktreeFolderName(branch)}, beside the project, not in the main checkout.`
                    : 'Run this session in its own git worktree for the branch, instead of the project directory.'}
                </Typography>
              </Stack>
              <Switch
                checked={workspace}
                onChange={event => setWorkspace(event.target.checked)}
                slotProps={{ input: { 'data-testid': 'code-workspace-toggle' } }}
              />
            </FormControl>
          )}

          <FormControl>
            <FormLabel>Context directories</FormLabel>
            <Stack direction="row" spacing={0.5} sx={{ flexWrap: 'wrap', gap: 0.5, mb: 1 }}>
              {contextDirectories.map(directory => (
                <Chip
                  key={directory}
                  size="sm"
                  variant="soft"
                  endDecorator={<span aria-hidden>x</span>}
                  onClick={() => setContextDirectories(current => current.filter(entry => entry !== directory))}
                  data-testid="code-context-chip"
                >
                  {shorten(directory)}
                </Chip>
              ))}
            </Stack>
            <Button
              variant="outlined"
              color="neutral"
              size="sm"
              onClick={() => void addContextDirectory()}
              data-testid="code-add-context-btn"
            >
              Add a directory
            </Button>
            <FormHelperText>Extra folders this session may read, on top of the project.</FormHelperText>
          </FormControl>

          {error && (
            <Alert size="sm" color="danger" variant="soft" data-testid="code-create-error">
              {error}
            </Alert>
          )}

          <Stack direction="row" spacing={1} sx={{ justifyContent: 'flex-end' }}>
            <Button variant="plain" color="neutral" size="sm" onClick={onClose}>
              Cancel
            </Button>
            <Button
              size="sm"
              loading={busy}
              disabled={!canCreate}
              onClick={() =>
                project &&
                onCreate({
                  directory: project.directory,
                  branch: branch.trim(),
                  workspace,
                  contextDirectories,
                })
              }
              data-testid="code-create-session-btn"
            >
              Start session
            </Button>
          </Stack>
        </Stack>
      </ModalDialog>
    </Modal>
  );
}
