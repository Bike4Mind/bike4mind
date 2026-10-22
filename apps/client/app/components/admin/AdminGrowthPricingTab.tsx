import { useMemo } from 'react';
import { Alert, Card, CardContent, Divider, LinearProgress, Stack, Typography } from '@mui/joy';
import WarningIcon from '@mui/icons-material/Warning';
import {
  creditsToUsdAtFloor,
  formatUsd,
  formatUsdPerCredit,
  MIN_PRICE_PER_CREDIT_USD,
  resolveTeamPlanSettings,
  settingsMap,
  type SettingKey,
} from '@bike4mind/common';
import { useSettingsFromServer } from '@client/app/hooks/data/settings';
import AdminSettingInputField from './AdminSettingInputField';

/**
 * The growth and monetization knobs, grouped on one page so they can be tuned without hunting
 * through Admin Settings. Storage is the ordinary admin-settings collection - every field here is
 * the same setting (and the same editor) that also appears under Admin Settings.
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
  const amount = typeof value === 'number' ? value : Number(value);
  const floor = `floor ${formatUsdPerCredit(MIN_PRICE_PER_CREDIT_USD)} per credit`;
  switch (key) {
    case 'defaultFreeCredits':
    case 'ReferralCreditsAmount':
      if (!Number.isFinite(amount)) return null;
      return `${amount.toLocaleString()} credits = ${formatUsd(creditsToUsdAtFloor(amount))} at the ${floor}`;
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

  const storedByKey = useMemo(() => {
    const map = new Map<string, unknown>();
    for (const row of data ?? []) map.set(row.settingName, row.settingValue);
    return map;
  }, [data]);

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
          Starter credits, signup, pricing and team-plan limits in one place. Changes apply without a deploy; server
          caches pick them up within a few minutes.
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
                    />
                  </div>
                );
              })}
            </Stack>
          </CardContent>
        </Card>
      ))}
    </Stack>
  );
};

export default AdminGrowthPricingTab;
