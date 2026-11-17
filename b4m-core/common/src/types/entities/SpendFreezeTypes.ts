export const SPEND_FREEZE_SCOPE_TYPES = ['User', 'Organization', 'apiKey'] as const;
export type SpendFreezeScopeType = (typeof SPEND_FREEZE_SCOPE_TYPES)[number];

export type SpendFreezeScope = { scopeType: SpendFreezeScopeType; scopeId: string };

export type SpendFreezeActor =
  { kind: 'admin'; userId: string } | { kind: 'automatic'; rule: string; spendAlertId?: string };

export type ISpendFreeze = SpendFreezeScope & {
  id: string;
  /** Admin-facing only; never included in an error returned to the frozen caller. */
  reason: string;
  actor: SpendFreezeActor;
  frozenAt: Date;
  liftedAt?: Date;
  liftedBy?: SpendFreezeActor;
  liftReason?: string;
};

/** Who is spending; absent ids are not checked. */
export type SpendFreezeSubject = {
  userId?: string | null;
  organizationId?: string | null;
  apiKeyId?: string | null;
};

/** `session` is an opaque Mongo ClientSession; common carries no Mongo types. */
export interface ISpendFreezeRepository {
  findActiveForSubject(subject: SpendFreezeSubject): Promise<ISpendFreeze | null>;
  findActive(scope: SpendFreezeScope): Promise<ISpendFreeze | null>;
  /** Throws when the scope already has an active freeze. */
  createActive(
    input: Omit<ISpendFreeze, 'id' | 'liftedAt' | 'liftedBy' | 'liftReason'>,
    opts?: { session?: unknown }
  ): Promise<ISpendFreeze>;
  liftActive(
    scope: SpendFreezeScope,
    lift: { liftedBy: SpendFreezeActor; liftReason: string; liftedAt: Date },
    opts?: { session?: unknown }
  ): Promise<ISpendFreeze | null>;
  listActive(q: {
    scopeType?: SpendFreezeScopeType;
    limit: number;
    cursor?: string;
  }): Promise<{ items: ISpendFreeze[]; nextCursor: string | null }>;
  listHistory(
    scope: SpendFreezeScope,
    limit: number,
    cursor?: string
  ): Promise<{ items: ISpendFreeze[]; nextCursor: string | null }>;
}
