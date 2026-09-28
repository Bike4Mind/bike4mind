import { Button } from '@mui/joy';
import HelpCenterOutlinedIcon from '@mui/icons-material/HelpCenterOutlined';
import { openHelpPanel } from '@client/app/hooks/useHelpPanel';

/**
 * The Help Center link that sits in the top-right of the Gears page.
 *
 * Interim: the Help Center is its own sidenav surface today and moves under
 * these pages later, so this is a link out rather than a tab.
 */
const HelpCenterButton = ({ testId }: { testId: string }) => (
  <Button
    variant="outlined"
    color="neutral"
    size="sm"
    startDecorator={<HelpCenterOutlinedIcon />}
    onClick={() => openHelpPanel()}
    data-testid={testId}
    sx={theme => ({
      // Matches the sidebar's profile card (profile-menu-card): body bg in
      // light, surface in dark. The resting colour is a plain declaration on
      // purpose - Joy's outlined variant defines no `--variant-outlinedBg`,
      // so it paints no background at rest and there is nothing to lose to.
      // Hover DOES come from a variant variable, so that one must be set as a
      // variable or the variant's own rule wins.
      backgroundColor:
        theme.palette.mode === 'light' ? theme.palette.background.body : theme.palette.background.surface,
      '--variant-outlinedHoverBg': theme.palette.notebooklist.hoverBg,
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

export default HelpCenterButton;
