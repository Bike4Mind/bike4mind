import Connection from '@bike4mind/database/social';

export function createConn(data: unknown) {
  return new Connection(data);
}
