import type { AuditChange, AuditTarget } from '@bike4mind/common';
import { User } from '@bike4mind/database';
import { adminAuditService } from '@bike4mind/services';
import { recordAdminActionFromRequest } from '@server/utils/adminAudit';

type AuditRequest = Parameters<typeof recordAdminActionFromRequest>[0];

// Fields with their own audit action (role, credits, suspension, restriction, restricted tier) or that are
// request-only and never stored.
const EXCLUDED_FIELDS = new Set([
  'id',
  'isAdmin',
  'roleChangeReason',
  'currentCredits',
  'creditDelta',
  'creditReason',
  'isBanned',
  'isModerated',
  'statusChangeReason',
  'throttleTier',
  'throttleReason',
]);
// Credentials: never recorded, and not reliably comparable (select: false, or hashed answers), so a
// sent value always counts as a change with both sides redacted.
const SECRET_FIELDS = new Set(['password', 'securityQuestions']);
// Request fields stored under a different path on the user doc.
const STORED_PATHS: Record<string, string> = { moderationStatus: 'moderation.status' };

const REDACTED = adminAuditService.REDACTED_PLACEHOLDER;

const storedPath = (field: string) => STORED_PATHS[field] ?? field;

const readPath = (doc: Record<string, unknown> | null, path: string): unknown =>
  path
    .split('.')
    .reduce<unknown>(
      (value, key) =>
        typeof value === 'object' && value !== null ? (value as Record<string, unknown>)[key] : undefined,
      doc
    );

/** The profile fields a user update sends, minus the ones audited under their own action. */
export const profileFieldsSent = (body: Record<string, unknown>): string[] =>
  Object.keys(body).filter(field => body[field] !== undefined && !EXCLUDED_FIELDS.has(field));

/** Reads the stored value of each field, so the entry can show before and after. */
export const readProfileSnapshot = async (userId: string, fields: string[]) => {
  const paths = fields.filter(field => !SECRET_FIELDS.has(field)).map(storedPath);
  if (paths.length === 0) return null;
  return (await User.findById(userId).select(paths.join(' ')).lean()) as Record<string, unknown> | null;
};

export const diffProfileFields = (
  fields: string[],
  before: Record<string, unknown> | null,
  after: Record<string, unknown> | null
): AuditChange[] =>
  fields.flatMap(field => {
    if (SECRET_FIELDS.has(field)) return [{ field, before: REDACTED, after: REDACTED }];
    const path = storedPath(field);
    const previous = readPath(before, path);
    const next = readPath(after, path);
    return JSON.stringify(previous) === JSON.stringify(next) ? [] : [{ field, before: previous, after: next }];
  });

/**
 * Best-effort `user.profile.updated` mirror for an edit an admin made to someone else's profile (or to
 * the account they are impersonating). Call it after the update commits; a no-op edit writes nothing.
 */
export const recordProfileUpdate = async (
  req: AuditRequest,
  { target, changes }: { target: AuditTarget; changes: AuditChange[] }
): Promise<void> => {
  if (changes.length === 0) return;
  await recordAdminActionFromRequest(req, {
    action: 'user.profile.updated',
    target,
    summary: `updated ${changes.map(change => change.field).join(', ')}`,
    changes,
  });
};
