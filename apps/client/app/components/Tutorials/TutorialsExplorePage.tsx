import { useState } from 'react';
import { Box, TabList, TabPanel, Tabs, Typography } from '@mui/joy';
import { PageTab, pageTabListSx } from '@client/app/components/common/pageTabs';
import PageFrame from '@client/app/components/common/PageFrame';
import HelpCenterButton from '@client/app/components/common/HelpCenterButton';
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
    <PageFrame testId="tutorials-page-frame">
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

        <HelpCenterButton testId="tutorials-helpcenter-btn" />
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
        <TabList data-testid="tutorials-tablist" sx={pageTabListSx}>
          {TABS.map(({ key, label }) => (
            <PageTab key={key} value={key} data-testid={`tutorials-tab-${key}`}>
              {/* Colour set here, as on /profile: the opacity step in PageTab is what
                    separates active from inactive, so the label itself stays primary ink. */}
              <Typography sx={{ color: 'text.primary' }}>{label}</Typography>
            </PageTab>
          ))}
        </TabList>

        {TABS.map(({ key }) => (
          <TabPanel key={key} value={key} sx={{ px: 0, pt: '24px', pb: 0 }}>
            <TutorialsPanel tab={key} openKey={openKey} onOpen={setOpenKey} />
          </TabPanel>
        ))}
      </Tabs>
    </PageFrame>
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

export default TutorialsExplorePage;
