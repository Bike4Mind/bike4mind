import { AgentSeeder } from './AgentSeeder';
import { OAuthClientSeeder } from './OAuthClientSeeder';
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
  // Last on purpose: preview-only OAuth clients. It swallows its own errors, but keeping it
  // last also means a failure here can't starve the users/agents above (seed() has no per-seeder catch).
  OAuthClientSeeder,
];
