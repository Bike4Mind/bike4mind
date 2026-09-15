import { ISession, sessionRepository } from '@bike4mind/database/src/models/SessionModel';

export function getSession(id: string): Promise<ISession | null> {
  return sessionRepository.findById(id);
}
