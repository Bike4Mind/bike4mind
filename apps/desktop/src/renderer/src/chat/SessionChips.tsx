import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import Alert from '@mui/joy/Alert';
import Box from '@mui/joy/Box';
import Checkbox from '@mui/joy/Checkbox';
import Chip from '@mui/joy/Chip';
import Dropdown from '@mui/joy/Dropdown';
import IconButton from '@mui/joy/IconButton';
import Input from '@mui/joy/Input';
import Menu from '@mui/joy/Menu';
import MenuButton from '@mui/joy/MenuButton';
import MenuItem from '@mui/joy/MenuItem';
import Stack from '@mui/joy/Stack';
import Tooltip from '@mui/joy/Tooltip';
import Typography from '@mui/joy/Typography';
import type { SxProps } from '@mui/joy/styles/types';
import type { ChatProject } from '@shared/chat';
import { EnvironmentPicker } from '../auth/EnvironmentPicker';
import { useAuthState } from '../auth/useAuthState';
import { BranchIcon, CloseIcon, FolderIcon, FolderPlusIcon, ServerIcon } from './icons';
import { contentColumnSx } from './layout';
import type { ProjectBindingController } from './useChat';

/** Above this the branch list is long enough that filtering it beats scrolling it. */
const FILTER_THRESHOLD = 8;

/**
 * The branch filter, which keeps the caret.
 *
 * Joy's menu owns focus: it claims it when the menu opens, and claims it again whenever the
 * item list changes - which is every keystroke, because filtering rewrites the list. So the
 * caret is taken back after each render rather than only on mount, and the effect is
 * deliberately dependency-free for that reason. It runs only while the menu is open, since
 * this component mounts with the menu's children.
 */
function BranchFilter({
  value,
  onChange,
  onCommit,
}: {
  value: string;
  onChange: (value: string) => void;
  /** Enter on a name that is not an existing branch: start that branch. */
  onCommit: () => void;
}) {
  const input = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (document.activeElement !== input.current) input.current?.focus();
  });

  return (
    <Box sx={{ px: 1, pb: 0.5 }}>
      <Input
        size="sm"
        value={value}
        placeholder="Filter or name a new branch..."
        onChange={event => onChange(event.target.value)}
        // Typing must reach the box: Joy's menu reads printable keys as type-ahead and
        // moves the highlight instead, eating every character after the first.
        onKeyDown={event => {
          event.stopPropagation();
          if (event.key === 'Enter') onCommit();
        }}
        slotProps={{ input: { 'data-testid': 'session-chip-branch-filter', ref: input } }}
      />
    </Box>
  );
}

/** The controller plus what the current directory turned out to be; see `useBranches`. */
type ChipBinding = ProjectBindingController & { isRepository: boolean };

/** One pill in the row. Matches Joy's outlined Chip so the custom pill sits level with the rest. */
const pillSx: SxProps = {
  display: 'flex',
  alignItems: 'center',
  minHeight: 24,
  borderRadius: '999px',
  border: '1px solid',
  borderColor: 'neutral.outlinedBorder',
  bgcolor: 'background.surface',
};

/** A pill's inner button: no border or background of its own, the pill provides both. */
const pillButtonSx: SxProps = {
  fontWeight: 'normal',
  minHeight: 22,
  px: 1,
  '--Button-gap': '6px',
  borderRadius: '999px',
};

function lastSegments(path: string, count = 2): string {
  const parts = path.split('/').filter(Boolean);
  return parts.length <= count ? path : `.../${parts.slice(-count).join('/')}`;
}

/**
 * Which b4m backend this session talks to.
 *
 * Deliberately NOT Claude Code's Local/Cloud switch. This app's agent is the Electron main
 * process and has nowhere else to run, so a control implying remote execution would name a
 * choice that does not exist. What does vary is the server behind it, which is the T4
 * environment - and it is app-wide, which the tooltip says rather than leaving the user to
 * discover it by changing one session and finding they changed them all.
 */
