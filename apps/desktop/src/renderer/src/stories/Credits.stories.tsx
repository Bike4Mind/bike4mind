import type { Story, StoryDefault } from './ladleTypes';
import Avatar from '@mui/joy/Avatar';
import Button from '@mui/joy/Button';
import Divider from '@mui/joy/Divider';
import Sheet from '@mui/joy/Sheet';
import Stack from '@mui/joy/Stack';
import Typography from '@mui/joy/Typography';
import type { AccountProfile, CreditExpiry } from '@shared/account';
import { CreditsMenuHeader } from '../credits/CreditsGlance';
import { CreditsOrbFace } from '../credits/CreditsOrb';
import { creditsOrbState } from '../credits/creditsOrbState';
import { creditOutlook, DAY_MS, nextRefillAt } from '../credits/creditOutlook';
import type { CreditsGlance } from '../credits/useCreditsGlance';

export default { title: 'Credits' } satisfies StoryDefault;

const NOW = Date.parse('2026-11-24T12:00:00Z');

function glance(
  balance: number,
  burnPerDay: number,
  refillInDays: number | null,
  tier: AccountProfile['tier'] = 'pro',
  expiring: CreditExpiry[] | undefined = undefined
): CreditsGlance {
  const plan =
    refillInDays === null
      ? null
      : {
          name: 'Pro',
          interval: 'monthly' as const,
          currentPeriodEndsAt: new Date(NOW + refillInDays * DAY_MS).toISOString(),
        };
  const profile: AccountProfile = {
    credits: { balance, monthlyAllowance: plan ? 10_000 : null, ...(expiring ? { expiring } : {}) },
    plan,
    tier,
  };
  return {
    profile,
    organization: null,
    burnPerDay,
    readAt: NOW,
    outlook: creditOutlook({
      balance,
      burnPerDay,
      refillAt: nextRefillAt(plan, profile.credits.monthlyAllowance, NOW),
      expiring,
      now: NOW,
    }),
  };
}

function organizationGlance(credits: number): CreditsGlance {
  return {
    ...glance(820, 45, 7),
    organization: { id: 'org-1', name: 'Acme', personal: false, credits },
    burnPerDay: null,
    outlook: creditOutlook({ balance: credits, burnPerDay: 0, refillAt: null, expiring: undefined, now: NOW }),
  };
}

const CASES: { title: string; glance: CreditsGlance }[] = [
  { title: 'Banked balance', glance: glance(312_480, 2100, 7) },
  {
    title: 'Banked, expiry known',
    glance: glance(312_480, 2100, 7, 'pro', [
      { amount: 40_000, expiresAt: NOW + 50 * DAY_MS },
      { amount: 200_000, expiresAt: NOW + 300 * DAY_MS },
    ]),
  },
  {
    title: 'Grant expiring before the refill',
    glance: glance(2000, 100, 7, 'pro', [{ amount: 1800, expiresAt: NOW + 3 * DAY_MS }]),
  },
  { title: 'Covered to the refill', glance: glance(6200, 260, 7) },
  { title: 'Short of the refill', glance: glance(1400, 310, 7) },
  { title: 'Almost out', glance: glance(180, 300, 7) },
  { title: 'Free plan', glance: glance(820, 45, null, 'free') },
  { title: 'No recent spend', glance: glance(820, 0, 7) },
  { title: 'Paid by an organization', glance: organizationGlance(48_200) },
  { title: 'Organization pool empty', glance: organizationGlance(0) },
];

/** The strip's avatar and the open menu's top rows, as the account strip draws them. */
function MenuPreview({ value }: { value: CreditsGlance }) {
  return (
    <Sheet variant="outlined" sx={{ width: 260, borderRadius: 'md', p: 1, display: 'grid', gap: 0.5 }}>
      <CreditsMenuHeader glance={value} onTopUp={() => {}} />
      {['Profile', 'Billing', 'Settings'].map(label => (
        <Button
          key={label}
          size="sm"
          variant="plain"
          color="neutral"
          sx={{ justifyContent: 'flex-start', fontWeight: 'md' }}
        >
          {label}
        </Button>
      ))}
      <Divider sx={{ my: 0.5 }} />
      <Stack direction="row" spacing={1} alignItems="center" sx={{ px: 1, py: 0.5 }}>
        <CreditsOrbFace tone={creditsOrbState(value).tone} compact={creditsOrbState(value).compact} />
        <Avatar size="sm" variant="soft" color="primary">
          NO
        </Avatar>
        <Typography level="body-sm">Rail foot</Typography>
      </Stack>
    </Sheet>
  );
}

export const MenuHeader: Story = () => (
  <Stack direction="row" spacing={2} useFlexGap flexWrap="wrap" sx={{ p: 2 }}>
    {CASES.map(item => (
      <Stack key={item.title} spacing={0.75}>
        <Typography level="body-xs" textColor="text.tertiary">
          {item.title}
        </Typography>
        <MenuPreview value={item.glance} />
      </Stack>
    ))}
  </Stack>
);
