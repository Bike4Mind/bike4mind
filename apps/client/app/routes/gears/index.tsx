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
import { useGearsStatus, type GearKey } from '@client/app/hooks/useGearsStatus';
import { useFeatureEnabled } from '@client/app/hooks/useFeatureEnabled';
import { useAdminSettingsCache } from '@client/app/hooks/useAdminSettingsCache';
import { useFileBrowser } from '@client/app/components/Files/Browser';

/**
 * Gears — the earned-nav progression page, and the product's tutorial system
 * disguised as a trophy case.
 *
 * Destinations earn their sidenav slot on first real use (the permanent rail
 * is New Chat / Gears / Help). Skills are capabilities worth discovering —
 * no nav effect, just the checkmark and the credit reward. Every card is a
 * zero-state intro with a do-the-first-thing CTA; unlock state is derived
 * server-side (see pages/api/gears/status.ts).
 */

interface GearCardDef {
  key: GearKey;
  title: string;
  tagline: string;
  intro: string;
  cta: string;
  icon: React.ReactNode;
}

const DESTINATION_CARDS: GearCardDef[] = [
  {
    key: 'projects',
    title: 'Projects',
    tagline: 'One goal, one place',
    intro:
      'Group chats, files, and teammates around a single goal. Everything a project needs stays findable in one workspace.',
    cta: 'Create your first project',
    icon: <HubOutlinedIcon />,
  },
  {
    key: 'agents',
    title: 'Agents',
    tagline: 'Work that runs itself',
    intro:
      'Autonomous workers that carry out multi-step jobs — research, drafting, monitoring — and report back when done.',
    cta: 'Build your first agent',
    icon: <SmartToyOutlinedIcon />,
  },
  {
    key: 'datalakes',
    title: 'Data Lakes',
    tagline: 'Answers from YOUR documents',
    intro:
      'Ground the AI in your own material. Upload documents once; every answer can retrieve and cite your sources first.',
    cta: 'Create your first data lake',
    icon: <WaterOutlinedIcon />,
  },
  {
    key: 'files',
    title: 'Files',
    tagline: 'Bring your stuff',
    intro: 'Upload anything — PDFs, spreadsheets, images — and reference it from any chat or project.',
    cta: 'Upload your first file',
    icon: <FolderSharedIcon />,
  },
  {
    key: 'published',
    title: 'Published',
    tagline: 'Your work, one link',
    intro:
      'Turn any artifact into a shareable web page — public, passphrase-protected, or restricted to email domains you choose.',
    cta: 'See how publishing works',
    icon: <PublicOutlinedIcon />,
  },
];

const SKILL_CARDS: GearCardDef[] = [
  {
    key: 'image',
    title: 'Image Generation',
    tagline: 'Paint with a prompt',
    intro: 'Ask any chat to generate or edit an image — concept art, diagrams, marketing shots.',
    cta: 'Generate your first image',
    icon: <ImageOutlinedIcon />,
  },
  {
    key: 'models',
    title: 'Model Explorer',
    tagline: 'Same question, different minds',
    intro:
      'Switch the AI model mid-conversation — trade speed for depth, or compare answers across providers. Unlocks after chatting on two different models.',
    cta: 'Try another model',
    icon: <SwapHorizOutlinedIcon />,
  },
  {
    key: 'react',
    title: 'React Artifacts',
    tagline: 'Working apps, not walls of text',
    intro: 'Ask for an interactive React app — a calculator, a dashboard, a game — and run it right in the chat.',
    cta: 'Build a React artifact',
    icon: <CodeOutlinedIcon />,
  },
  {
    key: 'python',
    title: 'Python Artifacts',
    tagline: 'Real computation, live',
    intro: 'Ask for runnable Python — data crunching, plots, simulations — executed safely in your browser.',
    cta: 'Run some Python',
    icon: <DataObjectOutlinedIcon />,
  },
  {
    key: 'voice',
    title: 'Voice',
    tagline: 'Talk it through',
    intro: 'Have the conversation out loud — hands-free chats with any model, transcribed as you go.',
    cta: 'Start a voice chat',
    icon: <MicOutlinedIcon />,
  },
  {
    key: 'shareproject',
    title: 'Team Up',
    tagline: 'Better together',
    intro: 'Invite a teammate into a project — shared chats, shared files, shared context.',
    cta: 'Share a project',
    icon: <GroupAddOutlinedIcon />,
  },
  {
    key: 'apikey',
    title: 'API Key',
    tagline: 'Your programmatic handle',
    intro: 'Issue yourself an API key and take Bike4Mind beyond the browser — scripts, integrations, pipelines.',
    cta: 'Issue an API key',
    icon: <KeyIcon />,
  },
  {
    key: 'apicall',
    title: 'API Call',
    tagline: 'Hello, world',
    intro: 'Make your first API request — one curl with your key and the completions endpoint answers.',
    cta: 'Make your first call',
    icon: <TerminalOutlinedIcon />,
  },
];

