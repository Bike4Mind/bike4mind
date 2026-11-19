import type { AuditTarget, SpendFreezeScope, SpendFreezeScopeType } from '@bike4mind/common';
import { BadRequestError } from '@bike4mind/utils';

const TARGET_KIND: Record<SpendFreezeScopeType, AuditTarget['kind']> = {
  User: 'user',
  Organization: 'organization',
  apiKey: 'apiKey',
};

export const toAuditTarget = (scope: SpendFreezeScope): AuditTarget => ({
  kind: TARGET_KIND[scope.scopeType],
  id: scope.scopeId,
  displayName: scope.scopeId,
});

export const requireReason = (reason: string): string => {
  const trimmed = reason?.trim();
  if (!trimmed) throw new BadRequestError('A reason is required.');
  return trimmed;
};
