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
  {
    key: 'forknotebook',
    title: 'Fork a Notebook',
    tagline: 'Branch the timeline',
    intro:
      'Fork any conversation from any message — explore a what-if without losing the original thread. Find it in the message ⋯ menu.',
    cta: 'Open a notebook to fork',
    icon: <ForkRightOutlinedIcon />,
  },
  {
    key: 'downloadnotebook',
    title: 'Download a Notebook',
    tagline: 'Take it with you',
    intro: 'Export a curated notebook as a file — share it, archive it, or read it offline.',
    cta: 'Download a notebook',
    icon: <DownloadOutlinedIcon />,
  },
  {
    key: 'questmaster',
    title: 'Quest Master',
    tagline: 'A mission, not a message',
    intro: 'Hand the AI a multi-step goal — it plans, executes in parallel, and reports back.',
    cta: 'Start your first quest',
    icon: <AutoAwesomeOutlinedIcon />,
  },
  {
    key: 'mementos',
    title: 'Mementos',
    tagline: 'It remembers so you do not have to',
    intro: 'Automatic memory across conversations — facts about you and your work, captured and recalled.',
    cta: 'Make a memory',
    icon: <PsychologyOutlinedIcon />,
  },
  {
    key: 'video',
    title: 'Video Generation',
    tagline: 'Prompt to motion',
    intro: 'Generate short video from a text prompt, right in the conversation.',
    cta: 'Generate a video',
    icon: <MovieOutlinedIcon />,
  },
  {
    key: 'research',
    title: 'Research Engine',
    tagline: 'Deep dives, cited',
    intro: 'Multi-source research runs that gather, read, and cite the web for you.',
    cta: 'Run a research task',
    icon: <TravelExploreOutlinedIcon />,
  },
  {
    key: 'rapidreply',
    title: 'Rapid Reply',
    tagline: 'Answers at the speed of chat',
    intro: 'One-tap AI replies where the conversation already lives.',
    cta: 'Try Rapid Reply',
    icon: <BoltOutlinedIcon />,
  },
  {
    key: 'mcp',
    title: 'MCP Server',
    tagline: 'Plug in your own tools',
    intro: 'Connect a Model Context Protocol server and give every chat your custom tools.',
    cta: 'Connect an MCP server',
    icon: <CableOutlinedIcon />,
  },
  {
    key: 'slack',
    title: 'Slack',
    tagline: 'B4M where your team talks',
    intro: 'Bring Bike4Mind into Slack — notebooks that live in your channels and threads.',
    cta: 'Chat from Slack',
    icon: <ForumOutlinedIcon />,
  },
  {
    key: 'importopenai',
    title: 'Import from ChatGPT',
    tagline: 'Bring your history home',
    intro: 'Import your entire ChatGPT export — every conversation searchable alongside your new work.',
    cta: 'Import ChatGPT history',
    icon: <CloudDownloadOutlinedIcon />,
  },
  {
    key: 'importclaude',
    title: 'Import from Claude',
    tagline: 'Bring your history home',
    intro: 'Import your Claude export — your past conversations, vectorized and searchable here.',
    cta: 'Import Claude history',
    icon: <CloudDownloadOutlinedIcon />,
  },
  {
    key: 'mfa',
    title: 'Lock It Down',
    tagline: 'Your account, actually yours',
    intro: 'Turn on two-factor authentication — TOTP with backup codes.',
    cta: 'Enable 2FA',
    icon: <SecurityOutlinedIcon />,
  },
  {
    key: 'shareagent',
    title: 'Share an Agent',
    tagline: 'Your agent, their hands',
    intro: 'Publish an agent or share it with teammates — expertise that multiplies.',
    cta: 'Share an agent',
    icon: <IosShareOutlinedIcon />,
  },
  {
    key: 'websearch',
    title: 'Web Search',
    tagline: 'The live internet, in-chat',
    intro: 'Let a conversation search the web for current answers.',
    cta: 'Ask something current',
    icon: <SearchOutlinedIcon />,
  },
  {
    key: 'webfetch',
    title: 'Web Fetch',
    tagline: 'Read any page',
    intro: 'Pull a specific URL into the conversation and work with its content.',
    cta: 'Fetch a page',
    icon: <LanguageOutlinedIcon />,
  },
  {
    key: 'wolfram',
    title: 'Wolfram Alpha',
    tagline: 'Real math, step by step',
    intro: 'Symbolic math and computational answers with worked steps.',
    cta: 'Compute something',
    icon: <FunctionsOutlinedIcon />,
  },
  {
    key: 'matheval',
    title: 'Math Evaluation',
    tagline: 'Numbers you can trust',
    intro: 'Exact calculation in-chat — no LLM arithmetic hallucinations.',
    cta: 'Crunch a number',
    icon: <CalculateOutlinedIcon />,
  },
  {
    key: 'clidocs',
    title: 'Meet the CLI',
    tagline: 'B4M in your terminal',
    intro:
      'A full command-line interface — scripts, pipes, and agents from your shell. Peek at the docs to earn this one.',
    cta: 'Open the CLI docs',
    icon: <MenuBookOutlinedIcon />,
  },
];

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
    if (key === 'agents' || key === 'shareagent') return void navigate({ to: '/agents' });
    if (key === 'datalakes') return void navigate({ to: '/data-lakes' });
    if (key === 'published') return void navigate({ to: '/profile', search: { tab: 'published' } });
    if (key === 'apikey' || key === 'apicall' || key === 'mfa' || key === 'importopenai' || key === 'importclaude') {
      return void navigate({ to: '/profile', search: { tab: 'settings' } });
    }
    if (key === 'clidocs') {
      // Curiosity gear: opening the docs IS the unlock (self-attested, priced
      // accordingly — see the stamp endpoint's allowlist note).
      window.open('https://docs.bike4mind.com/cli/', '_blank', 'noopener');
      void api
        .post('/api/gears/stamp', { key: 'clidocs' })
        .then(() => refetch())
        .catch(() => undefined);
      return;
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
                <Stack direction="row" alignItems="center" gap={0.75}>
                  {status?.rewardPending && (
                    <Chip size="sm" variant="soft" color="warning" data-testid={`gear-pending-${card.key}`}>
                      +{status.credits} on first visitor
                    </Chip>
                  )}
                  <CheckCircleIcon color="success" fontSize="small" data-testid={`gear-unlocked-${card.key}`} />
                </Stack>
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
    </Box>
  );
};

export default GearsPage;
