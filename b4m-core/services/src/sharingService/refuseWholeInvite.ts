import { IInviteDocument, IInviteRepository, IUserDocument } from '@bike4mind/common';
import { NotFoundError, secureParameters, UnprocessableEntityError } from '@bike4mind/utils';
import { z } from 'zod';
import { authorizeByInviteType, InviteTypeAuthAdapters } from './authorizeByInviteType';
import { resolveAddressedInvite } from './resolveRedeemableInvite';

const refuseWholeInviteSchema = z.object({
  id: z.string(),
});

type RefuseWholeInviteParameters = z.infer<typeof refuseWholeInviteSchema>;

interface RefuseWholeInviteAdapters {
  db: InviteTypeAuthAdapters & {
    invites: Pick<IInviteRepository, 'findById' | 'findByToken' | 'update'>;
  };
}

/**
 * Refuses an invite. A named pending recipient declining affects ONLY their own slot -
 * moved from `pending` to `refused`, `remaining` decremented by one - and must never
 * touch anyone else's slot or the invite as a whole, since a multi-recipient invite is
 * shared state across every invitee. Revoking the WHOLE invite (a link invite, or a
 * caller who is not a named pending recipient) instead requires the same share
 * authority cancelInviteById.ts enforces via `authorizeByInviteType` with
 * requireManageGroups (billing owner, org admin, or platform admin for Org/Group
 * invites; share access for FabFile/Session/Project). This replaces two holes the manager's CASL
 * `acceptOrRefuse` scope left open: any holder of a link invite id could zero it for
 * everyone, and one named recipient declining could do the same to every co-recipient.
 */
export const refuseWholeInvite = async (
  user: IUserDocument,
  parameters: RefuseWholeInviteParameters,
  { db }: RefuseWholeInviteAdapters
): Promise<IInviteDocument | null> => {
  const { id } = secureParameters(parameters, refuseWholeInviteSchema);

  // Three surfaces reach this with three different keys: the share URL carries the bearer token, the
  // inbox lists invites through a projection carrying no token and can only pass the `_id`, and the
  // document's invite list revokes by `_id` as well. So the key is an ADDRESS here, not a credential,
  // and the address door is the right one - holding it grants nothing, because both arms below
  // re-derive authority from the caller: the decline arm from their own email in `recipients.pending`
  // and the revoke arm from share authority on the underlying document. Routing this through the
  // REDEEMABLE door instead would 404 the sharer revoking their own link invite from that list.
  const invite = await resolveAddressedInvite(id, { db });
  if (!invite) throw new NotFoundError('Invite not found');

  // createInvite defaults expiresAt 100 years out, so this only bites a real expiration.
  if (invite.expiresAt && invite.expiresAt < new Date()) {
    throw new UnprocessableEntityError('Invite has expired');
  }

  const pending = invite.recipients?.pending ?? [];
  const isPendingRecipient = !!user.email && pending.includes(user.email);

  if (isPendingRecipient) {
    invite.recipients!.pending = pending.filter(p => p !== user.email);
    invite.recipients!.refused = [...(invite.recipients!.refused ?? []), user.email as string];
    invite.remaining -= 1;
  } else {
    await authorizeByInviteType(user, invite.type, invite.documentId, db, { requireManageGroups: true });

    invite.remaining = 0;
    if (invite.recipients) {
      invite.recipients.pending = [];
    }
  }

  await db.invites.update(invite);
  return db.invites.findById(invite.id);
};
