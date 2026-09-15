import type { ISession } from '@bike4mind/database/src/models/SessionModel';

export function process(session: ISession): void {
  console.log(session);
}
