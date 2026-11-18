import Box from '@mui/joy/Box';
import Dropdown from '@mui/joy/Dropdown';
import IconButton from '@mui/joy/IconButton';
import Menu from '@mui/joy/Menu';
import MenuButton from '@mui/joy/MenuButton';
import MenuItem from '@mui/joy/MenuItem';
import Tooltip from '@mui/joy/Tooltip';
import Typography from '@mui/joy/Typography';
import { useTheme } from '@mui/joy/styles';
import { avatarColors, initialOf, typeLabel } from './artifactLibrary';
import { ArtifactIcon } from './icons';
import { updatedLabel, type SessionArtifact } from './sessionArtifacts';

export const NO_SESSION_ARTIFACTS = 'No artifacts in this session';

/**
 * The open conversation's artifacts, from the header beside the pane controls. Opens bottom-end
 * from inside the reading column for the same reason the panes menu does: a popup over the
 * browser pane would be drawn behind its native page.
 */
export function SessionArtifactsButton({
  artifacts,
  onOpen,
}: {
  artifacts: readonly SessionArtifact[];
  onOpen: (entry: SessionArtifact) => void;
}) {
  const mode = useTheme().palette.mode;
  const empty = artifacts.length === 0;

  return (
    <Dropdown>
      <Tooltip size="sm" variant="soft" placement="bottom-end" title={empty ? NO_SESSION_ARTIFACTS : 'Artifacts'}>
        {/* A disabled button takes no pointer events, so the tooltip hangs off this wrapper. */}
        <Box component="span" sx={{ display: 'inline-flex' }} data-testid="chat-session-artifacts-anchor">
          <MenuButton
            slots={{ root: IconButton }}
            slotProps={{
              root: { size: 'sm', variant: 'plain', color: 'neutral', 'data-testid': 'chat-session-artifacts-btn' },
            }}
            disabled={empty}
            aria-label={empty ? NO_SESSION_ARTIFACTS : 'Artifacts in this session'}
          >
            <ArtifactIcon />
          </MenuButton>
        </Box>
      </Tooltip>
      <Menu
        size="sm"
        placement="bottom-end"
        sx={{ minWidth: 260, maxWidth: 340, maxHeight: 420, overflowY: 'auto' }}
        data-testid="chat-session-artifacts-menu"
      >
        <Typography level="body-xs" textColor="text.tertiary" sx={{ px: 1.5, py: 0.5 }}>
          Artifacts in this session
        </Typography>
        {artifacts.map(entry => {
          const avatar = avatarColors(entry.key, mode);
          const updated = updatedLabel(entry.updatedAt);
          return (
            <MenuItem
              key={entry.key}
              onClick={() => onOpen(entry)}
              sx={{ gap: 1.25 }}
              data-testid="chat-session-artifacts-item"
              data-artifact-key={entry.key}
            >
              <Box
                aria-hidden="true"
                sx={{
                  flexShrink: 0,
                  width: 26,
                  height: 26,
                  borderRadius: 'sm',
                  display: 'grid',
                  placeItems: 'center',
                  bgcolor: avatar.background,
                  color: avatar.color,
                  fontSize: 12,
                  fontWeight: 600,
                  userSelect: 'none',
                }}
              >
                {initialOf(entry.artifact.title)}
              </Box>
              <Box sx={{ flex: 1, minWidth: 0 }}>
                <Typography level="body-sm" textColor="inherit" noWrap title={entry.artifact.title}>
                  {entry.artifact.title}
                </Typography>
                <Typography level="body-xs" textColor="text.tertiary" noWrap>
                  {typeLabel(entry.artifact.type)}
                  {updated && (
                    <>
                      {' \u00b7 '}
                      <span data-testid="chat-session-artifacts-updated">{updated}</span>
                    </>
                  )}
                </Typography>
              </Box>
            </MenuItem>
          );
        })}
      </Menu>
    </Dropdown>
  );
}
