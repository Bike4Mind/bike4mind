import { ISessionRepository, IUserRepository } from '@bike4mind/common';
import { NotFoundError, secureParameters } from '@bike4mind/utils';
import { z } from 'zod';

const getSessionSchema = z.object({
  id: z.string(),
});

type GetSessionParameters = z.infer<typeof getSessionSchema>;

interface GetSessionAdapters {
  db: {
    sessions: ISessionRepository;
    users: IUserRepository;
  };
}

export const getSession = async (userId: string, parameters: GetSessionParameters, { db }: GetSessionAdapters) => {
  const { id } = secureParameters(parameters, getSessionSchema);

  const user = await db.users.findById(userId);
  if (!user) throw new NotFoundError('User not found');

  const session = await db.sessions.shareable.findAccessibleById(user, id);
  if (!session) throw new NotFoundError('Session not found');

  return session;
};
