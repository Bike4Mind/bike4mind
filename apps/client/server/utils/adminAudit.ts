import type { Request } from 'express';
import type { AuditActor, AuditContext, AuditEntry } from '@bike4mind/common';
import { adminAuditLogRepository } from '@bike4mind/database';
import { userRepository } from '@bike4mind/database/auth';
import { adminAuditService } from '@bike4mind/services';
import { getClientIp } from '@server/utils/ip';

export type RecordAdminActionFromRequestInput = Omit<adminAuditService.RecordAdminActionInput, 'actor' | 'context'> & {
  actorScope?: AuditActor['scope'];
};

type ActorIdentity = Pick<NonNullable<Request['user']>, 'id' | 'username' | 'name' | 'email' | 'isAdmin'>;

const toUserActor = (user: ActorIdentity, scope: AuditActor['scope']): AuditActor => ({
  kind: 'user',
  scope,
  userId: user.id,
  email: user.email ?? undefined,
  name: user.name || user.username,
  wasAdmin: user.isAdmin,
});

const resolveActor = async (req: Request, scope: AuditActor['scope']): Promise<AuditActor> => {
  const { user, apiKeyInfo } = req;
  if (!user) throw new Error('recordAdminActionFromRequest requires an authenticated request');

  const impersonatedBy = user.impersonatedBy;
  let actor: AuditActor;
  if (impersonatedBy) {
    // The acting identity is the real admin; req.user is the account being impersonated.
    const admin = await userRepository.findById(impersonatedBy);
    actor = admin
      ? toUserActor(admin, scope)
      : { kind: 'user', scope, userId: impersonatedBy, name: 'Unknown admin', wasAdmin: true };
    actor.impersonatedUserId = user.id;
  } else {
    actor = toUserActor(user, scope);
  }

  return apiKeyInfo ? { ...actor, kind: 'apiKey', apiKeyId: apiKeyInfo.keyId } : actor;
};

const buildContext = (req: Request): AuditContext => ({
  ip: getClientIp(req),
  userAgent: req.headers['user-agent'],
  requestId: req.requestId,
  route: req.url.split('?')[0],
  source: req.apiKeyInfo ? 'api_key' : 'admin_ui',
});

export const recordAdminActionFromRequest = async (
  req: Request,
  { actorScope, ...input }: RecordAdminActionFromRequestInput
): Promise<AuditEntry | null> =>
  adminAuditService.recordAdminAction(
    { ...input, actor: await resolveActor(req, actorScope ?? 'platform'), context: buildContext(req) },
    { db: { adminAuditLog: adminAuditLogRepository }, logger: req.logger }
  );

export const systemAuditActor = (name: string): AuditActor => ({
  kind: 'system',
  scope: 'platform',
  name,
  wasAdmin: false,
});
