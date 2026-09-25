import { Box, Card, Chip, Stack, TabList, TabPanel, Tabs, Tooltip, Typography } from '@mui/joy';
import { useNavigate } from '@tanstack/react-router';
import { useEffect, useRef, useState } from 'react';
import { toast } from 'sonner';
import CheckCircleIcon from '@mui/icons-material/CheckCircle';
import HubOutlinedIcon from '@mui/icons-material/HubOutlined';
import SmartToyOutlinedIcon from '@mui/icons-material/SmartToyOutlined';
import FolderSharedIcon from '@mui/icons-material/FolderSharedOutlined';
import PublicOutlinedIcon from '@mui/icons-material/PublicOutlined';
import SettingsOutlinedIcon from '@mui/icons-material/SettingsOutlined';
import KeyIcon from '@mui/icons-material/Key';
import TerminalOutlinedIcon from '@mui/icons-material/TerminalOutlined';
import ImageOutlinedIcon from '@mui/icons-material/ImageOutlined';
import MicOutlinedIcon from '@mui/icons-material/MicOutlined';
import SwapHorizOutlinedIcon from '@mui/icons-material/SwapHorizOutlined';
import CodeOutlinedIcon from '@mui/icons-material/CodeOutlined';
import DataObjectOutlinedIcon from '@mui/icons-material/DataObjectOutlined';
import GroupAddOutlinedIcon from '@mui/icons-material/GroupAddOutlined';
import ForkRightOutlinedIcon from '@mui/icons-material/ForkRightOutlined';
import DownloadOutlinedIcon from '@mui/icons-material/DownloadOutlined';
import AutoAwesomeOutlinedIcon from '@mui/icons-material/AutoAwesomeOutlined';
import PsychologyOutlinedIcon from '@mui/icons-material/PsychologyOutlined';
import MovieOutlinedIcon from '@mui/icons-material/MovieOutlined';
import CableOutlinedIcon from '@mui/icons-material/CableOutlined';
import SecurityOutlinedIcon from '@mui/icons-material/SecurityOutlined';
import ForumOutlinedIcon from '@mui/icons-material/ForumOutlined';
import CloudDownloadOutlinedIcon from '@mui/icons-material/CloudDownloadOutlined';
import TravelExploreOutlinedIcon from '@mui/icons-material/TravelExploreOutlined';
import BoltOutlinedIcon from '@mui/icons-material/BoltOutlined';
import IosShareOutlinedIcon from '@mui/icons-material/IosShareOutlined';
import SearchOutlinedIcon from '@mui/icons-material/SearchOutlined';
import LanguageOutlinedIcon from '@mui/icons-material/LanguageOutlined';
import FunctionsOutlinedIcon from '@mui/icons-material/FunctionsOutlined';
import CalculateOutlinedIcon from '@mui/icons-material/CalculateOutlined';
import MenuBookOutlinedIcon from '@mui/icons-material/MenuBookOutlined';
import LocalFireDepartmentOutlinedIcon from '@mui/icons-material/LocalFireDepartmentOutlined';
import { api } from '@client/app/contexts/ApiContext';
import { useGearsStatus, type GearKey, type GearStatus } from '@client/app/hooks/useGearsStatus';
import { useFeatureEnabled } from '@client/app/hooks/useFeatureEnabled';
import { useAdminSettingsCache } from '@client/app/hooks/useAdminSettingsCache';
import { useFileBrowser } from '@client/app/components/Files/Browser';
import { DataLakeIcon } from '@client/app/components/datalake/dataLakeBranding';
import { openInNewTab } from '@client/app/utils/externalLinks';
import PageFrame from '@client/app/components/common/PageFrame';
import Bike4MindIcon from '@client/app/components/svgs/icons/Bike4MindIcon';
import HelpCenterButton from '@client/app/components/common/HelpCenterButton';
import { PageTab, pageTabListSx } from '@client/app/components/common/pageTabs';

/**
 * Gears - the earned-nav progression page.
 *
 * Presentation (title/intro/CTA) is SERVER truth: the status endpoint
 * serves the code defaults merged with any Manage Gears admin overrides, so a
 * live copy or reward change needs no deploy. This page contributes only the
 * icons and the ctaAction interpreter.
 */

