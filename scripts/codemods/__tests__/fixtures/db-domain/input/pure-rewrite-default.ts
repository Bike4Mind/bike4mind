import Connection from '@bike4mind/database/src/models/ConnectionModel';

export function createConn(data: unknown) {
  return new Connection(data);
}
