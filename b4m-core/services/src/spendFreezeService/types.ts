import type { ClientSession } from 'mongoose';
import type {
  IAdminAuditLogRepository,
  ISpendFreezeRepository,
  SpendFreezeActor,
  SpendFreezeScope,
  StoredAuditContext,
  AuditActor,
} from '@bike4mind/common';
import type { ILogger } from '@bike4mind/observability';

export type SpendFreezeAudit = { actor: AuditActor; context: StoredAuditContext };

export type SpendFreezeAdapters = {
  db: {
    spendFreezes: ISpendFreezeRepository;
    adminAuditLog: Pick<IAdminAuditLogRepository, 'append'>;
  };
  logger: ILogger;
};

export type SpendFreezeChangeInput = {
  scope: SpendFreezeScope;
  actor: SpendFreezeActor;
  reason: string;
  audit: SpendFreezeAudit;
  /** Explicit session for the repository write; without one it joins the ambient withTransaction, as the audit append does. */
  session?: ClientSession;
  now?: Date;
};
