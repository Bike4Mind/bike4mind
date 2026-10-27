import { Box, Button, TabList, TabPanel, Tabs, Typography } from '@mui/joy';
import { useEffect, useMemo, useRef, useState } from 'react';
import { toast } from 'sonner';
import { useClaimGear, type GearKey, type GearStatus } from '@client/app/hooks/useGearsStatus';
import { useVisibleGears } from '@client/app/hooks/useVisibleGears';
import { useGearCta } from '@client/app/hooks/useGearCta';
import { GEARS_TABS, TABS_WITH_DETAIL, groupGearsByTab, type GearsTabKey } from '@client/lib/gears/tabs';
import { rewardGreen } from '@client/app/components/common/gearRewardStyles';
import PageFrame from '@client/app/components/common/PageFrame';
import FeatureDetailView from '@client/app/components/common/FeatureDetailView';
import HelpCenterButton from '@client/app/components/common/HelpCenterButton';
import { PageTab, pageTabListSx } from '@client/app/components/common/pageTabs';
import { useIsMobile } from '@client/app/hooks/useIsMobile';
import { useMobileHeader } from '@client/app/hooks/useMobileHeader';
import { FirstRunEvents } from '@bike4mind/common';
import { useLogEvent } from '@client/app/hooks/data/analytics';
import { GearCard } from '@client/app/components/gears/GearCard';
import {
  ClaimButton,
  creditText,
  PendingRewardNote,
  RewardChip,
  rewardState,
} from '@client/app/components/gears/gearReward';

/**
 * Gears - the feature tour, where each feature's one-time reward is claimed.
 *
 * Presentation (title/intro/CTA) is SERVER truth: the status endpoint
 * serves the code defaults merged with any Manage Gears admin overrides, so a
 * live copy or reward change needs no deploy. This page contributes only the
 * ctaAction interpreter.
 */

const panelSx = {
  px: 0,
  pt: { xs: '8px', sm: '24px' },
  pb: 0,
  // Its own stacking context, so nothing in a card can paint over the sticky
  // strip: a clickable Chip lifts its icon and label to z-index 1 to clear its
  // action button, which would otherwise tie with the strip and win on order.
  isolation: 'isolate',
} as const;

