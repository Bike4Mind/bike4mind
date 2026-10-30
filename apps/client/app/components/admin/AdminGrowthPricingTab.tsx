import { useMemo } from 'react';
import { Alert, Card, CardContent, Divider, LinearProgress, Link, Stack, Typography } from '@mui/joy';
import WarningIcon from '@mui/icons-material/Warning';
import OpenInNewIcon from '@mui/icons-material/OpenInNew';
import { useNavigate } from '@tanstack/react-router';
import {
  API_SERVICE_GROUPS,
  creditsToUsdAtFloor,
  formatUsdAmount,
  formatUsdPerCredit,
  isEnforceCreditsLocked,
  MIN_PRICE_PER_CREDIT_USD,
  resolveTeamPlanSettings,
  SETTING_TABS,
  settingsMap,
  type SettingKey,
} from '@bike4mind/common';
import { useSettingsFromServer } from '@client/app/hooks/data/settings';
import AdminSettingInputField from './AdminSettingInputField';
import { CheckoutCatalogPanel } from './CheckoutCatalogPanel';
import { AdminTab } from './adminSidebarConfig';
import {
  ADMIN_SETTINGS_SEARCH_PARAM,
  ADMIN_SETTINGS_SECTION_PARAM,
  ADMIN_SETTINGS_TAB_SLUG,
  adminSearchForTab,
  type AdminSearch,
} from './adminTabParams';
import { useAdminModal } from './useAdminModal';
import { useCreditAnalysisStore } from './CreditAnalysis/store';

/**
 * The growth and monetization knobs, grouped on one page so they can be tuned without hunting
 * through Admin Settings. Storage is the ordinary admin-settings collection. This tab is the only
 * editor for these keys (GROWTH_PRICING_ONLY_KEYS in AdminSettingsTab, whose Credits System group
 * links here), except ReferralCreditsAmount, which keeps a second editor under Referrals.
 * docs/pricing-settings-inventory.md lists every key in this area; update it when a key moves.
 */
export const GROWTH_PRICING_SECTIONS: ReadonlyArray<{
  id: string;
  title: string;
  description: string;
  keys: readonly SettingKey[];
}> = [
  {
    id: 'signup',
    title: 'Signup and starter credits',
    description: 'Who can sign up on their own, and what a new user starts with.',
    keys: ['allowOpenRegistration', 'defaultFreeCredits', 'ReferralCreditsAmount'],
  },
  {
    id: 'referral-rewards',
    title: 'Referral rewards for inviters',
    description:
      'What an inviter earns when an invited friend becomes active or subscribes, plus the hold, starting-invite and alert settings. The starting-invite count, first-answer reward and alert are active today; the payment rewards and hold are saved but not paid out until payment rewards ship.',
    keys: [
      'ReferralFirstAnswerCredits',
      'ReferralFirstPaymentCredits',
      'ReferralSecondPaymentCredits',
      'ReferralHoldDays',
      'ReferralInvitesPerUser',
      'ReferralAlertRewardsPerDay',
    ],
  },
  {
    id: 'credits',
    title: 'Credits and pricing',
    description: 'How usage is metered and what credits cost.',
    keys: ['enforceCredits', 'pricePerCredit', 'lowCreditsThreshold'],
  },
  {
    id: 'team',
    title: 'Team plan',
    description: 'Seat limits and the credits each paid seat adds to a team pool.',
    keys: ['enableTeamPlan', 'teamPlanMinSeats', 'teamPlanMaxSeats', 'teamPlanCreditsPerSeat'],
  },
];

/** The settings in the tier rate-limit group, read from the group tags so a new tier is picked up. */
export const RATE_LIMIT_SETTING_KEYS = (Object.keys(settingsMap) as SettingKey[]).filter(
  key =>
    (settingsMap[key] as { group?: string }).group === API_SERVICE_GROUPS.RATE_LIMITING.id &&
    key.startsWith('apiRateLimit')
);

// Admin Settings search term that narrows the list to the rate-limit group; it matches on setting
// keys, so it must stay a substring of every key in RATE_LIMIT_SETTING_KEYS (tested).
export const RATE_LIMIT_SETTINGS_SEARCH = 'apiRateLimit';

// The Admin Settings section whose categories hold the rate-limit group.
const RATE_LIMIT_SETTINGS_SECTION_ID = Object.values(SETTING_TABS).find(section =>
  RATE_LIMIT_SETTING_KEYS.some(key => {
    const { category } = settingsMap[key];
    return category !== undefined && section.categories.includes(category);
  })
)?.id;

