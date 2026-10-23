import Box from '@mui/joy/Box';
import Button from '@mui/joy/Button';
import Dropdown from '@mui/joy/Dropdown';
import Menu from '@mui/joy/Menu';
import MenuButton from '@mui/joy/MenuButton';
import Stack from '@mui/joy/Stack';
import Tooltip from '@mui/joy/Tooltip';
import Typography from '@mui/joy/Typography';
import type { ChangedFile, WorkspaceChanges } from '@shared/workspaceChanges';
import { changesStateLabel, filesChangedLabel } from './changesBarModel';
import { DiffCount } from './DiffCount';
import { CaretDownIcon, PullRequestIcon } from './icons';
import { middleTruncate } from './prBarModel';

const PATH_MAX_CHARS = 56;

function FileRow({ file }: { file: ChangedFile }) {
  return (
    <Stack component="li" direction="row" alignItems="center" spacing={1} data-testid="changes-bar-file">
      <Tooltip title={file.path} size="sm" variant="soft" placement="left">
        <Typography level="body-xs" noWrap sx={{ fontFamily: 'code', flex: 1, minWidth: 0 }}>
          {middleTruncate(file.path, PATH_MAX_CHARS)}
        </Typography>
      </Tooltip>
      {file.untracked && (
        <Typography level="body-xs" textColor="text.tertiary">
          new
        </Typography>
      )}
      {file.binary ? (
        <Typography level="body-xs" textColor="text.tertiary">
          binary
        </Typography>
      ) : (
        <DiffCount added={file.added} removed={file.removed} />
      )}
    </Stack>
  );
}

/**
 * The session panel's Changes section, for a Code session whose working directory differs from
 * its base and has no pull request yet: how much changed, which files, and where they stand.
 *
 * Shown in the gap before a PR exists; once `gh pr create` binds one, PrStatusBar takes this
 * section and reports the PR's own diff instead (see SessionPanel).
 */
export function ChangesBar({ changes }: { changes: WorkspaceChanges }) {
  const state = changesStateLabel(changes);
  const hidden = changes.fileCount - changes.files.length;

  return (
    <Stack
      direction="row"
      alignItems="center"
      spacing={1}
      sx={{ minWidth: 0, flexWrap: 'wrap', rowGap: 0.5 }}
      data-testid="changes-bar"
    >
      <Dropdown>
        <MenuButton
          size="sm"
          variant="plain"
          color="neutral"
          endDecorator={<CaretDownIcon />}
          sx={{ fontWeight: 'md', minHeight: 26, px: 0.75, ml: -0.75, '--Button-gap': '6px' }}
          slotProps={{ root: { 'data-testid': 'changes-bar-files-btn' } }}
        >
          {filesChangedLabel(changes)}
        </MenuButton>
        <Menu
          size="sm"
          placement="bottom-end"
          sx={{ minWidth: 320, maxWidth: 480, p: 1.25, gap: 0.75 }}
          data-testid="changes-bar-menu"
        >
          <Typography level="title-sm">{`Changes against ${changes.base}`}</Typography>
          <Stack component="ul" spacing={0.5} sx={{ m: 0, p: 0, listStyle: 'none', maxHeight: 280, overflowY: 'auto' }}>
            {changes.files.map(file => (
              <FileRow key={file.path} file={file} />
            ))}
          </Stack>
          {hidden > 0 && (
            <Typography level="body-xs" textColor="text.tertiary" data-testid="changes-bar-more">
              {`and ${hidden} more`}
            </Typography>
          )}
        </Menu>
      </Dropdown>

      <DiffCount added={changes.added} removed={changes.removed} testId="changes-bar-diff" />

      {state && (
        <Typography
          level="body-xs"
          textColor="text.tertiary"
          noWrap
          sx={{ minWidth: 0 }}
          data-testid="changes-bar-state"
        >
          {state}
        </Typography>
      )}
    </Stack>
  );
}

/**
 * Ask the agent to ship the changes. Drawn in the Changes section's header rather than its body,
 * so it stays one click away with the section collapsed.
 */
export function CreatePullRequestButton({
  changes,
  busy,
  onCreatePullRequest,
}: {
  changes: WorkspaceChanges;
  /** A reply is running; a second instruction now would queue behind it rather than start. */
  busy: boolean;
  onCreatePullRequest: (changes: WorkspaceChanges) => void;
}) {
  return (
    <Tooltip
      title={
        busy ? 'Wait for the reply to finish.' : `Ask the agent to commit, push and open a PR against ${changes.base}.`
      }
      size="sm"
      variant="soft"
      placement="bottom-end"
    >
      <Box component="span" sx={{ display: 'inline-flex' }}>
        <Button
          size="sm"
          variant="soft"
          color="primary"
          disabled={busy}
          startDecorator={<PullRequestIcon />}
          onClick={() => onCreatePullRequest(changes)}
          sx={{ minHeight: 24, px: 1, fontSize: 'xs' }}
          data-testid="changes-bar-create-pr-btn"
        >
          Create PR
        </Button>
      </Box>
    </Tooltip>
  );
}
