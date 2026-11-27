import { SPEND_AUTO_PAUSE_MODES, settingsMap, type SpendAutoPauseMode } from '@bike4mind/common';
import { adminSettingsRepository, spendAlertRepository, spendRollupRepository } from '@bike4mind/database';
import { getSettingsMap, getSettingsValue } from '@bike4mind/utils';
import { asyncHandler } from '@server/middlewares/asyncHandler';
import { adminApi } from '@server/middlewares/adminApi';
import {
  labelIncidents,
  platformWindowEnd,
  sortIncidents,
  type SpendMonitorOverview,
} from '@server/utils/spendMonitorAdmin';

const HOUR_MS = 60 * 60 * 1000;

const SETTING_NAMES = [
  'spendMonitorAutoPauseMode',
  'spendMonitorAutoPauseStandardMinCredits',
  'spendMonitorAutoPausePaidMinCredits',
  'spendMonitorAutoPauseTrustedMinCredits',
] as const;
type AutoPauseSettingName = (typeof SETTING_NAMES)[number];

const DEFAULT_MODE = settingsMap.spendMonitorAutoPauseMode.defaultValue as SpendAutoPauseMode;

// The setting's schema only stores known modes; the guard narrows the string type it reads as.
const toAutoPauseMode = (value: string): SpendAutoPauseMode =>
  SPEND_AUTO_PAUSE_MODES.find(mode => mode === value) ?? DEFAULT_MODE;

const readCredits = (
  name: Exclude<AutoPauseSettingName, 'spendMonitorAutoPauseMode'>,
  settings: Record<string, string>
): number => getSettingsValue(name, settings, settingsMap[name].defaultValue ?? 0);

// GET: open spend incidents, platform credit totals and the automatic pause settings, for the Spend monitor tab.
const handler = adminApi({ auth: 'jwtOnly', adminPermissions: { GET: 'support:read' } }).get(
  asyncHandler(async (_req, res) => {
    const now = new Date();
    const [incidents, latestBucketStart, settings] = await Promise.all([
      spendAlertRepository.findActive(),
      spendRollupRepository.latestBucketStart(),
      getSettingsMap({ adminSettings: adminSettingsRepository }, { names: [...SETTING_NAMES] }),
    ]);

    const to = platformWindowEnd(latestBucketStart, now);
    const [lastHour, last24Hours] = await Promise.all([
      spendRollupRepository.sumWindow('platform', new Date(to.getTime() - HOUR_MS), to),
      spendRollupRepository.sumWindow('platform', new Date(to.getTime() - 24 * HOUR_MS), to),
    ]);

    const overview: SpendMonitorOverview = {
      incidents: await labelIncidents(sortIncidents(incidents)),
      platform: {
        lastHourCredits: lastHour.get('all')?.credits ?? 0,
        last24hCredits: last24Hours.get('all')?.credits ?? 0,
        latestBucketStart: latestBucketStart?.toISOString() ?? null,
      },
      autoPause: {
        mode: toAutoPauseMode(getSettingsValue('spendMonitorAutoPauseMode', settings, DEFAULT_MODE)),
        minCreditsByTier: {
          standard: readCredits('spendMonitorAutoPauseStandardMinCredits', settings),
          paid: readCredits('spendMonitorAutoPausePaidMinCredits', settings),
          trusted: readCredits('spendMonitorAutoPauseTrustedMinCredits', settings),
        },
      },
    };
    return res.json(overview);
  })
);

export const config = {
  api: {
    externalResolver: true,
  },
};

export default handler;
