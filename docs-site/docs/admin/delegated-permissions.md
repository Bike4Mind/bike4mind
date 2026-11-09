---
title: Delegated Admin Permissions
description: How delegated admin permissions work, what each permission covers, and how to grant them
sidebar_position: 3
tags: [admin, permissions, security]
---

# Delegated Admin Permissions

A delegated admin holds one or more named permissions instead of full admin access. Each permission unlocks a specific set of admin features. A user with at least one permission can sign in to the admin panel and see the tabs their permissions allow; everything else is hidden.

Full administrators (the legacy `isAdmin` flag) have every permission implicitly and are not subject to the restrictions below.

## Permissions

| Permission | What it covers |
|------------|----------------|
| `support:read` | Read-only access to user profiles, activity, sign-in history, internal notes, and the admin log |
| `credits:adjust` | View and adjust a user's credit balance and view the credit ledger |
| `users:moderate` | Ban, restrict, and contain users; write and delete internal notes on user profiles |
| `users:impersonate` | Sign in as another user for debugging (Login as User) |
| `keys:revoke` | Revoke a user's API keys |
| `users:delete` | Permanently delete a user account |
| `settings:manage` | Edit admin settings, manage tags, configure Slack workspaces, and manage partner signup rules |
| `models:curate` | Publish curated model catalog versions |

Not every permission has a route that declares it yet. `users:delete`, `models:curate`, and the core admin tab permissions (`support:read`, `credits:adjust`, `users:moderate`, `settings:manage`) are enforced by `adminApi` middleware on their routes. `users:impersonate` and `keys:revoke` are defined in the permission list but not yet declared on an `adminApi` route; those flows still require the legacy full-admin flag.

A permission grants only the actions listed. For example, `credits:adjust` lets you change a credit balance but not ban the user; that requires `users:moderate`.

## Granting permissions

The code defines the grant rules in `assertCanGrantAdminAccess`, but the grant UI and endpoint are not wired up yet. Today, only the full-admin flag (Super Admin) can be toggled from a user's profile. Until the grant flow lands:

- A full administrator can set or remove the Super Admin flag.
- Delegated permissions are assigned directly in the database.

Once the grant endpoint is available, the intended constraints are:

- A full administrator can grant any combination of permissions, including the full-admin flag.
- A delegated admin with `settings:manage` can grant permissions, but only the ones they already hold. They cannot grant the full-admin flag.
- A delegated admin cannot change the permissions of another user who has admin access (full or delegated). Only a full administrator can edit, demote, or remove an admin account.

## Full administrators

A full administrator is a user whose `isAdmin` flag is set. This is the legacy admin model. A full admin:

- Has every permission implicitly without being listed in `adminPermissions`.
- Can act on any user, including other admins.
- Can grant or revoke the full-admin flag.
- The platform refuses to demote the last Super Admin, whoever asks. When the target is the sole `isAdmin: true` user, the request returns an error regardless of the caller's role.

Holding every explicit permission is not the same as being a full admin. A user with all eight permissions is still a delegated admin and is still subject to the restrictions above.

## Acting on admin accounts

Delegated admins cannot perform actions on users who themselves have admin access. For example, a delegated admin with `users:moderate` can ban a regular user but cannot ban another admin. The error message is: "Only full administrators can [action] users with admin access."

Routes that call `assertCanActOnAdminTarget` enforce this guard today: deletion scheduling and cancellation, tag changes, internal-mark changes, and signup grant actions. A full administrator is not subject to this restriction.

## Declaring a permission on an admin route

Every admin API route declares which permission each HTTP method requires. The middleware checks the caller's permissions before the handler runs. A route that does not declare at least one permission is rejected at startup.

```ts
export default adminApi({
  adminPermissions: {
    GET: 'support:read',
    PATCH: 'settings:manage',
  },
  handler: async (req, res) => {
    // ...
  },
});
```

A `HEAD` request uses the `GET` permission unless the route declares a separate `HEAD` entry. API keys must include the `admin` scope to call any admin route, regardless of the user's permissions.

## Existing references

- [User Management](./user-management.md) describes the internal-notes permission requirements (`support:read` to read, `users:moderate` to write) and the tags permission (`settings:manage`).
