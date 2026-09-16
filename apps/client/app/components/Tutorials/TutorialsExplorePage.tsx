import { useState } from 'react';
import { Box, Button, Sheet, Tab, TabList, TabPanel, Tabs, Typography } from '@mui/joy';
import { styled } from '@mui/system';
import { profileTabListSx } from '@client/app/routes/profile/profileTabListSx';
import HelpCenterOutlinedIcon from '@mui/icons-material/HelpCenterOutlined';
import { openHelpPanel } from '@client/app/hooks/useHelpPanel';
import TutorialCard from './TutorialCard';
import TutorialDetailView from './TutorialDetailView';
import { tabOpensDetail, tutorialItemsFor, type TutorialsTabKey } from './tutorialCatalog';

/**
 * Tutorials - the feature-discovery surface.
 *
 * Frame only at this stage: the tab shell and the panel each category fills.
 * Card content comes from GEAR_PRESENTATION (titles, taglines, intros) so this
 * page never holds a second copy of feature copy that can drift from Gears.
 *
 * Deliberately does NOT call /api/gears/status: that endpoint grants gear
 * credits as a side effect of being read, and rewards belong to Achievements,
 * not to a page you can browse. Reading the static presentation map keeps this
 * surface inert by construction rather than by a flag.
 */

const TABS: { key: TutorialsTabKey; label: string }[] = [
  { key: 'getting-started', label: 'Getting Started' },
  { key: 'advanced', label: 'Advanced' },
  { key: 'developers', label: 'For Developers' },
  { key: 'achievements', label: 'Achievements' },
];

const TutorialsExplorePage = () => {
  const [tab, setTab] = useState<TutorialsTabKey>('getting-started');
  // Which card is expanded, per tab. Cleared on tab change so switching away and
  // back lands on the list rather than reopening whatever was last read.
  const [openKey, setOpenKey] = useState<string | null>(null);

  return (
    <Box
      sx={{
        height: '100%',
        // The page is the only scroller: the frame grows to its content and this
        // container scrolls it. Padding (not centring) sets the gap above the
        // frame, so the same gap is there when scrolled back to the top - a
        // centred frame would collapse that space as soon as content overflowed.
        overflowY: 'auto',
        // Side gutters keep the frame off the viewport edges once it is narrower
        // than its 1400px cap; the vertical padding stays tighter so the 80vh
        // frame is not squeezed on short screens.
        px: { xs: '16px', sm: '24px', md: '40px' },
        py: { xs: '16px', md: '24px' },
      }}
    >
      <Sheet
        variant="outlined"
        data-testid="tutorials-page-frame"
        sx={theme => ({
          width: '100%',
          maxWidth: '1400px',
          mx: 'auto',
          // Fills the viewport when a tab is short, grows past it when a tab is
          // long. Subtracts this container's own vertical padding so the frame
          // ends exactly where the bottom gap begins.
          minHeight: { xs: 'calc(100vh - 32px)', md: 'calc(100vh - 48px)' },
          display: 'flex',
          flexDirection: 'column',
          borderRadius: '12px',
          borderColor: theme.palette.divider,
          // Same frame colour as the first-run slider: the sidebar surface in dark
          // mode, the Joy Sheet default in light. Keeps the two tutorial surfaces
          // reading as one family while both exist.
          backgroundColor: theme.palette.mode === 'dark' ? theme.palette.background.surface2 : undefined,
          p: { xs: '20px', md: '32px' },
        })}
      >
        <Box
          sx={{
            display: 'flex',
            alignItems: 'flex-start',
            justifyContent: 'space-between',
            gap: '16px',
            flexWrap: 'wrap',
          }}
        >
          <Box>
            <Typography level="h2" sx={{ fontWeight: 500, fontSize: '20px' }}>
              Tutorials
            </Typography>
            {/* Placeholder copy, pending the real subtitle. */}
            <Typography level="body-sm" sx={{ mt: '6px', maxWidth: '500px', fontSize: '14px', color: 'text.tertiary' }}>
              Lorem ipsum id pellentesque nibh neque ultrices elit sem nisl et volutpat amet lacus venenatis sem at
              quisque ullamcorper ante.
            </Typography>
            <Typography
              level="body-sm"
              data-testid="tutorials-wip-notice"
              sx={{ mt: '6px', maxWidth: '500px', fontSize: '14px', fontWeight: 500, color: 'primary.500' }}
            >
              Work in progress - nothing here is wired up yet. The cards are placeholders and the text is not final.
            </Typography>
          </Box>

          {/* Interim: the Help Center is its own sidenav surface today and moves
              under this page later, so this is a link out rather than a tab. */}
          <Button
            variant="outlined"
            color="neutral"
            size="sm"
            startDecorator={<HelpCenterOutlinedIcon />}
            onClick={() => openHelpPanel()}
            data-testid="tutorials-helpcenter-btn"
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
        </Box>

        <Tabs
          value={tab}
          onChange={(_, value) => {
            setTab(value as TutorialsTabKey);
            setOpenKey(null);
          }}
          sx={{ mt: '32px' }}
          aria-label="Tutorial categories"
        >
          <TabList data-testid="tutorials-tablist" sx={tabListSx}>
            {TABS.map(({ key, label }) => (
              <StyledTab key={key} value={key} data-testid={`tutorials-tab-${key}`}>
                {/* Colour set here, as on /profile: the opacity step in StyledTab is what
                    separates active from inactive, so the label itself stays primary ink. */}
                <Typography sx={{ color: 'text.primary' }}>{label}</Typography>
              </StyledTab>
            ))}
          </TabList>

          {TABS.map(({ key }) => (
            <TabPanel key={key} value={key} sx={{ px: 0, pt: '24px', pb: 0 }}>
              <TutorialsPanel tab={key} openKey={openKey} onOpen={setOpenKey} />
            </TabPanel>
          ))}
        </Tabs>
      </Sheet>
    </Box>
  );
};

