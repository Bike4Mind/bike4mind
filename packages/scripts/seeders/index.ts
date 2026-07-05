import { AgentSeeder } from './AgentSeeder';
import { SystemSecretsSeeder } from './SystemSecretsSeeder';
import { UserSeeder } from './UserSeeder';

/**
 * Seeders are used to populate the database with initial data.
 * They are run in the order they are defined in the array.
 *
 * IMPORTANT: SystemSecretsSeeder must run FIRST because:
 * 1. It validates Tier 1 secrets (SECRET_ENCRYPTION_KEY, SESSION_SECRET, JWT_SECRET)
 * 2. Other seeders may depend on having valid encryption available
 */
export const seeders = [
  SystemSecretsSeeder, // Must run first - validates Tier 1 secrets (SST CLI required)
  UserSeeder,
  AgentSeeder, // Depends on UserSeeder - needs the test@test.com super admin to exist.
  // Add other seeders here...
];
