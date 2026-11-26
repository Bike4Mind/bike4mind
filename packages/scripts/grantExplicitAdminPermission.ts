#!/usr/bin/env tsx

/**
 * Grants an explicit-only admin permission (EXPLICIT_ONLY_ADMIN_PERMISSIONS, b4m-core/common adminPermissions.ts)
 * straight in the database. Only a holder can grant one in the admin console, so this is how a deployment gets its
 * first holders. It writes no admin audit entry: run it only to bootstrap, then grant from the console.
 *
 *   pnpm db:grant-explicit-admin-permission <email> <permission>
 */

import { EXPLICIT_ONLY_ADMIN_PERMISSIONS, isExplicitOnlyAdminPermission } from '@bike4mind/common';
import { User, connectDB } from '@bike4mind/database';
import { Resource } from 'sst';

async function main(): Promise<number> {
  const [email, permission] = process.argv.slice(2);
  if (!email || !permission || !isExplicitOnlyAdminPermission(permission)) {
    console.error(
      `Usage: pnpm db:grant-explicit-admin-permission <email> <${EXPLICIT_ONLY_ADMIN_PERMISSIONS.join(' | ')}>`
    );
    return 1;
  }

  await connectDB(Resource.MONGODB_URI.value.replace('%STAGE%', Resource.App.stage));
  const user = await User.findOneAndUpdate(
    { email },
    { $addToSet: { adminPermissions: permission } },
    { new: true, runValidators: true, projection: { email: 1, isAdmin: 1, adminPermissions: 1 } }
  )
    .collation({ locale: 'en', strength: 2 })
    .lean();
  if (!user) {
    console.error(`No user with email ${email}`);
    return 1;
  }
  console.log(
    `Granted ${permission} to ${user.email}. Direct permissions: ${(user.adminPermissions ?? []).join(', ')}`
  );
  if (!user.isAdmin && permission === 'credits:approve_self_grant') {
    console.log('They also need support:read to open the Approvals tab.');
  }
  return 0;
}

main()
  .then(exitCode => process.exit(exitCode))
  .catch((error: unknown) => {
    console.error(error);
    process.exit(1);
  });