function EnvironmentChip() {
  const state = useAuthState();
  if (!state) return null;

  return (
    <Dropdown>
      <Tooltip
        title={`${state.environment.url} - the server every conversation in this app talks to`}
        size="sm"
        variant="soft"
        placement="top-start"
      >
        <MenuButton
          size="sm"
          variant="outlined"
          color="neutral"
          startDecorator={<ServerIcon />}
          sx={{ ...pillButtonSx, borderRadius: '999px' }}
          slotProps={{ root: { 'data-testid': 'session-chip-environment' } }}
        >
          <Typography level="body-xs" textColor="inherit" noWrap>
            {state.environment.label}
          </Typography>
        </MenuButton>
      </Tooltip>

      <Menu size="sm" placement="top-start" sx={{ p: 1.5, minWidth: 300 }}>
        <EnvironmentPicker state={state} />
      </Menu>
    </Dropdown>
  );
}

/** The project directory, as its folder name. The full path is one hover away. */
function ProjectChip({ project, binding }: { project: ChatProject; binding: ChipBinding }) {
  return (
    <Tooltip title={project.directory} size="sm" variant="soft" placement="top-start">
      <Chip
        size="sm"
        variant="outlined"
        color="neutral"
        disabled={binding.busy}
        startDecorator={<FolderIcon />}
        onClick={() => void binding.pickDirectory()}
        data-testid="session-chip-project"
      >
        {project.name}
      </Chip>
    </Tooltip>
  );
}

/**
 * Branch and worktree as one pill, split by a divider.
 *
 * They are paired rather than separate because a worktree belongs to a branch: two independent
 * controls would invite "worktree, no branch", which resolves to nothing the tools could run in.
 */
function BranchChip({
  project,
  binding,
  branches,
}: {
  project: ChatProject;
  binding: ChipBinding;
  branches: readonly string[];
}) {
  const [filter, setFilter] = useState('');

  const matches = useMemo(() => {
    const query = filter.trim().toLowerCase();
    if (!query) return branches;
    return branches.filter(branch => branch.toLowerCase().includes(query));
  }, [branches, filter]);

  const typed = filter.trim();
  const canCreate = !!typed && !branches.includes(typed);
  const relocated = project.workingDirectory !== project.directory;

  return (
    <Box sx={pillSx} data-testid="session-chip-branch">
      <Dropdown onOpenChange={(_event, open) => open && setFilter('')}>
        <MenuButton
          size="sm"
          variant="plain"
          color="neutral"
          disabled={binding.busy}
          startDecorator={<BranchIcon />}
          sx={pillButtonSx}
          slotProps={{ root: { 'data-testid': 'session-chip-branch-btn' } }}
        >
          <Typography level="body-xs" textColor="inherit" noWrap>
            {project.branch || 'no branch'}
          </Typography>
        </MenuButton>

        <Menu size="sm" placement="top-start" sx={{ maxHeight: 360, overflow: 'auto', minWidth: 280 }}>
          {branches.length > FILTER_THRESHOLD && (
            <BranchFilter
              value={filter}
              onChange={setFilter}
              onCommit={() => canCreate && void binding.setBranch(typed)}
            />
          )}

          {/* Always rendered, never conditional: Joy re-registers its menu items when the
              children change and pulls focus onto the first one, which would take the caret out
              of the filter box the moment a typed name stopped matching an existing branch. */}
          <MenuItem
            disabled={!canCreate}
            onClick={() => void binding.setBranch(typed)}
            data-testid="session-chip-branch-new"
          >
            <Typography level="body-sm" noWrap>
              {canCreate ? `Create ${typed}` : 'Type a name to start a new branch'}
            </Typography>
          </MenuItem>

          {matches.map(branch => (
            <MenuItem
              key={branch}
              selected={branch === project.branch}
              onClick={() => void binding.setBranch(branch)}
              data-testid="session-chip-branch-option"
            >
              <Typography level="body-sm" noWrap>
                {branch === project.branch ? '* ' : ''}
                {branch}
              </Typography>
            </MenuItem>
          ))}

          {branches.length === 0 && (
            <Typography level="body-xs" textColor="text.tertiary" sx={{ px: 1.5, py: 0.5, whiteSpace: 'normal' }}>
              {binding.isRepository ? 'This repository has no branches yet.' : 'Not a git repository.'}
            </Typography>
          )}
        </Menu>
      </Dropdown>

      <Box sx={{ width: '1px', alignSelf: 'stretch', my: 0.5, bgcolor: 'neutral.outlinedBorder' }} />

      <Tooltip
        title={
          relocated
            ? `Runs in the worktree at ${project.workingDirectory}`
            : 'Run this session in its own git worktree for the branch, beside the project'
        }
        size="sm"
        variant="soft"
        placement="top-start"
      >
        <Box sx={{ px: 1, display: 'flex', alignItems: 'center' }}>
          <Checkbox
            size="sm"
            label={
              <Typography level="body-xs" textColor="inherit">
                worktree
              </Typography>
            }
            checked={project.workspace}
            disabled={binding.busy || !binding.isRepository}
            onChange={event => void binding.setWorkspace(event.target.checked)}
            slotProps={{ input: { 'data-testid': 'session-chip-worktree-toggle' } }}
          />
        </Box>
      </Tooltip>
    </Box>
  );
}

