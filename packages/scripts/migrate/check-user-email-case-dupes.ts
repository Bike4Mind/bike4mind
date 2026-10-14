import { connectDB } from '@bike4mind/db-core';
import { User } from '@bike4mind/database';
import { Resource } from 'sst';
import { Config } from '../utils/config';
import { findCaseInsensitiveCollisions, renderCollisionGroups, type UserIdentityRow } from './userCaseDupesReport';

/**
 * READ-ONLY pre-flight for a future case-insensitive unique index on users.email (and a look at
 * users.username). Groups users whose email, or username, matches another user's once trimmed
 * and lowercased, and prints each group's user ids, createdAt and emailVerified - never the
 * email or username itself. Exits non-zero when any email group exists, so it can gate the
 * index migration; username collisions are reported but do not fail the run.
 *
 * Grouping happens in the script rather than in an aggregation so the same normalization runs
 * on MongoDB and DocumentDB alike.
 *
 * Usage:
 *   ./for-env <env> pnpm sst shell --stage <stage> -- pnpm --filter scripts users:check-email-case-dupes
 */
async function main() {
  const dbUri = Config.MONGODB_URI;
  if (!dbUri) throw new Error('MONGODB_URI is required');
  const stage = Resource.App.stage;
  // db-core connectDB with autoIndex/autoCreate off: the @bike4mind/database wrapper seeds catalog
  // rows on connect and a checkout ahead of the stage would build indexes, neither of which a
  // read-only report may do.
  await connectDB(dbUri.replace('%STAGE%', stage), undefined, { autoIndex: false, autoCreate: false });

  console.log(`Checking case-insensitive users.email / users.username collisions on stage="${stage}"...`);

  const emailRows: UserIdentityRow[] = [];
  const usernameRows: UserIdentityRow[] = [];
  const cursor = User.find({}, { email: 1, username: 1, createdAt: 1, emailVerified: 1 }).lean().cursor();
  for await (const doc of cursor) {
    const base = {
      id: String(doc._id),
      createdAt: doc.createdAt instanceof Date ? doc.createdAt : null,
      emailVerified: typeof doc.emailVerified === 'boolean' ? doc.emailVerified : null,
    };
    emailRows.push({ ...base, value: doc.email });
    usernameRows.push({ ...base, value: doc.username });
  }
  console.log(`Scanned ${emailRows.length} users.`);

  const emailGroups = findCaseInsensitiveCollisions(emailRows);
  const usernameGroups = findCaseInsensitiveCollisions(usernameRows);

  for (const line of renderCollisionGroups('email', emailGroups)) console.log(line);
  for (const line of renderCollisionGroups('username', usernameGroups)) console.log(line);

  process.exit(emailGroups.length > 0 ? 1 : 0);
}

main().catch(e => {
  console.error(e);
  process.exit(1);
});
