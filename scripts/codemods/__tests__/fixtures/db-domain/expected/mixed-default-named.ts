import SessionModel, { ISession } from '@bike4mind/database/auth';

export function create(data: ISession) {
  return new SessionModel(data);
}
