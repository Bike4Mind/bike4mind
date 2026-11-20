import type { Request } from 'express';
import type { ActorIdentity } from '@bike4mind/server-utils/utils/adminAudit';
import type { CompletionRequestAuth } from '@bike4mind/server-utils/utils/untrustedCompletionQuota';

// Compile-time only. server-utils cannot load this app's Express augmentation (global.d.ts), so the
// check that the augmented user still fits adminAudit's hand-written ActorIdentity slice lives here,
// where client typecheck sees both. Test files are excluded from that typecheck, hence a plain module.
type Assert<T extends true> = T;
export type AugmentedUserFitsAuditActor = Assert<NonNullable<Request['user']> extends ActorIdentity ? true : false>;

// untrustedCompletionQuota's admitRequestCompletion reads these key fields; its all-optional slice would
// still accept a renamed ApiKeyInfo field, so pin that the augmented fields keep fitting it.
type AuthKeySlice = NonNullable<CompletionRequestAuth['apiKeyInfo']>;
export type AugmentedApiKeyFitsCompletionAuth = Assert<
  Pick<NonNullable<Request['apiKeyInfo']>, keyof AuthKeySlice> extends AuthKeySlice ? true : false
>;
