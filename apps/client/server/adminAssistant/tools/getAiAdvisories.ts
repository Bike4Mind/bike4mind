import { z } from 'zod';
import { listAiAbuseAdvisories } from '@server/admin/aiAdvisory/aiAbuseAdvisories';
import { loadAbuseAssessmentSettings } from '@server/security/abuseAssessment/abuseAssessment';
import { AI_ADVISORY_WINDOW_HOURS } from '@client/app/utils/aiAdvisory';
import { defineAdminTool } from '../defineAdminTool';
import { toIso } from '../formatters';

const MAX_ADVISORIES = 25;
const MAX_GROUPS = 10;

const WHERE_TO_ENABLE =
  'Turn on "Advisory Abuse Assessment" and choose a model in Admin Settings > SecOps (abuseAssessmentEnabled, abuseAssessmentConfig.model).';

export const getAiAdvisoriesTool = defineAdminTool({
  name: 'admin_get_ai_advisories',
  description:
    'Accounts the AI judged as abuse on unreviewed shadow detections in the last 24 hours, plus the signup IPs and mail domains they share. Same data as the Dashboard AI advisory strip and the Users list AI filter; already-suspended accounts are excluded. Read-only. Returns status "off" when the AI abuse assessment is disabled or has no model.',
  input: z.object({}),
  run: async () => {
    const { enabled, config } = await loadAbuseAssessmentSettings();
    if (!enabled || config.model == null) {
      return {
        ok: true,
        data: {
          status: 'off' as const,
          reason: enabled ? ('no_model' as const) : ('disabled' as const),
          message: WHERE_TO_ENABLE,
        },
      };
    }

    const summary = await listAiAbuseAdvisories();
    return {
      ok: true,
      data: {
        status: 'on' as const,
        since: toIso(summary.since),
        windowHours: AI_ADVISORY_WINDOW_HOURS,
        advisoryCount: summary.advisories.length,
        // True when the summary hit its own cap, so the real count is higher than advisoryCount.
        countIsLowerBound: summary.truncated,
        advisories: summary.advisories.slice(0, MAX_ADVISORIES).map(a => ({
          userId: a.userId,
          verdict: 'abuse' as const,
          detector: a.detector,
          abuseProbability: a.abuseProbability,
          assessedAt: toIso(a.assessedAt),
        })),
        advisoriesTruncated: summary.advisories.length > MAX_ADVISORIES,
        networks: summary.networks.slice(0, MAX_GROUPS).map(n => ({
          ip: n.ip,
          country: n.country,
          asnOrg: n.asnOrg,
          hosting: n.hosting,
          accountCount: n.accountCount,
          detectorWouldBlock: n.detectorWouldBlock,
        })),
        networksTruncated: summary.networks.length > MAX_GROUPS,
        mailDomains: summary.mailDomains.slice(0, MAX_GROUPS).map(d => ({
          domain: d.domain,
          accountCount: d.accountCount,
        })),
        mailDomainsTruncated: summary.mailDomains.length > MAX_GROUPS,
      },
    };
  },
});
