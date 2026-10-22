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
import { CaretDownIcon, FileDiffIcon, PullRequestIcon } from './icons';
import { COMPOSER_BAR_INSET, contentColumnSx } from './layout';
import { middleTruncate } from './prBarModel';

const PATH_MAX_CHARS = 56;

const BAR_HEIGHT = 32;
const BAR_BORDER = 1;
// The bar's controls sit this far inside its border on top, bottom and the far end, and the bar's
// own side padding matches, so every edge has the same gap.
const BAR_INSET = COMPOSER_BAR_INSET;

const BAR_CONTROL_HEIGHT = BAR_HEIGHT - 2 * (BAR_BORDER + BAR_INSET);

// Radius shrinks by the distance between the two edges, so the corners nest inside the bar's.
const barControlSx = {
  height: BAR_CONTROL_HEIGHT,
  minHeight: BAR_CONTROL_HEIGHT,
  py: 0,
  borderRadius: `calc(var(--joy-radius-md) - ${BAR_BORDER + BAR_INSET}px)`,
  fontWeight: 'md',
  whiteSpace: 'nowrap',
  '--Button-gap': '6px',
} as const;

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
 * A slim bar above the composer for a Code session whose working directory differs from its base
 * and has no pull request yet: how much changed, which files, and a way to ship it.
 *
 * Shown in the gap before a PR exists; once `gh pr create` binds one, PrStatusBar takes this
 * slot and reports the PR's own diff instead (see ChatShell).
 */
export function ChangesBar({
  changes,
  busy,
  onCreatePullRequest,
}: {
  changes: WorkspaceChanges | null;
  /** A reply is running; a second instruction now would queue behind it rather than start. */
  busy: boolean;
  onCreatePullRequest: (changes: WorkspaceChanges) => void;
}) {
  if (!changes) return null;
  const state = changesStateLabel(changes);
  const hidden = changes.fileCount - changes.files.length;

  return (
    <Box sx={{ ...contentColumnSx, pt: 1 }} data-testid="changes-bar">
      <Stack
        direction="row"
        alignItems="center"
        spacing={1}
        sx={{
          minHeight: BAR_HEIGHT,
          px: `${BAR_INSET}px`,
          border: `${BAR_BORDER}px solid`,
          borderColor: 'neutral.outlinedBorder',
          borderRadius: 'md',
          bgcolor: 'background.surface',
          minWidth: 0,
        }}
      >
        <Box sx={{ display: 'flex', color: 'text.tertiary', flexShrink: 0 }}>
          <FileDiffIcon />
        </Box>

        <Dropdown>
          <MenuButton
            size="sm"
            variant="plain"
            color="neutral"
            endDecorator={<CaretDownIcon />}
            sx={{ ...barControlSx, px: 0.75, minWidth: 0 }}
            slotProps={{ root: { 'data-testid': 'changes-bar-files-btn' } }}
          >
            <Box component="span" sx={{ minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis' }}>
              {filesChangedLabel(changes)}
            </Box>
          </MenuButton>
          <Menu
            size="sm"
            placement="top-start"
            sx={{ minWidth: 320, maxWidth: 480, p: 1.25, gap: 0.75 }}
            data-testid="changes-bar-menu"
          >
            <Typography level="title-sm">{`Changes against ${changes.base}`}</Typography>
            <Stack
              component="ul"
              spacing={0.5}
              sx={{ m: 0, p: 0, listStyle: 'none', maxHeight: 280, overflowY: 'auto' }}
            >
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
            // Weighted far above the files label so this gives way first in a narrow window.
            sx={{ minWidth: 0, flexShrink: 1000 }}
            data-testid="changes-bar-state"
          >
            {state}
          </Typography>
        )}

        <Box sx={{ flex: 1 }} />

        <Tooltip
          title={
            busy
              ? 'Wait for the reply to finish.'
              : `Ask the agent to commit, push and open a PR against ${changes.base}.`
          }
          size="sm"
          variant="soft"
          placement="top-end"
        >
          <Box component="span" sx={{ display: 'inline-flex', flexShrink: 0 }}>
            <Button
              size="sm"
              variant="outlined"
              color="neutral"
              disabled={busy}
              startDecorator={<PullRequestIcon />}
              onClick={() => onCreatePullRequest(changes)}
              sx={{
                ...barControlSx,
                px: 1,
                '&:hover, &:focus-visible': { color: 'primary.plainColor', borderColor: 'primary.outlinedBorder' },
              }}
              data-testid="changes-bar-create-pr-btn"
            >
              Create PR
            </Button>
          </Box>
        </Tooltip>
      </Stack>
    </Box>
  );
}
