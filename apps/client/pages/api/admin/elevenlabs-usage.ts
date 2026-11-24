import { adminApi } from '@server/middlewares/adminApi';
import { adminSettingsRepository, usageEventRepository, userRepository } from '@bike4mind/database';
import { getSettingsMap, getSettingsValue } from '@bike4mind/utils';
import {
  ApiKeyScope,
  settingsMap,
  ELEVENLABS_DEFAULT_DURATION_SECONDS,
  ELEVENLABS_MAX_CYCLES_BACK,
  elevenLabsBillingCycle,
  summarizeElevenLabsPlanUsage,
  type ElevenLabsPlanUsage,
} from '@bike4mind/common';
import { BadRequestError } from '@bike4mind/server-utils/utils/errors';

const PLAN_SETTINGS = [
  'elevenLabsPlanCycleStartDay',
  'elevenLabsPlanMonthlyCredits',
  'elevenLabsPlanAgentMinutes',
] as const;
type PlanSetting = (typeof PLAN_SETTINGS)[number];

const planSetting = (key: PlanSetting, settings: Record<string, string>): number => {
  const value = getSettingsValue(key, settings) ?? settingsMap[key].defaultValue;
  if (value === undefined) throw new Error(`Setting ${key} has no value and no default`);
  return value;
};

const parseCyclesBack = (raw: unknown): number => {
  if (raw === undefined) return 0;
  const cyclesBack = Number(raw);
  if (!Number.isInteger(cyclesBack) || cyclesBack < 0 || cyclesBack > ELEVENLABS_MAX_CYCLES_BACK) {
    throw new BadRequestError(`cyclesBack must be an integer between 0 and ${ELEVENLABS_MAX_CYCLES_BACK}`);
  }
  return cyclesBack;
};

/**
 * ElevenLabs plan consumption for one billing cycle, in the vendor's own credits, against the allowance set in the
 * elevenLabsPlan* admin settings. GET ?cyclesBack=0 (the current cycle; 1 is the previous one, and so on).
 * Credits are estimates from our usage records; see b4m-core/common/src/elevenLabsPlanUsage.ts for the rates.
 *
 * Gated by support:read; session-only (jwtOnly), like revenue.ts.
 */
const handler = adminApi({
  adminPermissions: { GET: 'support:read' },
  auth: 'jwtOnly',
  requiredScopes: [ApiKeyScope.ADMIN],
}).get(async (req, res) => {
  const cyclesBack = parseCyclesBack(req.query.cyclesBack);

  const settings = await getSettingsMap({ adminSettings: adminSettingsRepository }, { names: [...PLAN_SETTINGS] });
  const startDay = planSetting('elevenLabsPlanCycleStartDay', settings);
  const cycle = elevenLabsBillingCycle(new Date(), startDay, cyclesBack);

  const rows = await usageEventRepository.providerUnitsBreakdown({
    provider: 'elevenlabs',
    ...cycle,
    defaultUnits: ELEVENLABS_DEFAULT_DURATION_SECONDS,
  });
  const summary = summarizeElevenLabsPlanUsage(rows, {
    cycle,
    startDay,
    monthlyCredits: planSetting('elevenLabsPlanMonthlyCredits', settings),
    agentMinutes: planSetting('elevenLabsPlanAgentMinutes', settings),
  });

  const users = await userRepository.findByIds(summary.byUser.map(u => u.userId));
  const labelById = new Map(users.map(u => [String(u.id), u.name || u.username || u.email]));
  const body: ElevenLabsPlanUsage = {
    ...summary,
    byUser: summary.byUser.map(u => ({ ...u, userLabel: labelById.get(u.userId) ?? u.userId })),
  };
  return res.json(body);
});

export default handler;
