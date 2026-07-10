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
import { useGearsStatus, type GearKey } from '@client/app/hooks/useGearsStatus';
import { useFeatureEnabled } from '@client/app/hooks/useFeatureEnabled';
import { useAdminSettingsCache } from '@client/app/hooks/useAdminSettingsCache';
import { useFileBrowser } from '@client/app/components/Files/Browser';

/**
 * Gears — the earned-nav progression page. One card per major feature: its
 * zero-state intro, a "do the first thing" CTA, and a checkmark once the gear
 * is unlocked (first real use). Unlocked gears appear in the sidenav; the
 * permanent rail is just New Chat / Gears / Help. Each first unlock grants a
 * one-time credit reward (see pages/api/gears/status.ts).
 */

interface GearCardDef {
  key: GearKey;
  title: string;
  tagline: string;
  intro: string;
  cta: string;
  icon: React.ReactNode;
}

const GEAR_CARDS: GearCardDef[] = [
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
  const visibleCards = GEAR_CARDS.filter(card => {
    if (card.key === 'agents') return isFeatureEnabled('enableAgents');
    if (card.key === 'datalakes') return isAdminFeatureEnabled('EnableDataLakes');
    return true;
  });

  // Surface fresh unlock rewards the moment the status lands.
  useEffect(() => {
    if (!data || toastedRef.current) return;
    const awarded = data.gears.filter(g => g.creditsAwarded);
    if (awarded.length > 0) {
      toastedRef.current = true;
      for (const g of awarded) {
        const card = GEAR_CARDS.find(c => c.key === g.key);
        toast.success(`Gear unlocked: ${card?.title ?? g.key} — +${g.creditsAwarded} credits`);
      }
    }
  }, [data]);

  const unlockedByKey = new Map(data?.gears.map(g => [g.key, g.unlocked]) ?? []);
  const unlockedCount = visibleCards.filter(c => unlockedByKey.get(c.key)).length;

  const onCta = (key: GearKey) => {
    if (key === 'files') {
      setFileBrowserOpen(true);
      return;
    }
    if (key === 'projects') return void navigate({ to: '/projects' });
    if (key === 'agents') return void navigate({ to: '/agents' });
    if (key === 'datalakes') return void navigate({ to: '/data-lakes' });
    if (key === 'published') return void navigate({ to: '/profile', search: { tab: 'published' } });
  };

  return (
    <Box sx={{ maxWidth: 960, mx: 'auto', px: 3, py: 4 }} data-testid="gears-page">
      <Stack direction="row" alignItems="center" gap={1.5} sx={{ mb: 0.5 }}>
        <SettingsOutlinedIcon />
        <Typography level="h2">Gears</Typography>
      </Stack>
      <Typography level="body-md" sx={{ mb: 1, opacity: 0.8 }}>
        Every feature you use for the first time earns its place in your sidebar — and a credit bonus.
      </Typography>
      <Stack direction="row" alignItems="center" gap={1.5} sx={{ mb: 3 }}>
        <LinearProgress
          determinate
          value={visibleCards.length ? (unlockedCount / visibleCards.length) * 100 : 0}
          sx={{ flex: 1, maxWidth: 320 }}
        />
        <Typography level="body-sm" sx={{ whiteSpace: 'nowrap', opacity: 0.8 }} data-testid="gears-progress">
          {unlockedCount} / {visibleCards.length} unlocked
        </Typography>
        {data && data.creditsPerUnlock > 0 && (
          <Chip size="sm" variant="soft" color="success">
            +{data.creditsPerUnlock} credits each
          </Chip>
        )}
      </Stack>

      <Box
        sx={{
          display: 'grid',
          gridTemplateColumns: { xs: '1fr', sm: '1fr 1fr', md: '1fr 1fr 1fr' },
          gap: 2,
        }}
      >
        {visibleCards.map(card => {
          const unlocked = unlockedByKey.get(card.key) === true;
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
                {unlocked && (
                  <CheckCircleIcon color="success" fontSize="small" data-testid={`gear-unlocked-${card.key}`} />
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
    </Box>
  );
};

export default GearsPage;
