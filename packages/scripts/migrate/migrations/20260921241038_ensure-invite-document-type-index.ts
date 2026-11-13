import { Invite, type MigrationFile } from '@bike4mind/database';

const migration: MigrationFile = {
  id: 20260921241038,
  name: 'ensure invite document and resource type index',
  up: async () => {
    await Invite.createIndexes();
  },
  down: async () => {},
};
export default migration;
