import { settingsMap } from '@bike4mind/common';
import { adminSettingsRepository } from '@bike4mind/database';
import { Resource } from 'sst';

export type SignupDripPeriod = { day: string; key?: string; endsAt: number };

/** Test windows never change the real UTC day used by the shared payout budget. */
export async function resolveSignupDripPeriod(
  now: Date,
  stage: string = Resource.App.stage
): Promise<SignupDripPeriod> {
  const day = now.toISOString().slice(0, 10);
  const daily = { day, endsAt: new Date(`${day}T00:00:00.000Z`).getTime() + 86_400_000 };
  if (!/^pr\d+$/.test(stage)) return daily;

  const setting = await adminSettingsRepository.findBySettingName('signupGrantActivityPreviewTestMode');
  const parsed = settingsMap.signupGrantActivityPreviewTestMode.schema.safeParse(setting?.settingValue);
  if (!parsed.success || !parsed.data) return daily;

  const windowMs = 5 * 60_000;
  const window = Math.floor(now.getTime() / windowMs);
  return { day, key: `preview:5:${window}`, endsAt: (window + 1) * windowMs };
}
