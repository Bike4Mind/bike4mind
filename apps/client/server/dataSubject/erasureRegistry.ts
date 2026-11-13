import { mongoose } from '@bike4mind/database';
import type { ErasureRegistry } from '@bike4mind/server-utils/users/completeAccountDeletion';
import { findUnclassifiedModels } from './registry';
import { SubjectErasurePlan, unerased } from './subjectErasurePlan';
import { assertEveryModelClassified } from './subjectMatcher';

/** The data holder registry the account purge (completeAccountDeletion.ts) plans and checks an erasure against. */
export const erasureRegistry: ErasureRegistry = {
  async scope(subject, assertLease) {
    assertEveryModelClassified(mongoose.modelNames());
    return new SubjectErasurePlan(subject).collections(assertLease);
  },
  async audit(subject) {
    // A model the registry does not classify was not checked, so it is listed rather than passed over.
    const unclassified = findUnclassifiedModels(mongoose.modelNames());
    const remaining = unerased(await new SubjectErasurePlan(subject).collections());
    return { remaining, unclassified };
  },
};