/**
 * Pricing and limit controls that already have an editor elsewhere. They are linked rather than
 * rendered here so no setting has two editors.
 */
export const GROWTH_PRICING_LINKS = [
  {
    id: 'model-pricing',
    title: 'Model pricing',
    description: 'Per-model token rates that turn usage into credits. Edited in the Credit Analytics pricing catalog.',
    linkLabel: 'Open the model pricing catalog',
  },
  {
    id: 'rate-limits',
    title: 'Tier rate limits',
    description: 'Per-minute request limits for each subscription tier. Edited in Admin Settings.',
    linkLabel: `Open ${API_SERVICE_GROUPS.RATE_LIMITING.name} settings`,
  },
] as const;

type GrowthPricingLinkId = (typeof GROWTH_PRICING_LINKS)[number]['id'];

const formatValue = (value: unknown): string => {
  if (value === undefined || value === null || value === '') return 'not set';
  if (typeof value === 'number') return value.toLocaleString();
  return String(value);
};

/**
 * Unit and derived value shown under a setting's current value, so a bare number reads as money.
 * Credit grants are valued at the floor rate because that is what credit packs sell at
 * (apps/client/lib/credits/constants.ts).
 */
export const describeDerivedValue = (key: SettingKey, value: unknown): string | null => {
  // Unset is not zero: Number('') and Number(null) would both read as 0 credits.
  const amount = value === undefined || value === null || value === '' ? Number.NaN : Number(value);
  const floor = `floor ${formatUsdPerCredit(MIN_PRICE_PER_CREDIT_USD)} per credit`;
  switch (key) {
    case 'defaultFreeCredits':
    case 'ReferralCreditsAmount':
    case 'ReferralFirstAnswerCredits':
    case 'ReferralFirstPaymentCredits':
    case 'ReferralSecondPaymentCredits':
      if (!Number.isFinite(amount)) return null;
      return `${amount.toLocaleString('en-US')} credits = ${formatUsdAmount(creditsToUsdAtFloor(amount))} at the ${floor}`;
    case 'pricePerCredit':
      return Number.isFinite(amount)
        ? `${formatUsdPerCredit(amount)} per credit (USD) - ${floor}`
        : `USD per credit - ${floor}`;
    default:
      return null;
  }
};

