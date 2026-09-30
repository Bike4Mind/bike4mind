import { Button, IconButton } from '@mui/joy';
import type { Theme } from '@mui/joy/styles';
import HelpCenterOutlinedIcon from '@mui/icons-material/HelpCenterOutlined';
import { openHelpPanel } from '@client/app/hooks/useHelpPanel';
import { useIsMobile } from '@client/app/hooks/useIsMobile';

// Matches the sidebar's profile card (profile-menu-card): body bg in light,
// surface in dark. The resting colour is a plain declaration on purpose - Joy's
// outlined variant defines no `--variant-outlinedBg`, so it paints no background
// at rest and there is nothing to lose to. Hover DOES come from a variant
// variable, so that one must be set as a variable or the variant's own rule wins.
const surfaceSx = (theme: Theme) => ({
  backgroundColor: theme.palette.mode === 'light' ? theme.palette.background.body : theme.palette.background.surface,
  '--variant-outlinedHoverBg': theme.palette.notebooklist.hoverBg,
});

/**
 * The Help Center link that sits in the top-right of the Gears page.
 *
 * Interim: the Help Center is its own sidenav surface today and moves under
 * these pages later, so this is a link out rather than a tab.
 */
const HelpCenterButton = ({ testId }: { testId: string }) => {
  const isMobile = useIsMobile();

  // On a phone it sits in the app header beside the menu button, so it is the
  // icon alone in that button's style: no fill of its own, since the header is
  // already the surface. The desktop fill only lifts it off the page frame.
  if (isMobile) {
    return (
      <IconButton
        variant="outlined"
        color="neutral"
        size="sm"
        onClick={() => openHelpPanel()}
        aria-label="Help Center"
        data-testid={testId}
        sx={{ '--IconButton-size': '32px', borderRadius: '6px' }}
      >
        <HelpCenterOutlinedIcon />
      </IconButton>
    );
  }

  return (
    <Button
      variant="outlined"
      color="neutral"
      size="sm"
      startDecorator={<HelpCenterOutlinedIcon />}
      onClick={() => openHelpPanel()}
      data-testid={testId}
      sx={theme => ({
        ...surfaceSx(theme),
        // Joy sizes a Button from its own min-height variable; a plain `height`
        // would be fought by it on the taller size tokens. Padding-inline is a
        // flat value per size (not a variable), so it is set directly.
        '--Button-minHeight': '36px',
        paddingInline: '12px',
        fontSize: '13px',
      })}
    >
      Help Center
    </Button>
  );
};

export default HelpCenterButton;