/**
 * The extra folders this session may read, and the button that adds one.
 *
 * The grants are drawn rather than hidden behind the button: they widen what the tools can
 * reach, and a permission nobody can see is one nobody can take back.
 */
function ContextChips({ project, binding }: { project: ChatProject; binding: ChipBinding }) {
  return (
    <>
      <Tooltip title="Add a folder this session may read" size="sm" variant="soft" placement="top-start">
        <IconButton
          size="sm"
          variant="outlined"
          color="neutral"
          disabled={binding.busy}
          onClick={() => void binding.addContextDirectory()}
          aria-label="Add a context folder"
          sx={{ borderRadius: '999px', minWidth: 26, minHeight: 24 }}
          data-testid="session-chip-add-context"
        >
          <FolderPlusIcon />
        </IconButton>
      </Tooltip>

      {project.contextDirectories.map(directory => (
        <Tooltip key={directory} title={directory} size="sm" variant="soft" placement="top-start">
          <Chip
            size="sm"
            variant="soft"
            color="neutral"
            endDecorator={<CloseIcon />}
            onClick={() => void binding.removeContextDirectory(directory)}
            data-testid="session-chip-context"
          >
            {lastSegments(directory)}
          </Chip>
        </Tooltip>
      ))}
    </>
  );
}

/**
 * The branches of the directory this session is currently on.
 *
 * Re-read whenever the directory changes, because that is the whole reason the list is not
 * stored with the session: branch names belong to a repository, and the ones shown after a move
 * must be the new repository's.
 */
function useBranches(directory: string): { branches: string[]; isRepository: boolean } {
  const [state, setState] = useState<{ branches: string[]; isRepository: boolean }>({
    branches: [],
    isRepository: true,
  });

  useEffect(() => {
    let current = true;
    void window.b4m.chat.inspectProject(directory).then(inspected => {
      if (!current) return;
      setState({ branches: inspected.branches, isRepository: inspected.isRepository });
    });
    return () => {
      current = false;
    };
  }, [directory]);

  return state;
}

/**
 * What a Code session is grounded in, above the composer, editable at any point in the session.
 *
 * A persistent surface rather than a setup step: this IS the session's current grounding, and
 * the working directory it resolves to is where every shell command in the next turn will run.
 * A Chat session has no project and draws nothing here.
 */
export function SessionChips({ project, binding }: { project: ChatProject; binding: ProjectBindingController }) {
  const { branches, isRepository } = useBranches(project.directory);
  const bound = useMemo(() => ({ ...binding, isRepository }), [binding, isRepository]);

  const dismiss = useCallback(() => binding.dismissError(), [binding]);

  return (
    <Box sx={{ ...contentColumnSx, pt: 1 }}>
      {binding.error && (
        <Alert
          size="sm"
          color={binding.error.busy ? 'warning' : 'danger'}
          variant="soft"
          sx={{ mb: 1, cursor: 'pointer' }}
          onClick={dismiss}
          data-testid="session-chip-error"
        >
          {binding.error.message}
        </Alert>
      )}

      <Stack direction="row" spacing={0.75} sx={{ alignItems: 'center', flexWrap: 'wrap', gap: 0.75 }}>
        <EnvironmentChip />
        <ProjectChip project={project} binding={bound} />
        <BranchChip project={project} binding={bound} branches={branches} />
        <ContextChips project={project} binding={bound} />
      </Stack>
    </Box>
  );
}
