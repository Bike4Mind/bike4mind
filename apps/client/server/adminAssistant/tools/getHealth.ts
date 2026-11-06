import { getHealthSummary } from '@bike4mind/server-utils/services/integrationHealthService';
import { z } from 'zod';
import { getSystemHealthStatus } from '@server/admin/systemHealth/getSystemHealthStatus';
import { defineAdminTool } from '../defineAdminTool';
import { toIso } from '../formatters';

export const getHealthTool = defineAdminTool({
  name: 'admin_get_health',
  description:
    "Read platform health, the same data as the System Health and Integration Health tabs: database connection state, whether email and OAuth (Google, GitHub, Okta) are configured and which secret names are missing, and each integration's last stored health check (status, latency, success rate, consecutive failures). Reads stored results only; runs no live probe.",
  input: z.object({}),
  run: async (_args, context) => {
    const [system, integrations] = await Promise.all([getSystemHealthStatus(), getHealthSummary(context.logger)]);

    return {
      ok: true,
      data: {
        ...system,
        integrations: integrations.map(summary => ({
          ...summary,
          // getHealthSummary reports the epoch when an integration has never been checked.
          lastCheckedAt: summary.lastCheckedAt.getTime() === 0 ? null : toIso(summary.lastCheckedAt),
        })),
      },
    };
  },
});
