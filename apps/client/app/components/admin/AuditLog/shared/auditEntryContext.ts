import type { AuditEntry } from '@bike4mind/common';
import { findApiKeyScopeOption, isAdminProvisionedApiKeyScope } from '@client/app/constants/apiKeyScopes';

export type AuditKeyScope = {
  value: string;
  label: string;
  description?: string;
  adminProvisioned: boolean;
};

export type AuditKeyContext = {
  name?: string;
  scopes: AuditKeyScope[];
};

const API_KEY_ACTION_PREFIX = 'user.api_key.';

const readString = (value: unknown): string | undefined =>
  typeof value === 'string' && value.length > 0 ? value : undefined;

const describeScope = (value: string): AuditKeyScope => {
  const option = findApiKeyScopeOption(value);
  return {
    value,
    label: option?.label ?? value,
    description: option?.description,
    adminProvisioned: isAdminProvisionedApiKeyScope(value),
  };
};

/**
 * Key name and scopes for a single-key audit entry. The mint route stores the name as `name`, the
 * rotate/revoke/restore routes as `keyName`; entries written before scopes were recorded have none.
 */
export const auditKeyContext = (entry: AuditEntry): AuditKeyContext | null => {
  if (!entry.action.startsWith(API_KEY_ACTION_PREFIX)) return null;
  const details = entry.details ?? {};
  const name = readString(details.name) ?? readString(details.keyName);
  const rawScopes = Array.isArray(details.scopes) ? details.scopes : [];
  const scopes = rawScopes.filter((scope): scope is string => typeof scope === 'string').map(describeScope);
  if (!name && scopes.length === 0) return null;
  return { name, scopes };
};

/** The acting admin acted on their own account. Ids compare case-insensitively, as auditReviewConflict does. */
export const isSelfTargeted = (entry: AuditEntry): boolean => {
  const actorId = entry.actor.userId;
  return entry.target.kind === 'user' && !!actorId && actorId.toLowerCase() === entry.target.id.toLowerCase();
};