const GEAR_ICONS: Partial<Record<GearKey, React.ReactNode>> = {
  projects: <HubOutlinedIcon />,
  agents: <SmartToyOutlinedIcon />,
  datalakes: <DataLakeIcon />,
  files: <FolderSharedIcon />,
  published: <PublicOutlinedIcon />,
  hearth: <LocalFireDepartmentOutlinedIcon />,
  image: <ImageOutlinedIcon />,
  models: <SwapHorizOutlinedIcon />,
  react: <CodeOutlinedIcon />,
  python: <DataObjectOutlinedIcon />,
  voice: <MicOutlinedIcon />,
  shareproject: <GroupAddOutlinedIcon />,
  apikey: <KeyIcon />,
  apicall: <TerminalOutlinedIcon />,
  forknotebook: <ForkRightOutlinedIcon />,
  downloadnotebook: <DownloadOutlinedIcon />,
  questmaster: <AutoAwesomeOutlinedIcon />,
  mementos: <PsychologyOutlinedIcon />,
  video: <MovieOutlinedIcon />,
  mcp: <CableOutlinedIcon />,
  mfa: <SecurityOutlinedIcon />,
  slack: <ForumOutlinedIcon />,
  importopenai: <CloudDownloadOutlinedIcon />,
  importclaude: <CloudDownloadOutlinedIcon />,
  research: <TravelExploreOutlinedIcon />,
  rapidreply: <BoltOutlinedIcon />,
  shareagent: <IosShareOutlinedIcon />,
  websearch: <SearchOutlinedIcon />,
  webfetch: <LanguageOutlinedIcon />,
  wolfram: <FunctionsOutlinedIcon />,
  matheval: <CalculateOutlinedIcon />,
  clidocs: <MenuBookOutlinedIcon />,
};

/** The reward as prose, for the tooltips: the chip shows the bare number. */
const creditText = (gear: GearStatus) => `${gear.credits.toLocaleString()} credit${gear.credits === 1 ? '' : 's'}`;

type GearsTabKey = 'destinations' | 'features';

const TABS: { key: GearsTabKey; label: string }[] = [
  { key: 'destinations', label: 'Destinations' },
  { key: 'features', label: 'Explore Features' },
];

