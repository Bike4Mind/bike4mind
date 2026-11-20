import { creditsToUsdAtFloor, formatUsdAmount, formatUsdPerCredit } from '@bike4mind/common';

/**
 * Why the server would refuse this number, in the words the field shows. The setting's own
 * schema carries the same bounds (makeNumberSetting in @bike4mind/common), and the update
 * route parses with it directly, so an out-of-range value comes back as an untranslated
 * ZodError: without this the admin sees Save do nothing and is told nothing.
 *
 * Shared by the platform-value field (AdminSettingInputField) and the scoped-override add row
 * (ScopedSettingOverrides), which have the same bounds and must not describe them differently.
 */
export const rangeMessage = (value: number, min?: number, max?: number): string | undefined => {
  const inRange = (min === undefined || value >= min) && (max === undefined || value <= max);
  if (!Number.isNaN(value) && inRange) return undefined;
  if (min !== undefined && max !== undefined) return `Enter a number between ${min} and ${max}.`;
  if (min !== undefined) return `Enter a number of ${min} or more.`;
  if (max !== undefined) return `Enter a number of ${max} or less.`;
  return 'Enter a number.';
};

/** A setting value as an admin reads it: a boolean as on/off, and an absent or cleared one as "unset". */
export const describeSettingValue = (value: unknown): string => {
  if (value === null || value === undefined || value === '') return 'unset';
  if (typeof value === 'boolean') return value ? 'on' : 'off';
  return String(value);
};

/**
 * A `changesCustomerPrice` value with its USD equivalent, where the setting has one. Credit amounts
 * are valued at MIN_PRICE_PER_CREDIT_USD, the rate credit packs sell at, matching
 * describeDerivedValue on the Growth and Pricing tab. Seat counts and switches have no single
 * dollar figure and read as plain values.
 */
export const describeMoneyValue = (key: string, value: unknown): string => {
  const plain = describeSettingValue(value);
  // Unset is not zero: Number('') and Number(null) would both read as $0.
  const amount = value === undefined || value === null || value === '' ? Number.NaN : Number(value);
  if (!Number.isFinite(amount)) return plain;
  const atFloor = (per: string) => `${formatUsdAmount(creditsToUsdAtFloor(amount))} ${per} at the floor credit price`;
  switch (key) {
    case 'pricePerCredit':
      return `${plain} (${formatUsdPerCredit(amount)} per credit)`;
    case 'teamPlanCreditsPerSeat':
      return `${plain} (${atFloor('per seat')})`;
    case 'SimulatorComputeCreditsPerRound':
      return `${plain} (${atFloor('per round')})`;
    case 'HardwareComputeCreditsPerUsd':
      return `${plain} (${atFloor('per $1 of hardware cost')})`;
    default:
      return plain;
  }
};

/**
 * The before-and-after line for a `changesCustomerPrice` setting (BaseSetting in @bike4mind/common).
 * Shared so both save paths read identically: the per-field confirm in AdminSettingInputField
 * (unstaged, no SettingsDraftProvider) and the batched SaveBar warning (staged).
 */
export const moneyChangeWarning = (key: string, name: string, before: unknown, after: unknown): string =>
  `${name} changes what customers pay: ${describeMoneyValue(key, before)} to ${describeMoneyValue(key, after)}.`;
