import type { ISession } from '@bike4mind/database/auth';

export function process(session: ISession): void {
  console.log(session);
}
