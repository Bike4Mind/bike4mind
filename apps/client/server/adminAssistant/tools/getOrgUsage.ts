import { CreditHolderType, type IUsageSpendBucket } from '@bike4mind/common';
import { usageEventRepository } from '@bike4mind/database';
import { z } from 'zod';
import { resolveUserNames } from '../../utils/resolveUserNames';
import { defineAdminTool } from '../defineAdminTool';
import { resolveAdminOrgRef } from '../resolveAdminOrgRef';
import { AdminOrgRefFields, withExactlyOneOrgRef } from '../schemas';

const MAX_BREAKDOWN_ROWS = 10;

const GetOrgUsageInput = withExactlyOneOrgRef(
  AdminOrgRefFields.extend({
    days: z.number().int().min(1).max(90).default(30).describe('How many days back to look (1-90).'),
  })
);

// Picks the bucket's spend fields so no other field of a breakdown row rides along.
const spendOf = ({ requests, cogsUsd, creditsCharged }: IUsageSpendBucket): IUsageSpendBucket => ({
  requests,
  cogsUsd,
  creditsCharged,
});

export const getOrgUsageTool = defineAdminTool({
  name: 'admin_get_org_usage',
  description:
    "Read an organization's usage over the last N days, the same rollup as its usage dashboard: totals (requests, provider cost in USD, credits charged), spend per day, and the top members, models and features by spend.",
  input: GetOrgUsageInput,
  run: async ({ orgId, name, days }) => {
    const resolved = await resolveAdminOrgRef({ orgId, name });
    if (!resolved.ok) return resolved;
    const { org } = resolved;

    // Breakdowns arrive sorted by spend, descending.
    const summary = await usageEventRepository.ownerUsageSummary(org.id, CreditHolderType.Organization, days);
    const topMembers = summary.byMember.slice(0, MAX_BREAKDOWN_ROWS);
    const names = await resolveUserNames(topMembers.map(member => member.userId));

    return {
      ok: true,
      data: {
        organization: { id: org.id, name: org.name, currentCredits: org.currentCredits },
        days,
        totals: spendOf(summary.totals),
        overTime: summary.overTime.map(day => ({ day: day.day, ...spendOf(day) })),
        byMember: topMembers.map(member => ({
          userId: member.userId,
          name: names.get(member.userId) ?? null,
          ...spendOf(member),
        })),
        byModel: summary.byModel
          .slice(0, MAX_BREAKDOWN_ROWS)
          .map(model => ({ provider: model.provider, model: model.model, ...spendOf(model) })),
        byFeature: summary.byFeature
          .slice(0, MAX_BREAKDOWN_ROWS)
          .map(feature => ({ feature: feature.feature, ...spendOf(feature) })),
        truncated: {
          byMember: summary.byMember.length > MAX_BREAKDOWN_ROWS,
          byModel: summary.byModel.length > MAX_BREAKDOWN_ROWS,
          byFeature: summary.byFeature.length > MAX_BREAKDOWN_ROWS,
        },
      },
    };
  },
});
