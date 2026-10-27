import type { IIntegrationHealthCheckDocument } from '@bike4mind/database';
import { recordAdminActionFromRequest } from '@server/utils/adminAudit';

type AuditRequest = Parameters<typeof recordAdminActionFromRequest>[0];
type ProbeResult = Pick<IIntegrationHealthCheckDocument, 'integration' | 'status'>;

const target = { kind: 'system', id: 'integration-health', displayName: 'Integration health' } as const;

/** Shared by the two integration-health admin routes (dashboard and system-health) so their audit entries match. */
export const recordIntegrationProbe = async (req: AuditRequest, result: ProbeResult | ProbeResult[]) => {
  if (Array.isArray(result)) {
    await recordAdminActionFromRequest(req, {
      action: 'system_health.integration_probe_run',
      target,
      summary: `probed all ${result.length} integrations`,
      details: { integrations: result.map(r => ({ integration: r.integration, status: r.status })) },
    });
    return;
  }
  await recordAdminActionFromRequest(req, {
    action: 'system_health.integration_probe_run',
    target,
    summary: `probed integration ${result.integration}`,
    details: { integration: result.integration, status: result.status },
  });
};
