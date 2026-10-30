import { User } from '@bike4mind/database';
import { type MigrationFile } from './index';

const LOG = '[queue-held-signup-grants-for-risk-review]';

/**
 * Moves accounts whose signup tranche was already held in the review band into the admin risk review
 * queue, where approving releases it. New holds enter the queue as they are assessed (releaseStage in
 * userService/stagedSignupGrant.ts); this catches the ones assessed before that. The filter must stay in
 * sync with isSignupGrantHeldForReview (userService/signupRisk.ts). An approved or banned account is left
 * alone. Idempotent: a re-run finds nothing still at 'none'.
 */
const migration: MigrationFile = {
  id: 20260921237000,
  name: 'queue-held-signup-grants-for-risk-review',

  up: async () => {
    const result = await User.collection.updateMany(
      {
        'signupGrantAssessment.band': 'review',
        'signupGrant.stage': 'signup',
        $expr: { $lt: ['$signupGrant.creditsReleased', '$signupGrant.signupCredits'] },
        $or: [{ riskScore: null }, { 'riskScore.reviewState': 'none' }],
      },
      [
        {
          $set: {
            riskScore: {
              $mergeObjects: [{ score: 0, signals: [], computedAt: '$$NOW' }, '$riskScore', { reviewState: 'pending' }],
            },
          },
        },
      ]
    );
    console.log(`${LOG} queued ${result.modifiedCount} account(s) for risk review`);
  },

  // No-op: a queued account is indistinguishable from one queued at runtime, and an admin may already
  // have decided it.
  down: async () => {},
};

export default migration;
