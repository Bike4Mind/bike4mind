import { IUserDocument } from '@bike4mind/common';
import { IRegistrationInviteRepository, RegInviteStatusType } from '@bike4mind/common';
import { ForbiddenError, secureParameters } from '@bike4mind/utils';
import { randomBytes } from 'crypto';
import range from 'lodash/range.js';
import { z } from 'zod';

const generateReferralCodesSchema = z.object({
  count: z.number().optional(),
  unlimitedUse: z.boolean().optional(),
  expiresAt: z.date().optional(),
  tags: z.array(z.string().min(1).max(100)).max(20).optional(),
  startingCredits: z.number().int().min(0).max(1_000_000).optional(),
  startingStorage: z.number().int().min(0).max(100_000).optional(),
});

type GenerateReferralCodesParameters = z.infer<typeof generateReferralCodesSchema>;

interface GenerateReferralCodesAdapters {
  db: {
    regInvites: IRegistrationInviteRepository;
  };
}

export const generateReferralCodes = async (
  user: IUserDocument,
  parameters: GenerateReferralCodesParameters,
  { db }: GenerateReferralCodesAdapters
) => {
  if (!user.isAdmin) {
    throw new ForbiddenError('Permission denied');
  }

  const {
    count = 1,
    unlimitedUse = false,
    expiresAt,
    tags,
    startingCredits,
    startingStorage,
  } = secureParameters(parameters, generateReferralCodesSchema);

  const resolveExpiry = () => {
    if (unlimitedUse) {
      if (expiresAt) return expiresAt;
      const date = new Date();
      date.setMonth(date.getMonth() + 3);
      return date;
    }

    return expiresAt;
  };

  const buildCodes = range(1, count + 1).map(() => {
    const inviteExpiresAt = resolveExpiry();
    return {
      userId: user.id,
      code: generateCode(),
      status: RegInviteStatusType.open,
      unlimitedUse,
      ...(inviteExpiresAt ? { expiresAt: inviteExpiresAt } : {}),
      ...(tags && tags.length > 0 ? { tags } : {}),
      ...(startingCredits != null ? { startingCredits } : {}),
      ...(startingStorage != null ? { startingStorage } : {}),
      usageHistory: [],
      createdAt: new Date(),
      updatedAt: new Date(),
    };
  });

  const regInvites = await db.regInvites.createMany(buildCodes);

  return regInvites;
};

function generateCode(): string {
  const randomBytesArray = randomBytes(8);

  const formattedCode = randomBytesArray.toString('hex').toUpperCase();

  const match = formattedCode.match(/.{1,4}/g);

  if (!match) {
    throw new Error('Error generating formatted code');
  }

  return match.join('-');
}