const GearsPage = () => {
  const [tab, setTab] = useState<GearsTabKey>('destinations');
  const navigate = useNavigate();
  const { data, isPending, refetch } = useGearsStatus();
  const { isFeatureEnabled } = useFeatureEnabled();
  const { isFeatureEnabled: isAdminFeatureEnabled } = useAdminSettingsCache();
  const { setOpen: setFileBrowserOpen } = useFileBrowser();
  // Guard against double-toasting in strict mode / refetches.
  const toastedRef = useRef(false);

  // Same gating as the sidenav: a gear whose feature is off for this deployment
  // isn't offered at all (it would dead-end on gated endpoints).
  const gearVisible = (key: GearKey) => {
    if (key === 'agents') return isFeatureEnabled('enableAgents');
    if (key === 'datalakes') return isAdminFeatureEnabled('EnableDataLakes');
    if (key === 'hearth') return isFeatureEnabled('enableHearth');
    return true;
  };
  const gears = (data?.gears ?? []).filter(g => gearVisible(g.key));
  const destinations = gears.filter(g => g.kind === 'destination');
  const skills = gears.filter(g => g.kind === 'skill');

  // Surface fresh unlock rewards the moment the status lands.
  useEffect(() => {
    if (!data || toastedRef.current) return;
    const awarded = data.gears.filter(g => g.creditsAwarded);
    if (awarded.length > 0) {
      toastedRef.current = true;
      for (const g of awarded) {
        toast.success(`Gear unlocked: ${g.title} - +${g.creditsAwarded} credits`);
      }
    }
  }, [data]);

  /** Interpret a gear's ctaAction - see lib/gears/presentation.ts for the grammar. */
  const onCta = (gear: GearStatus) => {
    const [action, stampDirective] = gear.ctaAction.split('#');
    const stampKey = stampDirective?.startsWith('stamp:') ? stampDirective.slice('stamp:'.length) : null;
    const claimStamp = () => {
      if (!stampKey) return;
      void api
        .post('/api/gears/stamp', { key: stampKey })
        .then(() => refetch())
        .catch(() => undefined);
    };

    if (action === 'files') {
      setFileBrowserOpen(true);
      claimStamp();
      return;
    }
    if (action.startsWith('external:')) {
      openInNewTab(action.slice('external:'.length));
      claimStamp();
      return;
    }
    if (action.startsWith('navigate:')) {
      const target = action.slice('navigate:'.length);
      const [pathname, query] = target.split('?');
      const search = query ? Object.fromEntries(new URLSearchParams(query).entries()) : undefined;
      claimStamp();
      // Admin-authored paths aren't in TanStack's static route union.
      void navigate({ to: pathname, search } as never);
    }
  };

  const renderCards = (cards: GearStatus[]) =>
    isPending ? (
      <Typography level="body-sm" sx={{ opacity: 0.7 }} data-testid="gears-loading">
        Checking the grid...
      </Typography>
    ) : (
      <Box
        sx={{
          display: 'grid',
          gridTemplateColumns: { xs: '1fr', sm: '1fr 1fr', md: '1fr 1fr 1fr' },
          gap: 2,
        }}
      >
        {cards.map(gear => (
          // Every card looks the same whether or not its gear is earned: the page is
          // a place to read about features, and a checkmark grid turns it into a
          // score. The unlock still happens and still pays - it just is not what
          // this surface is for.
          // The whole card is the control, as in Tutorials: a solid Button per card
          // painted a grid of twenty-odd primary rectangles, which reads as twenty
          // equally urgent calls to action rather than a list to browse.
          <Card
            key={gear.key}
            variant="outlined"
            data-testid={`gear-card-${gear.key}`}
            role="button"
            tabIndex={0}
            onClick={() => onCta(gear)}
            onKeyDown={event => {
              if (event.key === 'Enter' || event.key === ' ') {
                event.preventDefault();
                onCta(gear);
              }
            }}
            sx={theme => ({
              display: 'flex',
              flexDirection: 'column',
              // Spacing is per-child rather than a single column gap: the steps down
              // the card differ, so each margin is the gap above that element.
              gap: 0,
              cursor: 'pointer',
              transition:
                'background-color 0.18s ease-out, border-color 0.18s ease-out, transform 0.22s cubic-bezier(0.2, 0.8, 0.3, 1)',
              '&:hover': {
                backgroundColor: theme.palette.loginRegister.termsAndPrivacy.hoverBg,
                borderColor: theme.palette.border.light,
                transform: 'translateY(-2px)',
              },
              '@media (prefers-reduced-motion: reduce)': {
                transition: 'background-color 0.18s ease-out, border-color 0.18s ease-out',
                '&:hover': { transform: 'none' },
              },
              '&:focus-visible': {
                outline: `2px solid ${theme.palette.primary[500]}`,
                outlineOffset: '2px',
              },
            })}
          >
            <Stack direction="row" alignItems="center" justifyContent="space-between" gap={1}>
              {/* GEAR_ICONS holds bare elements, so the icon size is set once here
                rather than repeated on every entry in the map. */}
              <Stack direction="row" alignItems="center" gap={1} sx={{ '& > svg': { fontSize: '20px' } }}>
                {GEAR_ICONS[gear.key] ?? <SettingsOutlinedIcon />}
                <Typography level="title-md">{gear.title}</Typography>
              </Stack>
              {/* The ONLY thing on the card that knows whether the gear is earned.
                The card itself stays identical either way - greying the whole
                card out said "this is spent", when what is spent is the reward. */}
              {gear.unlocked ? (
                gear.rewardPending ? (
                  <Tooltip title="Reward not claimed yet">
                    <Chip
                      size="sm"
                      variant="soft"
                      color="warning"
                      startDecorator={<Bike4MindIcon size="12" />}
                      data-testid={`gear-pending-${gear.key}`}
                      // Joy sets gap as a plain declaration per size (3px on sm), not
                      // as a variable, so it is overridden directly.
                      sx={{ gap: '6px' }}
                    >
                      {gear.credits.toLocaleString()}
                    </Chip>
                  </Tooltip>
                ) : (
                  // The checkmark stands for a claimed reward, so it waits for the
                  // payout rather than the unlock - and it is the only trace of the
                  // amount, the chip that carried the number being gone by then.
                  <Tooltip title={`Reward claimed - ${creditText(gear)}`}>
                    <CheckCircleIcon color="success" fontSize="small" data-testid={`gear-unlocked-${gear.key}`} />
                  </Tooltip>
                )
              ) : (
                gear.credits > 0 && (
                  <Tooltip title={`Earn ${creditText(gear)} the first time you use this.`}>
                    <Chip
                      size="sm"
                      variant="soft"
                      color="success"
                      startDecorator={<Bike4MindIcon size="12" />}
                      sx={{ gap: '6px' }}
                    >
                      {gear.credits.toLocaleString()}
                    </Chip>
                  </Tooltip>
                )
              )}
            </Stack>
            <Typography level="body-sm" sx={{ opacity: 0.85, mt: '16px' }}>
              {gear.intro}
            </Typography>
            {/* The deferred payout gets a full line rather than chip text: it is the
                one state a glance at a colour cannot explain, and there is room here.
                Worded for Published, the only gear that declares a rewardCheck - a
                second one would need this copy to come from the gear instead. */}
            {gear.rewardPending && (
              <Typography
                level="body-xs"
                data-testid={`gear-pending-note-${gear.key}`}
                // The same token the soft chip paints its own text with.
                sx={{ mt: '16px', color: 'warning.softColor' }}
              >
                {creditText(gear)} will be claimed once someone else opens your artifact link.
              </Typography>
            )}
            {/* Pinned to the bottom so the CTAs line up across a row of uneven cards. */}
            <Typography
              level="body-sm"
              data-testid={`gear-cta-${gear.key}`}
              sx={{ mt: 'auto', pt: '20px', color: 'text.primary' }}
            >
              {/* An HTML entity rather than the arrow character, so this file stays
                ASCII: Prettier rewrites a unicode escape back into the character. */}
              {gear.cta} &rarr;
            </Typography>
          </Card>
        ))}
      </Box>
    );

  return (
    <PageFrame testId="gears-page">
      <Box data-testid="gears-page-body">
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
              Gears
            </Typography>
            <Typography level="body-sm" sx={{ mt: '6px', maxWidth: '500px', fontSize: '14px', color: 'text.tertiary' }}>
              A tour of what Bike4Mind can do. The first time you use one of these, it pays a one-time credit bonus.
            </Typography>
          </Box>

          <HelpCenterButton testId="gears-helpcenter-btn" />
        </Box>

        {/* The tabs are static, so they render before the status lands - only the
            grid inside a panel waits. */}
        <Tabs
          value={tab}
          onChange={(_, value) => setTab(value as GearsTabKey)}
          sx={{ mt: '32px' }}
          aria-label="Gear categories"
        >
          <TabList data-testid="gears-tablist" sx={pageTabListSx}>
            {TABS.map(({ key, label }) => (
              <PageTab key={key} value={key} data-testid={`gears-tab-${key}`}>
                {/* Colour set here, as on /profile: the opacity step in PageTab is what
                    separates active from inactive, so the label itself stays primary ink. */}
                <Typography sx={{ color: 'text.primary' }}>{label}</Typography>
              </PageTab>
            ))}
          </TabList>

          <TabPanel value="destinations" sx={{ px: 0, pt: '24px', pb: 0 }}>
            {renderCards(destinations)}
          </TabPanel>

          <TabPanel value="features" sx={{ px: 0, pt: '24px', pb: 0 }}>
            {renderCards(skills)}
          </TabPanel>
        </Tabs>
      </Box>
    </PageFrame>
  );
};

export default GearsPage;
