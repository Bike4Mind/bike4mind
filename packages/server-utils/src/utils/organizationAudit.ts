import { z } from 'zod';
import { Logger } from '@bike4mind/observability';
import {
  ORGANIZATION_AUDIT_ACTIONS,
  OrganizationAuditEventModel,
  type OrganizationAuditAction,
} from '@bike4mind/database/infra';

export const organizationAuditInputSchema = z
  .object({
    organizationId: z.string().min(1).max(128),
    actorUserId: z.string().min(1).max(128),
    action: z.enum(ORGANIZATION_AUDIT_ACTIONS),
    targetId: z.string().min(1).max(128).optional(),
  })
  .strict();

export type RecordOrganizationAuditEventInput = z.infer<typeof organizationAuditInputSchema>;

/** Await inside the mutation's transaction. Only org-visible IDs and fixed action names belong here. */
export async function recordOrganizationAuditEvent(input: RecordOrganizationAuditEventInput): Promise<void> {
  const event = organizationAuditInputSchema.parse(input);
  await OrganizationAuditEventModel.create({ ...event, occurredAt: new Date() });
}

/** For mutations that have already committed and cannot roll back on an audit failure. */
export async function recordOrganizationAuditEventSafe(input: RecordOrganizationAuditEventInput): Promise<void> {
  try {
    await recordOrganizationAuditEvent(input);
  } catch (error) {
    Logger.error('[ORGANIZATION_AUDIT_WRITE_FAILED]', { action: input.action, error });
  }
}

// Deliberately not a prefix match: new platform actions must never become customer-visible implicitly.
export const organizationLifecycleAuditActions: Readonly<Record<string, OrganizationAuditAction>> = {
  'org.admins.updated': 'member.role_changed',
  'org.owner.transferred': 'owner.transferred',
  'org.invite.created': 'invite.created',
  'org.member_budget.updated': 'policy.updated',
  'org.custom_mcp_policy.updated': 'policy.updated',
  'org.model_policy.updated': 'policy.updated',
  'org.slack_channel_api_posting.updated': 'policy.updated',
};
