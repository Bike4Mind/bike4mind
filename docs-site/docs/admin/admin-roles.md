---
title: Admin Roles
description: Named bundles of delegated admin permissions, how they combine with direct grants, and how to add a template
sidebar_position: 3.5
tags: [admin, permissions, security]
---

# Admin Roles

An admin role is a named set of [delegated admin permissions](./delegated-permissions.md), such as "Support agent" or "Billing". Give a role to several admins instead of granting the same permissions one account at a time. When you change a role's permissions, every admin holding it gets the change.

## How roles combine with direct grants

An admin's effective permissions are their direct permissions plus the permissions of every role they hold.

- Roles only add access. A role never removes a permission granted directly or by another role.
- Full admin access is never a role. A role can hold delegated permissions only, so full admin is still granted and removed with **Change role** on the user's profile.
- A full administrator already holds every permission except `credits:self_grant` and `credits:approve_self_grant`, so a role on a full admin's account adds nothing. Grant those two to a full admin directly.
- If an account still lists a role that was deleted, that role grants nothing.

## Templates

Open **Admin > Roles** and choose **Create from a template** to start from one of these. Creating a role from a template copies the template's name, description and permissions into an ordinary role that you can edit freely.

| Template            | Permissions                                     |
| ------------------- | ----------------------------------------------- |
| Support (read-only) | `support:read`                                  |
| Support agent       | `support:read`, `users:moderate`                |
| Billing             | `support:read`, `credits:adjust`                |
| Trust & Safety      | `support:read`, `users:moderate`, `keys:revoke` |
| Platform settings   | `settings:manage`, `models:curate`              |

`users:delete`, `users:impersonate` and `users:export` are in no template. Grant them directly, or add them to a custom role, only when an admin needs them.

## Managing roles

- Only a full administrator can create, edit or delete a role, and only a full administrator can give a role to a user or take it away. Holding `settings:manage` is not enough.
- Adding `credits:self_grant` or `credits:approve_self_grant` to a role, or giving such a role to a user, also needs you to hold that permission yourself, and every account that would gain it must be on the deployment's senior granter list. See [Credit grants to your own account](./delegated-permissions.md#credit-grants-to-your-own-account).
- Give or remove roles on the user's profile, in the same editor as their delegated permissions. See [Granting permissions](./delegated-permissions.md#granting-permissions).
- Changing a role's permissions requires a reason. The audit log records the permissions granted and revoked, the reason, and how many members the change reached.
- A role that still has members cannot be deleted. Remove it from each member first, so deleting a role never takes access away from anyone silently.

## Roles in the access review

The quarterly access review (**Admin > Access review**) shows where each admin's access comes from:

- A **Roles** column lists the roles each admin holds. A deleted role still listed on an account shows as **Deleted role**.
- The **Permissions** column lists each effective permission with its source, for example `users:moderate - direct + role "Support agent"`.
- An **Admin roles** table lists every role with its permissions and members, including roles with no members.
- The CSV export adds `directPermissions`, `roles` and `permissionSources` columns to each admin row. After a blank row, a role section lists each role with its permissions and members. A past quarter's export leaves out the role section, because today's roles would not describe that quarter.

Revoking an admin's access from the review removes their direct permissions and every role they hold, and the review record keeps the names the roles had when they were removed. A role that was already deleted at that point is recorded as a deleted role.

## Adding a template (contributors and self-hosters)

Templates are defined in `ADMIN_ROLE_TEMPLATES` in `b4m-core/common/src/adminRoles.ts`. To add one, append an entry with a stable `id`, a `name`, a one-line `description`, and the `permissions` it starts with:

```ts
{
  id: 'content-curator',
  name: 'Content curator',
  description: 'Support lookups plus curating the model list.',
  permissions: ['support:read', 'models:curate'],
},
```

- `permissions` must be delegated permission IDs; the list is type-checked against them.
- Templates are copied when a role is created. Editing or removing a template never changes a role that already exists.
- Keep the template table on this page in step with the list.
