import { Sheet, Typography } from '@mui/joy';
import type { TutorialItem } from './tutorialCatalog';

/**
 * One feature card in the Tutorials grid.
 *
 * The call to action is deliberately inert for now. On Getting Started it will
 * eventually point at the feature's row in the sidenav; on the other tabs it
 * opens a multi-step detail view. Neither is wired yet, so it renders as a
 * label rather than a control - a button that looks live and does nothing is
 * worse than one that plainly is not.
 */
const TutorialCard = ({ item }: { item: TutorialItem }) => {
  return (
    <Sheet
      variant="outlined"
      data-testid={`tutorial-card-${item.key}`}
      sx={theme => ({
        display: 'flex',
        flexDirection: 'column',
        p: '20px',
        borderRadius: '12px',
        borderColor: theme.palette.divider,
        // The chat area's own colour (SessionMiddle), so a card reads as the same
        // kind of surface as the main content region rather than as frame chrome.
        backgroundColor: theme.palette.background.body,
      })}
    >
      <Typography level="title-md" sx={{ fontSize: '18px', fontWeight: 500 }}>
        {item.title}
      </Typography>

      <Typography level="body-sm" sx={{ mt: '10px', fontSize: '14px', color: 'text.tertiary' }}>
        {item.intro}
      </Typography>

      {/* Pinned to the bottom so the CTAs line up across a row of uneven cards. */}
      <Typography
        level="body-sm"
        data-testid={`tutorial-card-cta-${item.key}`}
        sx={{ mt: 'auto', pt: '20px', fontSize: '14px', color: 'text.primary' }}
      >
        {/* An HTML entity rather than the arrow character, so this file stays
            ASCII: Prettier rewrites a unicode escape back into the character. */}
        {item.cta} &rarr;
      </Typography>
    </Sheet>
  );
};

export default TutorialCard;
