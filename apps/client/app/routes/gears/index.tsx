import { Box, Button, Card, Chip, chipClasses, Stack, TabList, TabPanel, Tabs, Tooltip, Typography } from '@mui/joy';
import { useNavigate } from '@tanstack/react-router';
import { cloneElement, useState } from 'react';
import { toast } from 'sonner';
import CheckIcon from '@mui/icons-material/Check';
import HubOutlinedIcon from '@mui/icons-material/HubOutlined';
import SmartToyOutlinedIcon from '@mui/icons-material/SmartToyOutlined';
import FolderSharedIcon from '@mui/icons-material/FolderSharedOutlined';
import PublicOutlinedIcon from '@mui/icons-material/PublicOutlined';
import SettingsOutlinedIcon from '@mui/icons-material/SettingsOutlined';
import KeyOutlinedIcon from '@mui/icons-material/KeyOutlined';
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
import MusicNoteOutlinedIcon from '@mui/icons-material/MusicNoteOutlined';
import GraphicEqOutlinedIcon from '@mui/icons-material/GraphicEqOutlined';
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
import { useClaimGear, type GearKey, type GearStatus } from '@client/app/hooks/useGearsStatus';
import { GETTING_STARTED_LEAD, isGettingStarted, useVisibleGears } from '@client/app/hooks/useVisibleGears';
import { neutralFrame, rewardGreen } from '@client/app/components/common/gearRewardStyles';
import { useFileBrowser } from '@client/app/components/Files/Browser';
import { DataLakeIcon } from '@client/app/components/datalake/dataLakeBranding';
import { openInNewTab } from '@client/app/utils/externalLinks';
import PageFrame from '@client/app/components/common/PageFrame';
import FeatureDetailView from '@client/app/components/common/FeatureDetailView';
import Bike4MindIcon from '@client/app/components/svgs/icons/Bike4MindIcon';
import { gray, grayAlpha } from '@client/app/utils/themes/colors';
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

