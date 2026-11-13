import { z } from 'zod';
import { listAiAbuseAdvisories } from '@bike4mind/server-utils/admin/aiAdvisory/aiAbuseAdvisories';
import { loadAbuseAssessmentSettings } from '@bike4mind/server-utils/security/abuseAssessment/abuseAssessment';
import { AI_ADVISORY_WINDOW_HOURS } from '@bike4mind/server-utils/app/utils/aiAdvisory';
import { defineAdminTool } from '../defineAdminTool';
import { toIso } from '../formatters';

const MAX_ADVISORIES = 25;
const MAX_GROUPS = 10;

const WHERE_TO_ENABLE =
  'Turn on "Advisory Abuse Assessment" and choose a model in Admin Settings > SecOps (abuseAssessmentEnabled, abuseAssessmentConfig.model).';

export const getAiAdvisoriesTool = defineAdminTool({
  name: 'admin_get_ai_advisories',
  description:
    'Accounts the AI judged as abuse on unreviewed shadow detections in the last 24 hours, plus the signup IPs and mail domains they share. Same data as the Dashboard AI advisory strip and the Users list AI filter; already-suspended accounts are excluded. Read-only. Returns assessment status "off" and setup guidance when disabled or missing a model, alongside any existing advisories.',
  input: z.object({}),
  run: async () => {
    const { enabled, config } = await loadAbuseAssessmentSettings();
    const assessmentStatus =
      !enabled || config.model == null
        ? {
            status: 'off' as const,
            reason: enabled ? ('no_model' as const) : ('disabled' as const),
            message: `AI abuse assessment is off. Existing judgments from the advisory window are still included. ${WHERE_TO_ENABLE}`,
          }
        : { status: 'on' as const };

    const summary = await listAiAbuseAdvisories();
    return {
      ok: true,
      data: {
        ...assessmentStatus,
        since: toIso(summary.since),
        windowHours: AI_ADVISORY_WINDOW_HOURS,
        advisoryCount: summary.advisories.length,
        // True when the summary hit its own cap, so the real count is higher than advisoryCount.
        countIsLowerBound: summary.truncated,
        advisories: summary.advisories.slice(0, MAX_ADVISORIES).map(a => ({
          userId: a.userId,
          detectionId: a.detectionId,
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
