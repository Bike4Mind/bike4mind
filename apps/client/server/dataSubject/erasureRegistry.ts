import { mongoose } from '@bike4mind/database';
import { retainDeletedSignupTraces } from '@bike4mind/server-utils/auth/signupNetworkLimits';
import { purgeUserPublishedArtifacts } from '@bike4mind/server-utils/services/publish/purgeUserPublishedArtifacts';
import type { ErasureRegistry } from '@bike4mind/server-utils/users/completeAccountDeletion';
import { DATA_HOLDER_REGISTRY, findUnclassifiedModels } from './registry';
import { SubjectErasureExecutor } from './subjectErasureExecutor';
import { SubjectErasurePlan, unerased } from './subjectErasurePlan';
import { assertEveryModelClassified } from './subjectMatcher';

/**
 * The functions a holder's `beforeErasure` names, by name. Each is idempotent: the account purge
 * (purgeAccountContent.ts) also runs them, ahead of its own deletes that would leave them nothing to read.
 */
export const BEFORE_ERASURE_HOOKS: Readonly<Record<string, (userId: string) => Promise<unknown>>> = {
  purgeUserPublishedArtifacts: userId => purgeUserPublishedArtifacts(userId, { deletedBy: userId }),
  retainDeletedSignupTraces,
};

function beforeErasureHooks(): string[] {
  const names = Object.values(DATA_HOLDER_REGISTRY).flatMap(holder =>
    holder.kind === 'holder' ? (holder.beforeErasure ?? []) : []
  );
  return [...new Set(names)];
}

/** The data holder registry the account purge (completeAccountDeletion.ts) plans, erases and checks against. */
export const erasureRegistry: ErasureRegistry = {
  async scope(subject, assertLease) {
    assertEveryModelClassified(mongoose.modelNames());
    return new SubjectErasurePlan(subject).collections(assertLease);
  },
  async erase(subject, assertLease) {
    assertEveryModelClassified(mongoose.modelNames());
    for (const name of beforeErasureHooks()) {
      const hook = BEFORE_ERASURE_HOOKS[name];
      if (!hook) throw new Error(`No beforeErasure function is registered under ${name}`);
      await assertLease();
      await hook(subject.userId);
    }
    await new SubjectErasureExecutor(subject, assertLease).run();
  },
  async audit(subject) {
    // A model the registry does not classify was not checked, so it is listed rather than passed over.
    const unclassified = findUnclassifiedModels(mongoose.modelNames());
    const remaining = unerased(await new SubjectErasurePlan(subject).collections());
    return { remaining, unclassified };
  },
};