const GEAR_ICONS: Partial<Record<GearKey, React.ReactElement>> = {
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
  apikey: <KeyOutlinedIcon />,
  apicall: <TerminalOutlinedIcon />,
  forknotebook: <ForkRightOutlinedIcon />,
  downloadnotebook: <DownloadOutlinedIcon />,
  questmaster: <AutoAwesomeOutlinedIcon />,
  mementos: <PsychologyOutlinedIcon />,
  video: <MovieOutlinedIcon />,
  music: <MusicNoteOutlinedIcon />,
  sound: <GraphicEqOutlinedIcon />,
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

type RewardState = 'locked' | 'claimable' | 'pending' | 'claimed';

const rewardState = (gear: GearStatus): RewardState => {
  // Checked before the unlock: a paid gear whose data was deleted is locked
  // again, but offering its reward a second time would be a promise the claim
  // endpoint refuses.
  if (gear.claimed) return 'claimed';
  if (!gear.unlocked) return 'locked';
  if (gear.claimable) return 'claimable';
  return gear.rewardPending ? 'pending' : 'claimed';
};

/**
 * The reward marker in a card's top-right corner, and again in the long-form
 * view's header, so opening a card never hides what it pays or lets it be claimed.
 * The ONLY thing on a card that knows whether the gear is earned: the card itself
 * stays identical either way - greying the whole card out said "this is spent",
 * when what is spent is the reward.
 */
const RewardChip = ({
  gear,
  reward,
  onClaim,
  labeled = false,
}: {
  gear: GearStatus;
  reward: RewardState;
  onClaim: () => void;
  /** Spell the claim out beside the chip, for the long-form header, which has
   *  the width a card's top row does not. */
  labeled?: boolean;
}) => {
  const amount = (clickable: boolean) => (
    <Chip
      size="sm"
      variant="soft"
      color={reward === 'claimable' ? 'success' : 'neutral'}
      startDecorator={<Bike4MindIcon size="12" />}
      data-testid={`gear-reward-${gear.key}`}
      {...(clickable && {
        onClick: (event: React.MouseEvent) => {
          event.stopPropagation();
          onClaim();
        },
      })}
      sx={theme => {
        const { ink, stroke, fill, hoverFill, activeFill } =
          reward === 'claimable'
            ? rewardGreen(theme)
            : {
                ink: theme.palette.text.primary,
                stroke: theme.palette.border.muted,
                fill: grayAlpha[150][10],
                hoverFill: grayAlpha[150][10],
                activeFill: grayAlpha[150][10],
              };
        return {
          gap: '6px',
          '--Chip-minHeight': '24px',
          fontSize: '13px',
          backgroundColor: fill,
          // A clickable Chip lays its action button over the root and paints it
          // from these variables, so without them the green under it never shows.
          '--variant-softBg': fill,
          '--variant-softHoverBg': hoverFill,
          '--variant-softActiveBg': activeFill,
          '--variant-softColor': ink,
          '--variant-softHoverColor': ink,
          '--variant-softActiveColor': ink,
          border: `1px solid ${stroke}`,
          color: ink,
          // Bike4MindIcon fills with var(--Icon-color), which Joy's
          // variant would otherwise set from its own palette.
          '--Icon-color': ink,
        };
      }}
    >
      {gear.credits.toLocaleString()}
    </Chip>
  );

  // Text and chip are one button rather than two targets for the same action:
  // one hit area, one tab stop, and the label reads as the button it is.
  if (labeled && reward === 'claimable') {
    return (
      <Box
        component="button"
        data-testid={`gear-claim-${gear.key}`}
        onClick={onClaim}
        sx={theme => ({
          display: 'inline-flex',
          alignItems: 'center',
          gap: '10px',
          p: 0,
          border: 0,
          background: 'none',
          font: 'inherit',
          fontSize: '13px',
          fontWeight: 500,
          color: rewardGreen(theme).ink,
          cursor: 'pointer',
          // The chip inside is not clickable itself, so it gets the hover and press
          // of the clickable one from here.
          '&:hover > span': { textDecoration: 'underline' },
          [`&:hover .${chipClasses.root}`]: { backgroundColor: rewardGreen(theme).hoverFill },
          [`&:active .${chipClasses.root}`]: { backgroundColor: rewardGreen(theme).activeFill },
          '&:focus-visible': {
            outline: `2px solid ${theme.palette.primary[500]}`,
            outlineOffset: '2px',
            borderRadius: '6px',
          },
        })}
      >
        <span>Claim {creditText(gear)}</span>
        {amount(false)}
      </Box>
    );
  }

  return (
    <>
      {reward === 'pending' && (
        <Tooltip title="Reward not claimed yet">
          <Chip
            size="sm"
            variant="soft"
            color="warning"
            startDecorator={<Bike4MindIcon size="12" />}
            data-testid={`gear-pending-${gear.key}`}
            // Joy sets gap as a plain declaration per size (3px on sm), not
            // as a variable, so it is overridden directly.
            sx={theme => ({
              gap: '6px',
              '--Chip-minHeight': '24px',
              fontSize: '13px',
              // The chip's own text colour, as the green and grey chips are
              // stroked in theirs.
              border: `1px solid ${theme.palette.warning.softColor}`,
            })}
          >
            {gear.credits.toLocaleString()}
          </Chip>
        </Tooltip>
      )}
      {reward === 'claimed' && (
        <Tooltip title={`Reward claimed - ${creditText(gear)}`}>
          <Chip
            size="sm"
            variant="soft"
            color="neutral"
            data-testid={`gear-unlocked-${gear.key}`}
            sx={theme => ({
              ...neutralFrame(theme),
              '--Chip-minHeight': '24px',
              // Joy sizes a Chip from its content plus padding-inline and
              // caps it at `max-content`, so a circle needs the padding
              // cancelled, the cap lifted and the width pinned - otherwise
              // the 16px glyph plus the border wins at 18px.
              '--Chip-paddingInline': '0px',
              width: '24px',
              minWidth: '24px',
              maxWidth: '24px',
              borderRadius: '50%',
              justifyContent: 'center',
              color: theme.palette.text.tertiary,
              // Joy's label slot is an inline-block that grows to fill the
              // chip, so the glyph inside it sits on the text baseline
              // rather than in the middle of the circle.
              [`& .${chipClasses.label}`]: {
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                lineHeight: 1,
              },
            })}
          >
            <CheckIcon sx={{ fontSize: '16px', display: 'block' }} />
          </Chip>
        </Tooltip>
      )}
      {/* Locked and claimable share one shape: the neutral frame says "there
                is a reward here", and green is kept for the one state that asks for
                something. */}
      {(reward === 'locked' || reward === 'claimable') && gear.credits > 0 && (
        <Tooltip
          title={
            reward === 'claimable'
              ? `Claim ${creditText(gear)}`
              : `Earn ${creditText(gear)} the first time you use this.`
          }
        >
          {amount(reward === 'claimable')}
        </Tooltip>
      )}
    </>
  );
};

/**
 * Each glyph's own bounds inside MUI's 24x24 box, measured with getBBox and
 * squared off, used as the icon's viewBox.
 *
 * Material's keylines differ by shape on purpose - a circle spans 20 units, a
 * square 18, a bar 16 - so at one font-size the drawings range from 16 to 24 and
 * a column of them reads as a jumble. Cropping the box to the glyph makes every
 * drawing fill the same 20px, where scaling the svg would have grown the element
 * past it. Only the glyphs that miss the common '2 2 20' keyline are listed.
 */
/** The slot every icon occupies, and the glyph drawn inside it. A fixed slot
 *  keeps the titles aligned across cards whatever the glyph does. */
const ICON_SLOT = 20;
const ICON_BOX = 16;
const GLYPH_VIEWBOX: Partial<Record<GearKey, string>> = {
  projects: '0 -0.5 24 24',
  agents: '1 0.5 22 22',
  datalakes: '2 2.5 20 20',
  hearth: '2.5 2 19 19',
  image: '3 3 18 18',
  models: '3 3 18 18',
  voice: '2.5 2 19 19',
  shareproject: '0 0 24 24',
  apikey: '1 1 22 22',
  forknotebook: '4 3 18 18',
  downloadnotebook: '3.5 3 17 17',
  questmaster: '1 1 22 22',
  mementos: '3 3 18 18',
  music: '3 3 18 18',
  mcp: '3 3 18 18',
  mfa: '1 1 22 22',
  importopenai: '0 0 24 24',
  importclaude: '0 0 24 24',
  research: '2 1.75 20.5 20.5',
  rapidreply: '3 3 18 18',
  shareagent: '1 1 22 22',
  websearch: '3 3 17.49 17.49',
  wolfram: '4 4 16 16',
  matheval: '3 3 18 18',
  clidocs: '1 2 22 22',
};

type GearsTabKey = 'getting-started' | 'features' | 'generators' | 'integrations';

/** Tabs whose cards open the long-form view instead of acting at once. Getting
 *  Started is the exception: those features have a sidenav row to go to, so an
 *  explanation would sit between the user and the thing itself. */
const TABS_WITH_DETAIL: readonly GearsTabKey[] = ['features', 'generators', 'integrations'];

const TABS: { key: GearsTabKey; label: string }[] = [
  { key: 'getting-started', label: 'Getting Started' },
  { key: 'features', label: 'Explore Features' },
  { key: 'generators', label: 'Generators' },
  { key: 'integrations', label: 'Integrations' },
];

/** Skills that turn a prompt into a media file. Grouped here rather than by
 *  `kind`, which the endpoint owns and which only separates the gears that earn
 *  a sidenav row from everything else. */
const GENERATOR_KEYS: GearKey[] = ['image', 'video', 'music', 'sound'];

/** Skills that connect Bike4Mind to something outside it. Slack is the only
 *  one broken out so far; MCP and the chat imports are the obvious next. */
const INTEGRATION_KEYS: GearKey[] = ['slack'];

const GearsPage = () => {
  const [tab, setTab] = useState<GearsTabKey>('getting-started');
  // Which card is expanded, per tab. Cleared on tab change so switching away and
  // back lands on the list rather than reopening whatever was last read.
  const [openKey, setOpenKey] = useState<GearKey | null>(null);
  const navigate = useNavigate();
  const { gears, isPending, refetch } = useVisibleGears();
  const { setOpen: setFileBrowserOpen } = useFileBrowser();

  const { mutate: claimGear, isPending: claiming } = useClaimGear();
  const claim = (gear: GearStatus) => {
    if (claiming) return;
    claimGear(gear.key, {
      onSuccess: result => {
        if (result.creditsAwarded) toast.success(`Reward claimed - ${creditText(gear)} for ${gear.title}`);
      },
      onError: () => toast.error("Couldn't claim the reward. Try again."),
    });
  };

  // The lead first, then the destinations in endpoint order.
  const gettingStarted = [
    ...gears.filter(g => g.key === GETTING_STARTED_LEAD),
    ...gears.filter(g => isGettingStarted(g) && g.key !== GETTING_STARTED_LEAD),
  ];
  const generators = gears.filter(g => GENERATOR_KEYS.includes(g.key));
  const integrations = gears.filter(g => INTEGRATION_KEYS.includes(g.key));
  const skills = gears.filter(
    g =>
      g.kind === 'skill' &&
      g.key !== GETTING_STARTED_LEAD &&
      !GENERATOR_KEYS.includes(g.key) &&
      !INTEGRATION_KEYS.includes(g.key)
  );
  const tabCards: Record<GearsTabKey, GearStatus[]> = {
    'getting-started': gettingStarted,
    features: skills,
    generators,
    integrations,
  };

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

  const renderCards = (cards: GearStatus[], opensDetail: boolean) => {
    const act = (gear: GearStatus) => (opensDetail ? setOpenKey(gear.key) : onCta(gear));
    return isPending ? (
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
        {cards.map(gear => {
          const reward = rewardState(gear);
          return (
            // Every card looks the same whether or not its gear is earned: the page is
            // a place to read about features, and a checkmark grid turns it into a
            // score. The unlock still happens and still pays - it just is not what
            // this surface is for.
            // The whole card is the control: a solid Button per card
            // painted a grid of twenty-odd primary rectangles, which reads as twenty
            // equally urgent calls to action rather than a list to browse.
            <Card
              key={gear.key}
              variant="outlined"
              data-testid={`gear-card-${gear.key}`}
              role="button"
              tabIndex={0}
              onClick={() => act(gear)}
              onKeyDown={event => {
                if (event.key === 'Enter' || event.key === ' ') {
                  event.preventDefault();
                  act(gear);
                }
              }}
              sx={theme => ({
                display: 'flex',
                flexDirection: 'column',
                // Joy paints both a Card and PageFrame's Sheet with background.surface,
                // so without this the card would sit on its own colour in light mode and
                // read as a 1px outline on a flat sheet. White is a step past the theme's
                // body grey, to lift the card off the frame rather than just clear it.
                backgroundColor: theme.palette.mode === 'dark' ? theme.palette.background.body : gray[0],
                // The softest step of the border scale: `divider`
                // is the app's full-strength rule and reads as drawn lines across a
                // grid of thirty cards.
                borderColor: theme.palette.border.soft,
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
                {/* GEAR_ICONS holds bare elements, so size and colour are set once
                here rather than repeated on every entry in the map. */}
                <Stack direction="row" alignItems="center" gap={1}>
                  <Box
                    sx={{
                      display: 'flex',
                      alignItems: 'center',
                      justifyContent: 'center',
                      width: `${ICON_SLOT}px`,
                      height: `${ICON_SLOT}px`,
                      flexShrink: 0,
                      // Tertiary because an icon at title strength competes with the
                      // title beside it, thirty times over.
                      color: 'text.tertiary',
                      '& > svg': { fontSize: `${ICON_BOX}px` },
                    }}
                  >
                    {cloneElement(GEAR_ICONS[gear.key] ?? <SettingsOutlinedIcon />, {
                      viewBox: GLYPH_VIEWBOX[gear.key] ?? '2 2 20 20',
                    })}
                  </Box>
                  <Typography level="title-md">{gear.title}</Typography>
                </Stack>
                <RewardChip gear={gear} reward={reward} onClaim={() => claim(gear)} />
              </Stack>
              <Typography level="body-sm" sx={{ opacity: 0.85, mt: '16px' }}>
                {gear.intro}
              </Typography>
              {/* The deferred payout gets a full line rather than chip text: it is the
                one state a glance at a colour cannot explain, and there is room here.
                Worded for Published, the only gear that declares a rewardCheck - a
                second one would need this copy to come from the gear instead. */}
              {reward === 'pending' && (
                <Typography
                  level="body-xs"
                  data-testid={`gear-pending-note-${gear.key}`}
                  // The same token the soft chip paints its own text with.
                  sx={{ mt: '16px', fontSize: '13px', color: 'warning.softColor' }}
                >
                  {creditText(gear)} will be claimed once someone else opens your artifact link.
                </Typography>
              )}
              {/* The claim is a line of its own rather than a wider chip: the top row
                has no room to spare beside a long title, and this is where the eye
                lands after reading the card. */}
              {reward === 'claimable' && (
                <Typography
                  level="body-xs"
                  component="button"
                  data-testid={`gear-claim-${gear.key}`}
                  onClick={event => {
                    event.stopPropagation();
                    claim(gear);
                  }}
                  onKeyDown={event => event.stopPropagation()}
                  sx={theme => ({
                    alignSelf: 'flex-start',
                    mt: '16px',
                    p: 0,
                    border: 0,
                    background: 'none',
                    font: 'inherit',
                    fontSize: '13px',
                    fontWeight: 500,
                    color: rewardGreen(theme).ink,
                    cursor: 'pointer',
                    '&:hover': { textDecoration: 'underline' },
                    '&:focus-visible': {
                      outline: `2px solid ${theme.palette.primary[500]}`,
                      outlineOffset: '2px',
                      borderRadius: '4px',
                    },
                  })}
                >
                  Claim {creditText(gear)}
                </Typography>
              )}
              {/* Pinned to the bottom so the CTAs line up across a row of uneven cards. */}
              <Typography
                level="body-sm"
                data-testid={`gear-cta-${gear.key}`}
                sx={{ mt: 'auto', pt: '20px', color: 'text.primary' }}
              >
                {opensDetail ? 'Learn more' : gear.cta}
                {/* An HTML entity rather than the arrow character, so this file stays
                ASCII: Prettier rewrites a unicode escape back into the character. */}
                <Box component="span" sx={{ ml: '6px' }}>
                  &rarr;
                </Box>
              </Typography>
            </Card>
          );
        })}
      </Box>
    );
  };

  /** A tab's body: the card grid, or the long-form view of whichever card is open. */
  const renderPanel = (cards: GearStatus[], tabKey: GearsTabKey) => {
    const opensDetail = TABS_WITH_DETAIL.includes(tabKey);
    const open = opensDetail && openKey ? cards.find(g => g.key === openKey) : undefined;
    if (!open) return renderCards(cards, opensDetail);

    return (
      <FeatureDetailView
        item={open}
        onBack={() => setOpenKey(null)}
        testIdPrefix="gear-detail"
        aside={<RewardChip gear={open} reward={rewardState(open)} onClaim={() => claim(open)} labeled />}
        cta={
          <Button
            size="sm"
            variant="solid"
            onClick={() => onCta(open)}
            data-testid={`gear-detail-cta-${open.key}`}
            // Joy sizes a Button from this variable, so a plain `height` would be
            // fought by its own min-height.
            sx={{ '--Button-minHeight': '32px' }}
          >
            {open.cta}
          </Button>
        }
      />
    );
  };

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
            <Typography level="body-sm" sx={{ mt: '6px', maxWidth: '600px', fontSize: '14px', color: 'text.tertiary' }}>
              A tour of what Bike4Mind can do - the models you can put a question to, the places your work lives, the
              media you can generate, and what it all connects to.
            </Typography>
            <Typography
              level="body-sm"
              data-testid="gears-reward-notice"
              sx={{ mt: '6px', maxWidth: '600px', fontSize: '14px', fontWeight: 500, color: 'primary.500' }}
            >
              Every gear here pays a one-time credit bonus the first time you use it.
            </Typography>
          </Box>

          <HelpCenterButton testId="gears-helpcenter-btn" />
        </Box>

        {/* The tabs are static, so they render before the status lands - only the
            grid inside a panel waits. */}
        <Tabs
          value={tab}
          onChange={(_, value) => {
            setTab(value as GearsTabKey);
            setOpenKey(null);
          }}
          sx={{ mt: '32px' }}
          aria-label="Gear categories"
        >
          <TabList data-testid="gears-tablist" sx={pageTabListSx}>
            {TABS.map(({ key, label }) => {
              const claimable = tabCards[key].filter(g => rewardState(g) === 'claimable').length;
              return (
                <PageTab key={key} value={key} data-testid={`gears-tab-${key}`}>
                  {/* Colour set here, as on /profile: the opacity step in PageTab is what
                      separates active from inactive, so the label itself stays primary ink. */}
                  <Typography sx={{ color: 'text.primary' }}>{label}</Typography>
                  {claimable > 0 && (
                    // A Box, not Typography: PageTab fades every Typography on an
                    // inactive tab, and this count is most useful on exactly those.
                    // The claimed marker's circle in the claimable green, so the tab
                    // points at the cards the sidenav's Claim N counted.
                    <Box
                      component="span"
                      role="img"
                      aria-label={`${claimable} to claim`}
                      data-testid={`gears-tab-claimable-${key}`}
                      sx={theme => ({
                        ml: '8px',
                        minWidth: '20px',
                        height: '20px',
                        px: '5px',
                        display: 'inline-flex',
                        alignItems: 'center',
                        justifyContent: 'center',
                        borderRadius: '999px',
                        // The credit chips' own size and weight.
                        fontSize: '13px',
                        fontWeight: 500,
                        lineHeight: 1,
                        color: rewardGreen(theme).ink,
                        backgroundColor: rewardGreen(theme).fill,
                        border: `1px solid ${rewardGreen(theme).stroke}`,
                      })}
                    >
                      {claimable}
                    </Box>
                  )}
                </PageTab>
              );
            })}
          </TabList>

          <TabPanel value="getting-started" sx={{ px: 0, pt: '24px', pb: 0 }}>
            {renderPanel(tabCards['getting-started'], 'getting-started')}
          </TabPanel>

          <TabPanel value="features" sx={{ px: 0, pt: '24px', pb: 0 }}>
            {renderPanel(tabCards.features, 'features')}
          </TabPanel>

          <TabPanel value="generators" sx={{ px: 0, pt: '24px', pb: 0 }}>
            {renderPanel(tabCards.generators, 'generators')}
          </TabPanel>

          <TabPanel value="integrations" sx={{ px: 0, pt: '24px', pb: 0 }}>
            {renderPanel(tabCards.integrations, 'integrations')}
          </TabPanel>
        </Tabs>
      </Box>
    </PageFrame>
  );
};

export default GearsPage;
