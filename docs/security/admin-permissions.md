# Admin permissions

The admin console supports explicit permissions on individual users. Existing users
with `isAdmin: true` retain all permissions; no backfill is required. Delegated
permissions do not change end-user abilities or organization roles.

| Permission          | Access                                                                |
| ------------------- | --------------------------------------------------------------------- |
| `support:read`      | Read support data in the Users view and ordinary admin read endpoints |
| `credits:adjust`    | Adjust credits and administer billing operations                      |
| `users:moderate`    | Ban or moderate users                                                 |
| `users:impersonate` | Start an impersonation session                                        |
| `keys:revoke`       | Revoke access keys                                                    |
| `users:delete`      | Delete users                                                          |
| `settings:manage`   | Change operational settings and manage admin permissions              |

To delegate user administration, include `support:read` so the operator can open
the Users view, then add the specific action permissions they need. Permissions
are independent: granting a write permission does not grant support read access.
User profile updates and deletion also require `support:read` because their
responses include user details.
Treat `settings:manage` as privileged because its holder can grant permissions.

Open **Admin > Users**, open a user's full details, and use the admin permissions
editor to save the desired grants with a reason. Permission changes record the
actor, target, before and after state, and reason in the admin audit log. The
legacy full-admin flag can also be managed there. The final full admin cannot be
demoted or deleted, including when concurrent requests attempt those operations.
Creating a full administrator also requires a reason. Assigning positive starting
credits during account creation requires `credits:adjust` in addition to the
creation permission.
Delegated operators cannot impersonate administrator accounts or introduce login
blocks on them; those operations require a full administrator.

## Troubleshooting

- **Missing permission: X**: the action requires the named grant. Ask an operator
  with `settings:manage` to review your access. A support-only operator cannot
  write, even by calling the endpoint directly.
- **Admin entry or tab absent**: at least one recognized admin permission is
  required to enter the console; individual tabs require their own permission.
- **API key denied despite user grants**: admin routes require the API key's
  admin scope in addition to user grants. The release-note automation endpoints
  retain their dedicated `release-notes:write` credential path.
- **Final full admin cannot be removed**: first grant full access to another
  account. Both the legacy flag and the complete explicit permission set count
  as full access.

## Adding admin routes

Use `adminApi` from `@server/middlewares/adminApi` and declare a named permission
for each HTTP method in `adminPermissions`. Keep API-key scope checks and other
existing authorization checks. Credential-only ingestion or recovery routes use
their own authentication and must be explicitly covered by the route-inventory
test. New authenticated admin routes without declarations fail that test.

Use `hasAdminPermission` from `@bike4mind/common` for client affordances and server
checks. Do not infer admin permissions from tags or `User.role`. Permission
mutations must use the audited permissions endpoint rather than general profile
updates.

The transaction ledger and session-usage read endpoints also serve organization
owners. Their explicit read-only owner authorization remains scoped to the
owner's organization; it does not grant access to the admin console.
