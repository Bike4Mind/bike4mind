import { CURRENT_POLICY_VERSION, IUserDocument } from '@bike4mind/common';
import { BadRequestError, NotFoundError } from '@bike4mind/utils';
import { z } from 'zod';

// NOT parsed at runtime - this schema exists only to derive the param type via z.infer. The real
// guard is the manual `ageAttestation !== true` check below. If you add a field here, it is NOT
// enforced until you also validate it at runtime.
// eslint-disable-next-line @typescript-eslint/no-unused-vars -- used only as type via z.infer
const recordPolicyAcceptanceSchema = z.object({
  userId: z.string(),
  // boolean, not z.literal(true): the value comes from an untyped HTTP body, so the `!== true`
  // check below is the real runtime guard. Typing it `true` here would make callers cast a raw
  // body value to `true` (a lie) before the guard has run.
  ageAttestation: z.boolean(),
});

export type RecordPolicyAcceptanceParameters = z.infer<typeof recordPolicyAcceptanceSchema>;

interface RecordPolicyAcceptanceAdapters {
  db: {
    users: {
      findById: (id: string) => Promise<IUserDocument | null>;
      update: (user: IUserDocument) => Promise<unknown>;
    };
  };
}

/**
 * Records a user's acceptance of the current AUP/ToS + 18+ age attestation (P0-B abuse gate).
 * Stamps the version SERVER-SIDE from the single CURRENT_POLICY_VERSION constant - the
 * caller does not supply a version, so there is no version-mismatch surface. Rejects unless the
 * 18+ attestation is explicitly true; no DOB is collected.
 *
 * Business logic lives here (not in the Next.js route) to match the per-mutation service idiom -
 * registerUser stamps at creation, this records post-creation acceptance for the OAuth/SAML/Okta
 * paths - and so the existing-user re-consent fast-follow can reuse it without touching HTTP.
 */
export const recordPolicyAcceptance = async (
  params: RecordPolicyAcceptanceParameters,
  { db }: RecordPolicyAcceptanceAdapters
): Promise<IUserDocument> => {
  const { userId, ageAttestation } = params;

  if (ageAttestation !== true) {
    throw new BadRequestError('You must confirm you are 18 or older to continue');
  }

  const user = await db.users.findById(userId);
  if (!user) {
    throw new NotFoundError('User not found');
  }

  const updatedUser: IUserDocument = {
    ...user,
    aupAcceptedVersion: CURRENT_POLICY_VERSION,
    aupAcceptedAt: new Date(),
    ageAttestedAdult: true,
    updatedAt: new Date(),
  };

  await db.users.update(updatedUser);
  return updatedUser;
};
