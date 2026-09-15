import { type ISession, sessionRepository } from '@bike4mind/database/src/models/SessionModel';

export const repo = sessionRepository;
export type Session = ISession;
