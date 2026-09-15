import { ISession, sessionRepository } from '@bike4mind/database/auth';

export function getSession(id: string): Promise<ISession | null> {
  return sessionRepository.findById(id);
}
