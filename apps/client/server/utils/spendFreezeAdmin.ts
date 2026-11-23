import { z } from 'zod';
import {
  assertCanActOnAdminTarget,
  BadRequestError,
  NotFoundError,
  SPEND_FREEZE_SCOPE_TYPES,
  type SpendFreezeScope,
} from '@bike4mind/common';
import {
  adminAuditLogRepository,
  organizationRepository,
  spendFreezeRepository,
  userApiKeyRepository,
  userRepository,
} from '@bike4mind/database';
import type { ILogger } from '@bike4mind/observability';
import type { spendFreezeService } from '@bike4mind/services';
import {
  parseAdminActionReason,
  resolveAdminAuditFromRequest,
  type AuditRequest,
} from '@bike4mind/server-utils/utils/adminAudit';

const objectIdString = z.string().regex(/^[a-f0-9]{24}$/i, 'Expected an id');

export const scopeSchema = z.object({
  scopeType: z.enum(SPEND_FREEZE_SCOPE_TYPES),
  scopeId: objectIdString,
});

export const parseScope = (source: unknown): SpendFreezeScope => {
  const parsed = scopeSchema.safeParse(source);
  if (!parsed.success) throw new BadRequestError(parsed.error.issues[0]?.message ?? 'Invalid scope');
  return parsed.data;
};

export const parseReason = (body: unknown): string =>
  parseAdminActionReason((body as { reason?: unknown } | undefined)?.reason);

export const buildSpendFreezeAdapters = (logger: ILogger): spendFreezeService.SpendFreezeAdapters => ({
  db: { spendFreezes: spendFreezeRepository, adminAuditLog: adminAuditLogRepository },
  logger,
});

const requireAdminId = (req: AuditRequest): string => {
  if (!req.user) throw new Error('Spend freeze routes require an authenticated admin');
  return req.user.id;
};

export const buildSpendFreezeChange = async (req: AuditRequest, reason: string) => ({
  actor: { kind: 'admin' as const, userId: requireAdminId(req) },
  audit: await resolveAdminAuditFromRequest(req),
  reason,
});

/**
 * 404s when the scope does not exist; a user scope, or an API key scope via its owner, also passes the admin-outranks-target guard.
 * A lift passes `mustExist: false` so a freeze on a since-deleted scope can still be released.
 */
export const assertScopeExists = async (
  admin: Express.User,
  scope: SpendFreezeScope,
  { mustExist = true }: { mustExist?: boolean } = {}
): Promise<void> => {
  if (scope.scopeType === 'User') {
    const user = await userRepository.findById(scope.scopeId);
    if (!user) {
      if (mustExist) throw new NotFoundError('User not found');
      return;
    }
    assertCanActOnAdminTarget(admin, user, 'change spend freezes for');
    return;
  }
  if (scope.scopeType === 'apiKey') {
    const apiKey = await userApiKeyRepository.findById(scope.scopeId);
    if (!apiKey) {
      if (mustExist) throw new NotFoundError('API key not found');
      return;
    }
    // An orphaned key (owner deleted) has no admin access to protect.
    const owner = await userRepository.findById(apiKey.userId);
    if (owner) assertCanActOnAdminTarget(admin, owner, 'change spend freezes for');
    return;
  }
  // Admin rank belongs to users, so an organization has none to protect: credits:adjust alone authorizes it.
  if (!mustExist) return;
  if (!(await organizationRepository.findById(scope.scopeId))) throw new NotFoundError('Organization not found');
};

/**
 * Human label per scope (see `labelKey`): email, organization name or key prefix. Batched per scope
 * type. Takes any scoped records, so incidents label the same way freezes do.
 */
export const labelFreezes = async (freezes: readonly SpendFreezeScope[]): Promise<Map<string, string>> => {
  const idsOf = (scopeType: SpendFreezeScope['scopeType']) =>
    freezes.filter(freeze => freeze.scopeType === scopeType).map(freeze => freeze.scopeId);
  const [users, organizations, apiKeys] = await Promise.all([
    idsOf('User').length ? userRepository.findByIds(idsOf('User')) : [],
    idsOf('Organization').length ? organizationRepository.find({ _id: { $in: idsOf('Organization') } }) : [],
    idsOf('apiKey').length ? userApiKeyRepository.find({ _id: { $in: idsOf('apiKey') } }) : [],
  ]);
  const labels = new Map<string, string>();
  for (const user of users) labels.set(`User:${user.id}`, user.email ?? user.username);
  for (const organization of organizations) labels.set(`Organization:${organization.id}`, organization.name);
  for (const apiKey of apiKeys) labels.set(`apiKey:${apiKey.id}`, apiKey.keyPrefix);
  return labels;
};

export const labelKey = (scope: SpendFreezeScope) => `${scope.scopeType}:${scope.scopeId}`;
