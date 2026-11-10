import type { SettingKey } from '@bike4mind/common';
import { GROWTH_PRICING_SECTIONS } from './AdminGrowthPricingTab';
import type { InviteCenterSectionId } from './inviteCenterSearch';

/**
 * Settings edited on a dedicated admin page instead of Admin Settings. Admin Settings renders no
 * editor for any key here and links to its home instead, so no setting has two editors.
 * docs/pricing-settings-inventory.md records where each key is edited; update it when a key moves.
 */

export const SCHEDULE_KEYS = [
  'signupGrantInitialCredits',
  'signupGrantDailyCredits',
  'signupGrantDripCap',
  'signupGrantInviteBonusCredits',
  'signupGrantSignupPoolDaily',
  'signupGrantTricklePoolDaily',
] as const satisfies readonly SettingKey[];

export const FREE_TIER_LIMIT_KEYS = [
  'freeTierDailySpendCapCredits',
  'freeTierDay1SpendCapCredits',
  'freeTierDays2To7SpendCapCredits',
] as const satisfies readonly SettingKey[];

export const REWARD_KEYS = {
  referral: [
    'ReferralFirstAnswerCredits',
    'ReferralFirstPaymentCredits',
    'ReferralSecondPaymentCredits',
    'ReferralHoldDays',
    'ReferralInvitesPerUser',
    'ReferralAlertRewardsPerDay',
  ],
  gear: ['gearRewardMinAccountAgeDays'],
} as const satisfies Record<string, readonly SettingKey[]>;

export type SettingHomeId = 'growth-pricing' | 'invite-center-schedule' | 'invite-center-rewards';

export type SettingHome = {
  id: SettingHomeId;
  label: string;
  /** Completes "... edited on <label>." in the Admin Settings pointers. */
  summary: string;
  keys: readonly SettingKey[];
  /** Set for an Invite Center section; unset means the Growth and Pricing tab. */
  inviteSection?: InviteCenterSectionId;
};

export const SETTING_HOMES: readonly SettingHome[] = [
  {
    id: 'growth-pricing',
    label: 'Growth and Pricing',
    summary: 'Signup, starter credits, credit pricing, team-plan limits and the preference arena are edited on',
    keys: GROWTH_PRICING_SECTIONS.flatMap(section => section.keys),
  },
  {
    id: 'invite-center-schedule',
    label: 'Invite Center > Schedule',
    summary: 'The signup credit schedule, the signup and trickle pools and the free-tier spend caps are edited in',
    keys: [...SCHEDULE_KEYS, ...FREE_TIER_LIMIT_KEYS],
    inviteSection: 'schedule',
  },
  {
    id: 'invite-center-rewards',
    label: 'Invite Center > Rewards',
    summary: 'Referral rewards for inviters and gear rewards are edited in',
    keys: [...REWARD_KEYS.referral, ...REWARD_KEYS.gear],
    inviteSection: 'rewards',
  },
];

export const HOME_BY_KEY: ReadonlyMap<string, SettingHome> = new Map(
  SETTING_HOMES.flatMap(home => home.keys.map(key => [key, home] as const))
);
