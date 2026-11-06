import { getStatus } from '@bike4mind/server-utils/services/integrationCircuitBreaker';
import { getHealthSummary } from '@bike4mind/server-utils/services/integrationHealthService';
import { z } from 'zod';
import { getSystemHealthStatus } from '@server/admin/systemHealth/getSystemHealthStatus';
import { defineAdminTool } from '../defineAdminTool';
import { toIso } from '../formatters';

export const getHealthTool = defineAdminTool({
  name: 'admin_get_health',
  description:
    "Read platform health, the same data as the System Health and Integration Health tabs: database connection state, whether email and OAuth (Google, GitHub, Okta) are configured and which secret names are missing, and each integration's last stored health check (status, latency, success rate, consecutive failures) with its circuit breaker state. Reads stored results only; runs no live probe.",
  input: z.object({}),
  run: async (_args, context) => {
    const [system, summaries] = await Promise.all([getSystemHealthStatus(), getHealthSummary(context.logger)]);
    // Same per-integration breaker read as the Integration Health route; it only fills an in-process cache.
    const integrations = await Promise.all(
      summaries.map(async summary => {
        // getHealthSummary reports the epoch (and status 'unhealthy') when an integration has never been checked.
        const neverChecked = summary.lastCheckedAt.getTime() === 0;
        return {
          ...summary,
          lastCheckedAt: neverChecked ? null : toIso(summary.lastCheckedAt),
          neverChecked,
          circuitBreaker: await getStatus(summary.integration),
        };
      })
    );

    return { ok: true, data: { ...system, integrations } };
  },
});
