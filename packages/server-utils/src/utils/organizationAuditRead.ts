import { z } from 'zod';
import { ORGANIZATION_AUDIT_ACTIONS, type OrganizationAuditEvent } from '@bike4mind/database/infra';

// Shared with the client's Audit tab gate (orgTabAccess.ts) so the two cannot drift.
export { canReadOrganizationAudit } from '@bike4mind/common';

const day = z.iso.date();
export const organizationAuditQuerySchema = z
  .object({
    id: z.string().min(1),
    actor: z.string().min(1).max(128).optional(),
    action: z.enum(ORGANIZATION_AUDIT_ACTIONS).optional(),
    from: day.optional(),
    to: day.optional(),
    format: z.enum(['json', 'csv']).default('json'),
    before: z
      .string()
      .regex(/^[a-f\d]{24}$/i)
      .optional(),
  })
  .refine(q => !q.from || !q.to || q.from <= q.to, { message: 'Invalid date range' });

export function organizationAuditFilter(query: z.infer<typeof organizationAuditQuerySchema>) {
  return {
    organizationId: query.id,
    ...(query.actor ? { actorUserId: query.actor } : {}),
    ...(query.action ? { action: query.action } : {}),
    ...(query.from || query.to
      ? {
          occurredAt: {
            ...(query.from ? { $gte: new Date(`${query.from}T00:00:00.000Z`) } : {}),
            ...(query.to ? { $lt: new Date(new Date(`${query.to}T00:00:00.000Z`).getTime() + 86400000) } : {}),
          },
        }
      : {}),
  };
}

const csvCell = (value: string) => `"${(/^[\s]*[=+@-]/.test(value) ? `'${value}` : value).replace(/"/g, '""')}"`;
export function organizationAuditCsv(events: OrganizationAuditEvent[]): string {
  return (
    [
      'Occurred at (UTC),Actor ID,Event,Target ID',
      ...events.map(event =>
        [new Date(event.occurredAt).toISOString(), event.actorUserId, event.action, event.targetId ?? '']
          .map(csvCell)
          .join(',')
      ),
    ].join('\r\n') + '\r\n'
  );
}
