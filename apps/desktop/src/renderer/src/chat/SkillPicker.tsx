import { useEffect, useRef } from 'react';
import Box from '@mui/joy/Box';
import Button from '@mui/joy/Button';
import Chip from '@mui/joy/Chip';
import List from '@mui/joy/List';
import ListItemButton from '@mui/joy/ListItemButton';
import Sheet from '@mui/joy/Sheet';
import Stack from '@mui/joy/Stack';
import Typography from '@mui/joy/Typography';
import type { SkillSummary } from '@shared/skills';
import { contentColumnSx } from './layout';

/** Past this the menu scrolls rather than pushing the transcript off the top of the window. */
const MAX_HEIGHT = 280;

/**
 * The `/` menu above the composer.
 *
 * Deliberately not a Joy `Menu`: a menu steals focus, and the whole point here is that the
 * textarea keeps it - the user carries on typing to filter, and arrow keys move a highlight in a
 * list they are not focused on. So this is a plain listbox the composer drives, and the only
 * pointer interaction is clicking a row.
 *
 * Every row says where it came from. A project skill is instruction text that arrived with a
 * clone, and "it looked like one of mine" is exactly the confusion the label exists to prevent.
 */
export function SkillPicker({
  skills,
  activeIndex,
  untrustedProject,
  onPick,
  onTrustProject,
}: {
  skills: readonly SkillSummary[];
  activeIndex: number;
  /** The bound project whose skills are being withheld, if any. See SkillsState. */
  untrustedProject: string | null;
  onPick: (skill: SkillSummary) => void;
  onTrustProject: () => void;
}) {
  const activeRef = useRef<HTMLDivElement | null>(null);

  // Arrow keys arrive at the textarea, so nothing scrolls the highlight into view on its own.
  useEffect(() => {
    activeRef.current?.scrollIntoView({ block: 'nearest' });
  }, [activeIndex]);

  if (skills.length === 0 && !untrustedProject) {
    return (
      <Box sx={{ ...contentColumnSx, pt: 1 }}>
        <Sheet variant="outlined" sx={{ borderRadius: 'md', px: 2, py: 1.25 }} data-testid="skill-picker">
          <Typography level="body-xs" textColor="text.tertiary">
            No skills found. Put one in ~/.claude/skills/&lt;name&gt;/SKILL.md and type / again.
          </Typography>
        </Sheet>
      </Box>
    );
  }

  return (
    <Box sx={{ ...contentColumnSx, pt: 1 }}>
      <Sheet
        variant="outlined"
        sx={{ borderRadius: 'md', maxHeight: MAX_HEIGHT, overflowY: 'auto' }}
        data-testid="skill-picker"
      >
        {untrustedProject && (
          <Stack
            direction="row"
            spacing={1}
            alignItems="center"
            sx={{ px: 1.5, py: 1, borderBottom: skills.length > 0 ? '1px solid' : 'none', borderColor: 'divider' }}
            data-testid="skill-picker-trust"
          >
            <Box sx={{ flex: 1, minWidth: 0 }}>
              <Typography level="body-xs" textColor="text.secondary">
                This project ships its own skills. They run instructions written by whoever wrote the repository.
              </Typography>
              <Typography level="body-xs" textColor="text.tertiary" noWrap title={untrustedProject}>
                {untrustedProject}
              </Typography>
            </Box>
            <Button size="sm" variant="soft" color="warning" onClick={onTrustProject} data-testid="skill-trust-btn">
              Trust
            </Button>
          </Stack>
        )}

        <List size="sm" sx={{ '--ListItem-paddingY': '6px' }}>
          {skills.map((skill, index) => (
            <ListItemButton
              key={`${skill.source}:${skill.name}`}
              ref={index === activeIndex ? activeRef : undefined}
              selected={index === activeIndex}
              // Mouse down, not click: a click fires after the textarea has already lost focus,
              // and the caret position the insertion needs would be gone with it.
              onMouseDown={event => {
                event.preventDefault();
                onPick(skill);
              }}
              data-testid="skill-picker-option"
            >
              <Box sx={{ minWidth: 0, flex: 1 }}>
                <Stack direction="row" spacing={0.75} alignItems="baseline" sx={{ minWidth: 0 }}>
                  <Typography level="title-sm" noWrap>
                    /{skill.name}
                  </Typography>
                  {skill.argumentHint && (
                    <Typography level="body-xs" textColor="text.tertiary" noWrap>
                      {skill.argumentHint}
                    </Typography>
                  )}
                  <Box sx={{ flex: 1 }} />
                  <Chip
                    size="sm"
                    variant="soft"
                    color={skill.source === 'project' ? 'warning' : 'neutral'}
                    title={skill.filePath}
                  >
                    {skill.source}
                  </Chip>
                </Stack>
                <Typography level="body-xs" textColor="text.tertiary" noWrap>
                  {skill.description}
                </Typography>
              </Box>
            </ListItemButton>
          ))}
        </List>
      </Sheet>
    </Box>
  );
}