const GearsPage = () => {
  const { mutate: logEvent } = useLogEvent();
  // Ref-guarded so StrictMode's dev double-mount does not log the open twice.
  const openLoggedRef = useRef(false);
  useEffect(() => {
    if (openLoggedRef.current) return;
    openLoggedRef.current = true;
    logEvent({ type: FirstRunEvents.GEARS_PAGE_OPENED });
  }, [logEvent]);
  const [tab, setTab] = useState<GearsTabKey>('getting-started');
  // Which card is expanded, per tab. Cleared on tab change so switching away and
  // back lands on the list rather than reopening whatever was last read.
  const [openKey, setOpenKey] = useState<GearKey | null>(null);
  const { gears, isPending, refetch } = useVisibleGears();
  // On a phone the Help Center moves up into the app header, beside the page name.
  const isMobile = useIsMobile();
  const helpCenter = useMemo(() => <HelpCenterButton testId="gears-helpcenter-btn" />, []);
  // Desktop hides the header but still mounts it, so the button goes there only on a
  // phone - otherwise it would be in the DOM twice.
  useMobileHeader('Gears', isMobile ? helpCenter : undefined);

  const tabsRef = useRef<HTMLDivElement>(null);
  const stripRef = useRef<HTMLDivElement>(null);
  /**
   * While the strip is stuck (a phone, scrolled past the header copy), bring the
   * scroll back to where it sticks, so new content starts right under it rather
   * than wherever the old content was scrolled to. The Tabs root stays at the
   * strip's resting spot, so it sits above the strip only while the strip is stuck.
   */
  const keepTabsInView = () => {
    const root = tabsRef.current;
    const strip = stripRef.current;
    if (root && strip && root.getBoundingClientRect().top < strip.getBoundingClientRect().top) {
      root.scrollIntoView({ block: 'start' });
    }
  };
  const openCard = (key: GearKey | null) => {
    setOpenKey(key);
    keepTabsInView();
  };

  // Back lands on the card that was opened, not the top of the list, so reading
  // one write-up twenty cards down does not cost the scroll back to it.
  const cardRefs = useRef(new Map<GearKey, HTMLDivElement>());
  const returnTo = useRef<GearKey | null>(null);
  const closeCard = () => {
    returnTo.current = openKey;
    setOpenKey(null);
  };
  useEffect(() => {
    if (openKey !== null || !returnTo.current) return;
    cardRefs.current.get(returnTo.current)?.scrollIntoView({ block: 'center' });
    returnTo.current = null;
  }, [openKey]);

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

  const tabCards = groupGearsByTab(gears);

  const onCta = useGearCta(() => void refetch());

  const renderCards = (cards: GearStatus[], opensDetail: boolean) => {
    const act = (gear: GearStatus) => (opensDetail ? openCard(gear.key) : onCta(gear));
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
        {cards.map(gear => (
          <GearCard
            key={gear.key}
            gear={gear}
            ctaLabel={opensDetail ? 'Learn more' : gear.cta}
            onActivate={() => act(gear)}
            onClaim={() => claim(gear)}
            cardRef={el => {
              if (el) cardRefs.current.set(gear.key, el);
              else cardRefs.current.delete(gear.key);
            }}
          />
        ))}
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
        onBack={closeCard}
        testIdPrefix="gear-detail"
        aside={<RewardChip gear={open} reward={rewardState(open)} onClaim={() => claim(open)} labeled />}
        // A phone's header has room for the chip alone, and the copy below is long,
        // so the claim goes right under the header rather than after it.
        banner={
          rewardState(open) === 'pending' ? (
            <PendingRewardNote gear={open} />
          ) : isMobile && rewardState(open) === 'claimable' ? (
            <ClaimButton gear={open} onClaim={() => claim(open)} mt="0px" testId={`gear-detail-claim-${open.key}`} />
          ) : undefined
        }
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
        {/* A grid so the button can span the whole text column's height, top-aligned,
            as a sibling of the block. On a phone the button lives in the app header
            instead, and the copy takes the full width. */}
        <Box
          sx={{
            display: 'grid',
            gridTemplateColumns: 'minmax(0, 1fr) auto',
            columnGap: '16px',
            alignItems: 'start',
          }}
        >
          <Typography level="h2" sx={{ fontWeight: 500, fontSize: '20px' }}>
            Gears
          </Typography>
          {!isMobile && <Box sx={{ gridColumn: 2, gridRow: '1 / span 3' }}>{helpCenter}</Box>}
          <Typography
            level="body-sm"
            sx={{
              gridColumn: { xs: '1 / -1', sm: 1 },
              mt: '6px',
              maxWidth: '600px',
              fontSize: '14px',
              color: 'text.tertiary',
            }}
          >
            A tour of what Bike4Mind can do - the models you can put a question to, the places your work lives, the
            media you can generate, and what it all connects to.
          </Typography>
          <Typography
            level="body-sm"
            data-testid="gears-reward-notice"
            sx={{
              gridColumn: { xs: '1 / -1', sm: 1 },
              mt: '6px',
              maxWidth: '600px',
              fontSize: '14px',
              fontWeight: 500,
              color: 'primary.500',
            }}
          >
            Every gear here pays a one-time credit bonus the first time you use it.
          </Typography>
        </Box>

        {/* The tabs are static, so they render before the status lands - only the
            grid inside a panel waits. */}
        <Tabs
          ref={tabsRef}
          value={tab}
          onChange={(_, value) => {
            setTab(value as GearsTabKey);
            openCard(null);
          }}
          sx={{ mt: { xs: '16px', sm: '32px' } }}
          aria-label="Gear categories"
        >
          {/* On a phone the header copy scrolls away and the strip stays, so the other
              tabs are one tap away from anywhere in a long list. It pins to PageFrame's
              scroller. The sticky part is this wrapper, not the TabList, so the 16px of
              air above and below the strip does not pull the TabList's underline away
              from the active tab's indicator. The bleed reaches over the frame's 20px
              side padding so cards do not show beside it, and the fill is the frame's own.
              The Tabs margin and the panel padding give back those 16px each, so the
              strip rests where it did. */}
          <Box
            ref={stripRef}
            sx={theme => ({
              position: { xs: 'sticky', sm: 'static' },
              top: 0,
              zIndex: 1,
              flexShrink: 0,
              mx: { xs: '-20px', sm: 0 },
              px: { xs: '20px', sm: 0 },
              py: { xs: '16px', sm: 0 },
              backgroundColor: {
                xs:
                  theme.palette.mode === 'dark' ? theme.palette.background.surface2 : theme.palette.background.surface,
                sm: 'transparent',
              },
            })}
          >
            <TabList data-testid="gears-tablist" sx={pageTabListSx}>
              {GEARS_TABS.map(({ key, label }) => {
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
          </Box>

          <TabPanel value="getting-started" sx={panelSx}>
            {renderPanel(tabCards['getting-started'], 'getting-started')}
          </TabPanel>

          <TabPanel value="features" sx={panelSx}>
            {renderPanel(tabCards.features, 'features')}
          </TabPanel>

          <TabPanel value="generators" sx={panelSx}>
            {renderPanel(tabCards.generators, 'generators')}
          </TabPanel>

          <TabPanel value="integrations" sx={panelSx}>
            {renderPanel(tabCards.integrations, 'integrations')}
          </TabPanel>
        </Tabs>
      </Box>
    </PageFrame>
  );
};

export default GearsPage;