const AdminGrowthPricingTab = () => {
  const { data, isLoading } = useSettingsFromServer();
  const navigate = useNavigate();
  const setAdminTab = useAdminModal(state => state.setActiveTab);
  const setCreditAnalysisTab = useCreditAnalysisStore(state => state.setActiveTab);

  // Already inside /admin, so each link is an in-console navigation, as in ModelLifecycleTab.
  const openLink: Record<GrowthPricingLinkId, () => void> = {
    'model-pricing': () => {
      setCreditAnalysisTab('pricing');
      setAdminTab(AdminTab.CreditAnalytics);
    },
    // Navigate with the tab slug instead of setting the store: the store-to-URL mirror would
    // rebuild the search and drop the section and filter (see useAdminTabUrlSync).
    'rate-limits': () =>
      navigate({
        to: '/admin',
        search: (previous: AdminSearch) => ({
          ...adminSearchForTab(previous, ADMIN_SETTINGS_TAB_SLUG),
          [ADMIN_SETTINGS_SECTION_PARAM]: RATE_LIMIT_SETTINGS_SECTION_ID,
          [ADMIN_SETTINGS_SEARCH_PARAM]: RATE_LIMIT_SETTINGS_SEARCH,
        }),
        replace: true,
      }),
  };

  const storedByKey = useMemo(() => {
    const map = new Map<string, unknown>();
    for (const row of data ?? []) map.set(row.settingName, row.settingValue);
    return map;
  }, [data]);

  // No data after loading means the read failed; the catalog says so rather than showing defaults.
  const teamPlan = useMemo(
    () =>
      data
        ? resolveTeamPlanSettings({
            teamPlanMinSeats: storedByKey.get('teamPlanMinSeats'),
            teamPlanMaxSeats: storedByKey.get('teamPlanMaxSeats'),
            teamPlanCreditsPerSeat: storedByKey.get('teamPlanCreditsPerSeat'),
          })
        : undefined,
    [data, storedByKey]
  );

  // Cross-field checks the per-setting schemas cannot express on their own.
  const warnings = useMemo(() => {
    const out: string[] = [];
    const rawMin = storedByKey.get('teamPlanMinSeats');
    const rawMax = storedByKey.get('teamPlanMaxSeats');
    const resolved = resolveTeamPlanSettings({ teamPlanMinSeats: rawMin, teamPlanMaxSeats: rawMax });
    const requestedMin = rawMin === undefined ? undefined : Number(rawMin);
    if (requestedMin !== undefined && requestedMin > resolved.maxSeats) {
      out.push(
        `Team Plan Minimum Seats (${requestedMin}) is above the maximum (${resolved.maxSeats}); the maximum is used as the minimum until this is fixed.`
      );
    }
    const openRegistration = settingsMap.allowOpenRegistration.schema.safeParse(
      storedByKey.get('allowOpenRegistration')
    );
    const freeCredits = settingsMap.defaultFreeCredits.schema.safeParse(storedByKey.get('defaultFreeCredits'));
    if (openRegistration.success && !openRegistration.data && freeCredits.success && freeCredits.data > 0) {
      out.push(
        'Default Free Credits only applies to self-serve signups, so it has no effect while Allow Open Registration is off.'
      );
    }
    return out;
  }, [storedByKey]);

  if (isLoading) return <LinearProgress data-testid="admin-growth-pricing-loading" />;

  return (
    <Stack spacing={2} sx={{ p: 2, maxWidth: 1100 }} data-testid="admin-growth-pricing-tab">
      <div>
        <Typography level="h3">Growth and Pricing</Typography>
        <Typography level="body-sm" sx={{ color: 'text.secondary' }}>
          Starter credits, signup, pricing, team-plan and rate limits in one place. Changes apply without a deploy;
          server caches pick them up within a few minutes.
        </Typography>
      </div>

      {warnings.map(warning => (
        <Alert
          key={warning}
          color="warning"
          variant="soft"
          startDecorator={<WarningIcon />}
          data-testid="admin-growth-pricing-warning"
        >
          {warning}
        </Alert>
      ))}

      {GROWTH_PRICING_SECTIONS.map(section => (
        <Card key={section.id} variant="outlined" data-testid={`admin-growth-pricing-section-${section.id}`}>
          <Typography level="title-lg">{section.title}</Typography>
          <Typography level="body-sm" sx={{ color: 'text.secondary' }}>
            {section.description}
          </Typography>
          <Divider inset="none" />
          <CardContent>
            <Stack spacing={1}>
              {section.keys.map((key, index) => {
                const setting = settingsMap[key];
                const stored = storedByKey.get(key);
                const current = stored ?? setting.defaultValue;
                const derived = describeDerivedValue(key, current);
                return (
                  <div key={key}>
                    <Typography
                      level="body-xs"
                      sx={{ color: 'text.tertiary', mb: 0.5 }}
                      data-testid={`admin-growth-pricing-current-${key}`}
                    >
                      Current: {formatValue(current)}
                      {stored === undefined ? ' (default)' : ` - default ${formatValue(setting.defaultValue)}`}
                    </Typography>
                    {derived && (
                      <Typography
                        level="body-xs"
                        sx={{ color: 'text.tertiary', mb: 0.5 }}
                        data-testid={`admin-growth-pricing-derived-${key}`}
                      >
                        {derived}
                      </Typography>
                    )}
                    <AdminSettingInputField
                      // Remount when the stored value changes so the editor never shows a stale draft.
                      key={`${key}-${JSON.stringify(stored ?? null)}`}
                      index={index}
                      setting={setting}
                      defaultValue={current}
                      lockedNote={
                        key === 'enforceCredits' && isEnforceCreditsLocked()
                          ? 'Always on for hosted deployments'
                          : undefined
                      }
                    />
                  </div>
                );
              })}
            </Stack>
          </CardContent>
        </Card>
      ))}

      <CheckoutCatalogPanel teamPlan={teamPlan} />

      {GROWTH_PRICING_LINKS.map(section => (
        <Card key={section.id} variant="outlined" data-testid={`admin-growth-pricing-section-${section.id}`}>
          <Typography level="title-lg">{section.title}</Typography>
          <Typography level="body-sm" sx={{ color: 'text.secondary' }}>
            {section.description}
          </Typography>
          <Divider inset="none" />
          <CardContent>
            {/* component="button": a Joy Link with only an onClick renders an <a> with no href,
                which is not focusable. */}
            <Link
              level="body-sm"
              component="button"
              startDecorator={<OpenInNewIcon sx={{ fontSize: 14 }} />}
              onClick={openLink[section.id]}
              sx={{ alignSelf: 'flex-start' }}
              data-testid={`admin-growth-pricing-link-${section.id}`}
            >
              {section.linkLabel}
            </Link>
          </CardContent>
        </Card>
      ))}
    </Stack>
  );
};

export default AdminGrowthPricingTab;
