import { IRegistrationInvite, RegInviteStatusType } from '@bike4mind/common';
import { randomBytes } from 'crypto';
import { registrationInviteRepository } from '@bike4mind/database';

export const generateRegInvite = (
  userId: string = '',
  options: { expiresAt?: Date; unlimitedUse?: boolean } = {}
): IRegistrationInvite => {
  const { expiresAt, unlimitedUse } = options;

  return {
    userId,
    status: RegInviteStatusType.open,
    code: generateCode(),
    ...(expiresAt ? { expiresAt } : {}),
    ...(typeof unlimitedUse === 'boolean' ? { unlimitedUse } : {}),
    usageHistory: [],
  };
};

export const createRegInvite = async (data: IRegistrationInvite) => registrationInviteRepository.create(data);

export const getRegInvites = async (): Promise<(IRegistrationInvite | null)[]> => registrationInviteRepository.find({});

// Conditionally set the status and used date of a registration invite
export const formatRegInviteUpdates = (updates: Partial<IRegistrationInvite>) => {
  if (!updates.status) return { $set: updates };

  const inviteParams: { $set: any; $unset: any } = { $set: updates, $unset: { used: 1 } };
  if (updates.status === RegInviteStatusType.used) {
    inviteParams.$set['used'] = new Date();
    delete inviteParams.$unset;
  }

  return inviteParams;
};

export function generateCode(): string {
  const randomBytesArray = randomBytes(8);
  const formattedCode = randomBytesArray.toString('hex').toUpperCase();

  // Split into four groups of four characters
  const match = formattedCode.match(/.{1,4}/g);

  if (!match) {
    throw new Error('Error generating formatted code');
  }

  return match.join('-');
}
