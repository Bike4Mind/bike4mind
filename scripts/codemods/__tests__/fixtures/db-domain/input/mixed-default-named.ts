import SessionModel, { ISession } from '@bike4mind/database/src/models/SessionModel';

export function create(data: ISession) {
  return new SessionModel(data);
}
