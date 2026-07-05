import { mongoose } from '@bike4mind/database';
import { type MigrationFile } from './index';

/**
 * Migration: Set all agents isPublic to false
 *
 * Public agents (including test agents) were appearing in all users' agent lists.
 * The isPublic: true condition has been removed from all agent query $or clauses,
 * and this migration cleans up existing data.
 */
const migration: MigrationFile = {
  id: 20260210000000,
  name: 'set agents isPublic false',

  up: async () => {
    console.log('Starting migration: Set all agents isPublic to false...');

    const db = mongoose.connection.db;
    if (!db) {
      throw new Error('Database connection not established');
    }

    const agentsCollection = db.collection('agents');

    const publicCount = await agentsCollection.countDocuments({ isPublic: true });
    console.log(`Found ${publicCount} agents with isPublic: true`);

    if (publicCount === 0) {
      console.log('No agents to update');
      return;
    }

    const result = await agentsCollection.updateMany({ isPublic: true }, { $set: { isPublic: false } });

    console.log(`Updated ${result.modifiedCount} agents to isPublic: false`);
  },

  down: async () => {
    // No rollback: we cannot determine which agents were originally public
    console.log('Rollback: No action taken. Cannot determine original isPublic values.');
  },
};

export default migration;
