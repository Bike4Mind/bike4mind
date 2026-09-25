import { Sheet, Typography } from '@mui/joy';
import type { TutorialItem } from './tutorialCatalog';

/**
 * One feature card in the Tutorials grid.
 *
 * With `onOpen` the whole card is a button into the detail view. Without it the
 * call to action is a label, not a control: on Getting Started it will point at
 * the feature's row in the sidenav, and until that is wired a card that looks
 * clickable and does nothing is worse than one that plainly is not.
 */
const TutorialCard = ({ item, onOpen }: { item: TutorialItem; onOpen?: () => void }) => {
  const interactive = !!onOpen;

  return (
    <Sheet
      variant="outlined"
      data-testid={`tutorial-card-${item.key}`}
      {...(interactive
        ? {
            role: 'button',
            tabIndex: 0,
            onClick: onOpen,
            onKeyDown: (event: React.KeyboardEvent) => {
              if (event.key === 'Enter' || event.key === ' ') {
                event.preventDefault();
                onOpen();
              }
            },
          }
        : {})}
      sx={theme => ({
        display: 'flex',
        flexDirection: 'column',
        p: '20px',
        borderRadius: '12px',
        // The softest step of the border scale (an 8% brand tint, not a solid
        // stroke): `divider` is the app's full-strength rule, which reads as drawn
        // lines across a grid of twenty cards.
        borderColor: theme.palette.border.soft,
        // The chat area's own colour (SessionMiddle), so a card reads as the same
        // kind of surface as the main content region rather than as frame chrome.
        backgroundColor: theme.palette.background.body,
        ...(interactive && {
          cursor: 'pointer',
          // ease-out, and the lift a little slower than the colours: motion that
          // decelerates into place reads as settling rather than snapping.
          transition:
            'background-color 0.18s ease-out, border-color 0.18s ease-out, transform 0.22s cubic-bezier(0.2, 0.8, 0.3, 1)',
          '&:hover': {
            // The gentlest hover step in the theme (30% dark / 12% light); the lift
            // and the border step carry most of the signal here.
            backgroundColor: theme.palette.loginRegister.termsAndPrivacy.hoverBg,
            // One step up the same scale (8% -> 15%) rather than jumping to the
            // solid outlined stroke, so hover reads as the edge firming up rather
            // than a different border appearing.
            borderColor: theme.palette.border.light,
            transform: 'translateY(-2px)',
          },
          // A lift is decorative motion, so it is dropped for anyone who has asked
          // the system for less of it; the colour changes still mark the hover.
          '@media (prefers-reduced-motion: reduce)': {
            transition: 'background-color 0.18s ease-out, border-color 0.18s ease-out',
            '&:hover': { transform: 'none' },
          },
          '&:focus-visible': {
            outline: `2px solid ${theme.palette.primary[500]}`,
            outlineOffset: '2px',
          },
        }),
      })}
    >
      <Typography level="title-md" sx={{ fontSize: '18px', fontWeight: 500 }}>
        {item.title}
      </Typography>

      <Typography level="body-sm" sx={{ mt: '8px', fontSize: '14px', color: 'text.tertiary' }}>
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
        {interactive ? 'Learn more' : item.cta} &rarr;
      </Typography>
    </Sheet>
  );
};

export default TutorialCard;
