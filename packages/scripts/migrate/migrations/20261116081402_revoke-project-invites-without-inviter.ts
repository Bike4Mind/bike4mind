import { Invite } from '@bike4mind/database';
import { type MigrationFile } from './index';

/**
 * Closes Project invites that record no inviter and still have a slot left.
 *
 * sharingService/accept.ts refuses a Project invite without `inviterId`, because there is no minter
 * to cap its per-item grants against. Left as they are, those rows stay in their recipients' pending
 * lists and fail only when accepted. Closed, they leave the lists and the sender re-sends.
 *
 * The write is InviteRepository.closeInvite plus `revokedAt`: the pending list reads
 * `recipients.pending`, not `revokedAt`, so the flag alone would leave the invite listed. Clearing
 * `pending` together with `remaining` is what isLinkOnlyInvite relies on (b4m-core/common
 * inviteVisibility.ts). `accepted` and `refused` are kept.
 *
 * Idempotent: a closed row no longer matches the filter.
 */
const LEGACY_PROJECT_INVITE_FILTER = {
  type: 'Project',
  inviterId: { $in: [null, ''] },
  revokedAt: null,
  remaining: { $gt: 0 },
};

const migration: MigrationFile = {
  id: 20261116081402,
  name: 'revoke-project-invites-without-inviter',

  up: async () => {
    const result = await Invite.updateMany(LEGACY_PROJECT_INVITE_FILTER, [
      {
        $set: {
          remaining: 0,
          revokedAt: '$$NOW',
          recipients: {
            $cond: [
              { $eq: [{ $type: '$recipients' }, 'object'] },
              { $mergeObjects: ['$recipients', { pending: [] }] },
              '$recipients',
            ],
          },
          updatedAt: '$$NOW',
        },
      },
    ]);
    console.log(`[revoke-project-invites-without-inviter] closed ${result.modifiedCount} Project invite(s)`);
  },

  // Irreversible by design: a closed row is indistinguishable from one its sender cancelled, and the
  // cleared pending addresses are not kept anywhere.
  down: async () => {
    console.log('[revoke-project-invites-without-inviter] no down migration; senders re-send instead');
  },
};

export default migration;
