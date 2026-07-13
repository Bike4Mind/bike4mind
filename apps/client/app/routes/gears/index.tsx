import { Box, Button, Card, Chip, LinearProgress, Stack, Typography } from '@mui/joy';
import { useNavigate } from '@tanstack/react-router';
import { useEffect, useRef } from 'react';
import { toast } from 'sonner';
import CheckCircleIcon from '@mui/icons-material/CheckCircle';
import HubOutlinedIcon from '@mui/icons-material/HubOutlined';
import SmartToyOutlinedIcon from '@mui/icons-material/SmartToyOutlined';
import WaterOutlinedIcon from '@mui/icons-material/WaterOutlined';
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
import { api } from '@client/app/contexts/ApiContext';
import { useGearsStatus, type GearKey, type GearStatus } from '@client/app/hooks/useGearsStatus';
import { useFeatureEnabled } from '@client/app/hooks/useFeatureEnabled';
import { useAdminSettingsCache } from '@client/app/hooks/useAdminSettingsCache';
import { useFileBrowser } from '@client/app/components/Files/Browser';

/**
 * Gears - the earned-nav progression page.
 *
 * Presentation (title/tagline/intro/CTA) is SERVER truth: the status endpoint
 * serves the code defaults merged with any Manage Gears admin overrides, so a
 * live copy or reward change needs no deploy. This page contributes only the
 * icons and the ctaAction interpreter.
 */

const GEAR_ICONS: Partial<Record<GearKey, React.ReactNode>> = {
  projects: <HubOutlinedIcon />,
  agents: <SmartToyOutlinedIcon />,
  datalakes: <WaterOutlinedIcon />,
  files: <FolderSharedIcon />,
  published: <PublicOutlinedIcon />,
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

const GearsPage = () => {
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
    return true;
  };
  const gears = (data?.gears ?? []).filter(g => gearVisible(g.key));
  const destinations = gears.filter(g => g.kind === 'destination');
  const skills = gears.filter(g => g.kind === 'skill');
  const unlockedCount = gears.filter(g => g.unlocked).length;

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
      window.open(action.slice('external:'.length), '_blank', 'noopener');
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

  const renderCards = (cards: GearStatus[]) => (
    <Box
      sx={{
        display: 'grid',
        gridTemplateColumns: { xs: '1fr', sm: '1fr 1fr', md: '1fr 1fr 1fr' },
        gap: 2,
      }}
    >
      {cards.map(gear => (
        <Card
          key={gear.key}
          variant={gear.unlocked ? 'soft' : 'outlined'}
          data-testid={`gear-card-${gear.key}`}
          sx={{ display: 'flex', flexDirection: 'column', gap: 1 }}
        >
          <Stack direction="row" alignItems="center" justifyContent="space-between">
            <Stack direction="row" alignItems="center" gap={1}>
              {GEAR_ICONS[gear.key] ?? <SettingsOutlinedIcon />}
              <Typography level="title-md">{gear.title}</Typography>
            </Stack>
            {gear.unlocked ? (
              <Stack direction="row" alignItems="center" gap={0.75}>
                {gear.rewardPending && (
                  <Chip size="sm" variant="soft" color="warning" data-testid={`gear-pending-${gear.key}`}>
                    +{gear.credits} on first visitor
                  </Chip>
                )}
                <CheckCircleIcon color="success" fontSize="small" data-testid={`gear-unlocked-${gear.key}`} />
              </Stack>
            ) : (
              gear.credits > 0 && (
                <Chip size="sm" variant="soft" color="success">
                  +{gear.credits}
                </Chip>
              )
            )}
          </Stack>
          <Typography level="body-xs" sx={{ textTransform: 'uppercase', letterSpacing: '0.08em', opacity: 0.7 }}>
            {gear.tagline}
          </Typography>
          <Typography level="body-sm" sx={{ flex: 1, opacity: 0.85 }}>
            {gear.intro}
          </Typography>
          <Button
            size="sm"
            variant={gear.unlocked ? 'plain' : 'solid'}
            onClick={() => onCta(gear)}
            data-testid={`gear-cta-${gear.key}`}
          >
            {gear.unlocked ? 'Open' : gear.cta}
          </Button>
        </Card>
      ))}
    </Box>
  );

  return (
    // Own scroll container (same pattern as the Agents/Projects pages): the app
    // layout is a fixed-height shell, so a page taller than the viewport must
    // scroll itself or the overflow is simply clipped.
    <Box sx={{ height: '100%', overflowY: 'auto', overflowX: 'hidden' }} data-testid="gears-page">
      <Box sx={{ maxWidth: 960, mx: 'auto', px: 3, py: 4 }}>
        <Stack direction="row" alignItems="center" gap={1.5} sx={{ mb: 0.5 }}>
          <SettingsOutlinedIcon />
          <Typography level="h2">Gears</Typography>
        </Stack>
        <Typography level="body-md" sx={{ mb: 1, opacity: 0.8 }}>
          Every feature you use for the first time earns a checkmark and a credit bonus - destinations also earn their
          place in your sidebar.
        </Typography>
        <Stack direction="row" alignItems="center" gap={1.5} sx={{ mb: 3 }}>
          <LinearProgress
            determinate={!isPending}
            value={gears.length ? (unlockedCount / gears.length) * 100 : 0}
            sx={{ flex: 1, maxWidth: 320 }}
          />
          <Typography level="body-sm" sx={{ whiteSpace: 'nowrap', opacity: 0.8 }} data-testid="gears-progress">
            {isPending ? 'Checking the grid...' : `${unlockedCount} / ${gears.length} unlocked`}
          </Typography>
        </Stack>

        {!isPending && (
          <>
            <Typography level="title-lg" sx={{ mb: 1.5 }}>
              Destinations
            </Typography>
            <Typography level="body-sm" sx={{ mb: 2, opacity: 0.75 }}>
              First use earns these a slot in your sidebar.
            </Typography>
            {renderCards(destinations)}

            <Typography level="title-lg" sx={{ mt: 4, mb: 1.5 }}>
              Explore Features
            </Typography>
            <Typography level="body-sm" sx={{ mb: 2, opacity: 0.75 }}>
              Capabilities worth knowing about - try each once.
            </Typography>
            {renderCards(skills)}
          </>
        )}
      </Box>
    </Box>
  );
};

export default GearsPage;
