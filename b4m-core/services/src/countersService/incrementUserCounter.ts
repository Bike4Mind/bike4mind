import { ICounterLog, IUserDocument, WithOrgRef } from '@bike4mind/common';
import { InternalServerError, NotFoundError, secureParameters } from '@bike4mind/utils';
import mongoose from 'mongoose';
import { z } from 'zod';

const incrementUserCounterSchema = z.object({
  action: z.string(),
  increment: z.coerce.number().prefault(1).optional(),
  metadata: z.record(z.string(), z.unknown()).optional(),
});

export type AddUserCounterParameters = z.infer<typeof incrementUserCounterSchema>;

interface AddUserCounterAdapters {
  db: {
    users: {
      findByIdWithOrganization: (userId: string) => Promise<WithOrgRef<IUserDocument> | null>;
    };
    userActivityCounters: {
      upsertByUserIdAndAction: (
        userId: string,
        action: string,
        data: AddUserCounterParameters
      ) => Promise<mongoose.UpdateWriteOpResult>;
    };
    counterLogs: {
      create: (counter: ICounterLog) => Promise<ICounterLog>;
    };
  };
  fn: {
    isValidCounterEvent: (action: string) => boolean;
  };
}

export const incrementUserCounter = async (
  userId: string,
  parameters: AddUserCounterParameters,
  { db, fn }: AddUserCounterAdapters
) => {
  if (!fn.isValidCounterEvent(parameters.action)) {
    throw new InternalServerError(`Invalid counter event: ${parameters.action}`);
  }

  const { action, increment = 1, metadata } = secureParameters(parameters, incrementUserCounterSchema);

  const user = await db.users.findByIdWithOrganization(userId);
  if (!user) throw new NotFoundError('User not found');
  const organizationName = user.organizationId?.name || '';

  await db.userActivityCounters.upsertByUserIdAndAction(userId, action, parameters);

  await db.counterLogs.create({
    userId,
    userName: user.username,
    userTags: user.tags || [],
    userLevel: user.level,
    userOrganization: organizationName,
    counterName: action,
    counterTags: [],
    counterValue: increment,
    datetime: new Date(),
    metadata,
  });
};