/** A tab's body: the card grid, or the detail view of whichever card is open. */
const TutorialsPanel = ({
  tab,
  openKey,
  onOpen,
}: {
  tab: TutorialsTabKey;
  openKey: string | null;
  onOpen: (key: string | null) => void;
}) => {
  const items = tutorialItemsFor(tab);
  const opensDetail = tabOpensDetail(tab);
  const open = opensDetail && openKey ? items.find(item => item.key === openKey) : undefined;

  if (open) {
    return <TutorialDetailView item={open} onBack={() => onOpen(null)} />;
  }

  return (
    <Box
      data-testid={`tutorials-panel-${tab}`}
      sx={{
        display: 'grid',
        // Cards size themselves; the column count follows the frame width rather
        // than the viewport, so the grid reflows with the sidenav open or closed
        // without a media query.
        gridTemplateColumns: 'repeat(auto-fill, minmax(min(320px, 100%), 1fr))',
        gap: '16px',
        alignItems: 'stretch',
      }}
    >
      {items.map(item => (
        <TutorialCard key={item.key} item={item} onOpen={opensDetail ? () => onOpen(item.key) : undefined} />
      ))}
    </Box>
  );
};

/**
 * The /profile tab strip, plus one fix for this page.
 *
 * Joy derives a child radius from `--List-radius` and applies it to the items
 * marked data-first-child / data-last-child, which rounds the OUTER corners of
 * the whole strip - the TabList root itself also paints `var(--List-radius)`.
 * Squaring the tabs alone cannot reach either, so zero the variable instead.
 */
const tabListSx = {
  ...profileTabListSx,
  '--List-radius': '0px',
  // Tabs is a flex column, so the strip is a flex item and would shrink below its
  // own height on a short frame. profileTabListSx only pins the tabs INSIDE the
  // strip (the horizontal axis); this pins the strip itself.
  flexShrink: 0,
} as const;

// StyledTab from /profile, used as-is minus its icon rules (these tabs are text only).
const StyledTab = styled(Tab)(({ theme }) => ({
  borderBottomLeftRadius: '0',
  borderBottomRightRadius: '0',
  '&:hover:not([aria-selected="true"])': {
    backgroundColor: `${theme.palette.notebooklist.hoverBg} !important`,
    '& .MuiTypography-root': {
      opacity: 1,
    },
  },
  '& .MuiTypography-root': {
    opacity: 0.7,
  },
  '&[aria-selected="true"] .MuiTypography-root': {
    opacity: 1,
  },
}));

export default TutorialsExplorePage;
