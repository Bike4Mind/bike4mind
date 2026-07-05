import { type ISession, sessionRepository } from '@bike4mind/database/auth';

export const repo = sessionRepository;
export type Session = ISession;