const GearsPage = () => {
  const navigate = useNavigate();
  const { data, isPending } = useGearsStatus();
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
  const destinationCards = DESTINATION_CARDS.filter(c => gearVisible(c.key));
  const skillCards = SKILL_CARDS.filter(c => gearVisible(c.key));
  const allCards = [...destinationCards, ...skillCards];

  // Surface fresh unlock rewards the moment the status lands.
  useEffect(() => {
    if (!data || toastedRef.current) return;
    const awarded = data.gears.filter(g => g.creditsAwarded);
    if (awarded.length > 0) {
      toastedRef.current = true;
      for (const g of awarded) {
        const card = allCards.find(c => c.key === g.key);
        toast.success(`Gear unlocked: ${card?.title ?? g.key} — +${g.creditsAwarded} credits`);
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [data]);

  const byKey = new Map(data?.gears.map(g => [g.key, g]) ?? []);
  const unlockedCount = allCards.filter(c => byKey.get(c.key)?.unlocked).length;

  const onCta = (key: GearKey) => {
    if (key === 'files') return void setFileBrowserOpen(true);
    if (key === 'projects' || key === 'shareproject') return void navigate({ to: '/projects' });
    if (key === 'agents') return void navigate({ to: '/agents' });
    if (key === 'datalakes') return void navigate({ to: '/data-lakes' });
    if (key === 'published') return void navigate({ to: '/profile', search: { tab: 'published' } });
    if (key === 'apikey' || key === 'apicall') {
      return void navigate({ to: '/profile', search: { tab: 'settings' } });
    }
    // Chat-native skills: start a fresh chat and try it.
    return void navigate({ to: '/new' });
  };

  const renderCards = (cards: GearCardDef[]) => (
    <Box
      sx={{
        display: 'grid',
        gridTemplateColumns: { xs: '1fr', sm: '1fr 1fr', md: '1fr 1fr 1fr' },
        gap: 2,
      }}
    >
      {cards.map(card => {
        const status = byKey.get(card.key);
        const unlocked = status?.unlocked === true;
        return (
          <Card
            key={card.key}
            variant={unlocked ? 'soft' : 'outlined'}
            data-testid={`gear-card-${card.key}`}
            sx={{ display: 'flex', flexDirection: 'column', gap: 1 }}
          >
            <Stack direction="row" alignItems="center" justifyContent="space-between">
              <Stack direction="row" alignItems="center" gap={1}>
                {card.icon}
                <Typography level="title-md">{card.title}</Typography>
              </Stack>
              {unlocked ? (
                <CheckCircleIcon color="success" fontSize="small" data-testid={`gear-unlocked-${card.key}`} />
              ) : (
                status &&
                status.credits > 0 && (
                  <Chip size="sm" variant="soft" color="success">
                    +{status.credits}
                  </Chip>
                )
              )}
            </Stack>
            <Typography level="body-xs" sx={{ textTransform: 'uppercase', letterSpacing: '0.08em', opacity: 0.7 }}>
              {card.tagline}
            </Typography>
            <Typography level="body-sm" sx={{ flex: 1, opacity: 0.85 }}>
              {card.intro}
            </Typography>
            <Button
              size="sm"
              variant={unlocked ? 'plain' : 'solid'}
              onClick={() => onCta(card.key)}
              loading={isPending}
              data-testid={`gear-cta-${card.key}`}
            >
              {unlocked ? 'Open' : card.cta}
            </Button>
          </Card>
        );
      })}
    </Box>
  );

  return (
    <Box sx={{ maxWidth: 960, mx: 'auto', px: 3, py: 4 }} data-testid="gears-page">
      <Stack direction="row" alignItems="center" gap={1.5} sx={{ mb: 0.5 }}>
        <SettingsOutlinedIcon />
        <Typography level="h2">Gears</Typography>
      </Stack>
      <Typography level="body-md" sx={{ mb: 1, opacity: 0.8 }}>
        Every feature you use for the first time earns a checkmark and a credit bonus — destinations also earn their
        place in your sidebar.
      </Typography>
      <Stack direction="row" alignItems="center" gap={1.5} sx={{ mb: 3 }}>
        <LinearProgress
          determinate
          value={allCards.length ? (unlockedCount / allCards.length) * 100 : 0}
          sx={{ flex: 1, maxWidth: 320 }}
        />
        <Typography level="body-sm" sx={{ whiteSpace: 'nowrap', opacity: 0.8 }} data-testid="gears-progress">
          {unlockedCount} / {allCards.length} unlocked
        </Typography>
      </Stack>

      <Typography level="title-lg" sx={{ mb: 1.5 }}>
        Destinations
      </Typography>
      <Typography level="body-sm" sx={{ mb: 2, opacity: 0.75 }}>
        First use earns these a slot in your sidebar.
      </Typography>
      {renderCards(destinationCards)}

      <Typography level="title-lg" sx={{ mt: 4, mb: 1.5 }}>
        Skills
      </Typography>
      <Typography level="body-sm" sx={{ mb: 2, opacity: 0.75 }}>
        Capabilities worth knowing about — try each once.
      </Typography>
      {renderCards(skillCards)}
    </Box>
  );
};

export default GearsPage;
