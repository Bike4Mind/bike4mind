---
title: Delegated Admin Permissions
description: How delegated admin permissions work, their current coverage, and full-admin rules
sidebar_position: 3
tags: [admin, permissions, security]
---

# Delegated Admin Permissions

A delegated admin holds one or more named permissions instead of full admin access. API routes check the permission declared for each HTTP method. Console access is separate: a delegated admin can enter only when a tab supports one of their permissions, and sees only those tabs. See [Console tabs](#console-tabs) for the current list.

Full administrators (the legacy `isAdmin` flag) have every permission implicitly except `credits:self_grant` and `credits:approve_self_grant`. Account-action safeguards still apply, including the role-change rules below.

## Permissions

The table gives examples of current route coverage. A permission does not automatically unlock every operation in its category.

| Permission | Current coverage |
|------------|------------------|
| `support:read` | Read admin reporting, audit, approval, security, and settings pages, and internal notes (see [Support reads](#support-reads)) |
| `credits:adjust` | Manage signup grants, credit grants, organization credits and seats, and subscriptions, including Stripe cancel and resume; reset a data lake's embedding spend meter |
| `users:moderate` | Suspend, restrict, and limit regular accounts; edit a regular account's name and username (changing its email also needs `users:impersonate`), and sign it out of a single session; manage abuse response, email verification, signup risk, published pages, internal notes, and organization membership |
| `users:impersonate` | Start Login as User (MFA required), change a regular account's email together with `users:moderate`, and view a user's support access history |
| `keys:revoke` | Revoke or restore a user's API keys, revoke all of them, and change API key trust. Rotating a key or generating one for a user also needs `users:impersonate`, because the response is a working secret. API keys with admin-provisioned scopes can only be generated, or such a scope granted on an existing key, by a full administrator |
| `users:delete` | Schedule or cancel account deletion |
| `users:export` | Request and download a data subject export of a user's account (step-up verification required) |
| `settings:manage` | Edit admin settings, manage tags and modals, configure Slack workspaces and start a Slack app install, manage partner signup rules, and recalculate a user's storage usage |
| `models:curate` | Publish curated model catalog versions |
| `credits:self_grant` | Add credits to your own account, or an organization you belong to, without a second admin approving (see [Credit grants to your own account](#credit-grants-to-your-own-account)). Super Admin does not include it |
| `credits:approve_self_grant` | Approve credits another admin adds to their own account, or an organization they belong to. Super Admin does not include it |

Permissions are enforced per route. `users:delete`, `users:export`, `models:curate`, `support:read`, `credits:adjust`, `users:moderate`, and `settings:manage` are enforced by `adminApi` middleware on their routes. `users:impersonate` and `keys:revoke` are enforced the same way. Listing a user's API keys needs `support:read`.

Neither permission lets a delegate log in as an account with admin access or change or issue its API keys: only a full administrator can do those. Impersonating an account with admin access also needs a second administrator's approval when approvals are enabled. Per-key rate limits require `users:moderate` and the same target safeguard.

Legacy user profile edits and balance adjustments require full admin access. The user-update API accepts only moderation fields from a `users:moderate` delegate. Bulk APIs check each action's permission, including at undo time; credit actions still need `credits:adjust`, key revocation needs `keys:revoke`, and blocking signup domains also needs `settings:manage`. The Users list, its summary and CSV export, and a user's activity, timeline, sign-ins, sessions, linked accounts, compliance, risk evidence, and signup cluster accept `support:read` or `users:moderate`. The Users console page itself remains full-admin-only.

## Support reads

`support:read` is read-only. Routes declare it on `GET` only, with two reviewed exceptions whose handlers make their own check: deciding an approval also needs the permission the approval names, and signing off an audit entry needs full admin access.

It covers the read side of:

- Reporting: analytics (including cross-organization event aggregates), revenue, spend, usage, model metrics and logs, event metrics, help analytics, and retrieval rate.
- Oversight: the audit log, approvals, webhook and integration audit logs, published-page reports, Stripe disputes, and shadow detections.
- Operations: the cross-user app file list, stuck agent executions, the dead-letter queue list and history, integration health and demand, and QA runs.
- Security: the security dashboard, including firewall traffic and blocked requests.
- Configuration: system prompts, tool definitions, gears, email templates and campaigns, OAuth clients, partner signup rules, voice agents, and the GitHub connection.

Firewall reads run metered cloud queries, and some GitHub reads call the GitHub API. They stay on `support:read` and are rate-limited per user.

A page whose edits need `settings:manage` also opens to `settings:manage` alone for reading, so a settings manager does not need `support:read` to see what they edit. This applies to tool definitions, gears, and stuck agent executions. `settings:manage` does not imply `support:read` anywhere else.

## Credit and subscription access

Credit, grant, and subscription reads accept either `support:read` or `credits:adjust`. Writes require `credits:adjust`. Subscription actions and the Held signup grants release button are disabled when you hold only `support:read`. Revenue trend charts and the approvals queue still require `support:read`; credit permission alone does not open them.

As a credit delegate, you cannot change your own account, an account with admin access, or an organization you belong to. This includes organizations you own, administer, or have joined. Full administrators retain their existing action-specific self-target checks. Grants above the configured approval threshold require a different approver with `credits:adjust`.

### Credit grants to your own account

When a full administrator adds credits to their own account, or to an organization they own, administer, bill for, or have joined, the grant waits for another admin to approve it under **Approvals**. This applies to credit adjustments, subscription grants, organization grants, and top-ups, whether or not approvals are turned on and whatever the approval threshold. You see "Submitted for approval" instead of a new balance.

- Only an admin who holds `credits:approve_self_grant` can approve it. They do not need to be a Super Admin, and a Super Admin without the permission cannot approve. To see the **Approvals** tab they also need `support:read`. You cannot approve your own request.
- Super Admins do not hold `credits:approve_self_grant` by default, so they see held self-grant requests redacted and cannot approve or reject them. If no admin holds it, a request waits until it expires.
- An adjustment held for approval must be sent on its own. Make any other profile change separately.
- On an organization profile, editing the balance up for an organization you belong to is refused. Use **Top up** instead, so the grant can be approved.
- On a subscription of an organization you belong to, raising or clearing the per-cycle credit override is refused. Only lowering an existing override is allowed.
- Removing credits from your own account does not need approval.
- An admin who holds `credits:self_grant` skips the approval. Super Admin does not include this permission: it must be granted to each admin who needs it.
- Only an admin who holds `credits:self_grant` or `credits:approve_self_grant` can grant or revoke that permission, directly or through a role. A Super Admin who does not hold it cannot hand it out.

To give a deployment its first holder of either permission, an operator with database access runs:

```bash
pnpm db:grant-explicit-admin-permission <email> credits:approve_self_grant
```

The script writes no audit entry, so use it only for the first holders and grant the rest from the admin console.

A holder can grant `credits:approve_self_grant` to another account they control, which could then approve their requests, so grant it only to people you trust as a second check.

Every grant to your own account, approved or exempt, is recorded in the audit log and flagged as a self-grant.

Organization and user-profile tabs still require full admin access. Their delegated credit operations are available through their permission-gated APIs, while the Subscriptions and Held signup grants tabs provide the supported console entry points.

## Console tabs

| Tab                                                                                                                                   | Opens with                          |
| ------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------- |
| Modals                                                                                                                                | `settings:manage`                   |
| Retrieval, Webhook logs, Help analytics, API key scopes, Integration demand, Audit log, Approvals, Stripe disputes, Shadow detections | `support:read`                      |
| Subscriptions                                                                                                                         | `support:read` or `credits:adjust`  |
| Held signup grants                                                                                                                    | `credits:adjust`                    |
| Tools, Gears, Stuck executions                                                                                                        | `support:read` or `settings:manage` |
| Email verification, Signup domain holds, Signup risk review, Rate limits, Published pages                                             | `support:read` or `users:moderate`  |

Other tabs require full admin access. Inside an open tab, an action the delegate cannot perform is disabled and names the permission it needs, such as "Missing permission: users:moderate". A detail page under a tab the delegate cannot open, such as a user profile, shows "Full admin access required" in place of the page.

## Full-admin-only actions

Some actions have no delegated permission yet and require full admin access:

- Creating an organization, or adding an existing user to an organization directly.
- Editing an organization's credit balance through the organization edit form. Use the permission-gated credit APIs instead.
- Adding, editing, importing, or deleting business links and their categories.
- Giving a skill global read or write access, and reviewing legacy global skills.
- Reviewing new signups and exporting the full user list from the user list API.
- Reading admin-only help articles, in the help center and in help chat.
- Adding or removing an account tag, grant package tag or default tag that a data lake uses as its access gate.

## Admin roles

An admin role is a named set of delegated permissions that you give to several admins at once. An admin's effective permissions are their direct permissions plus the permissions of every role they hold; roles only add access and never include full admin. See [Admin Roles](./admin-roles.md) for templates, management rules and how roles appear in the access review.

## Granting permissions

To grant or revoke delegated permissions or [admin roles](./admin-roles.md), open the user's profile. On **Overview**, the **Access** card lists the user's **Admin permissions**. Choose **Edit**, select the permissions the user should hold, enter a reason, and confirm. You may be asked to verify your identity again before the change is saved.

- Only a full administrator can change delegated permissions. Holding `settings:manage` does not let a delegate grant permissions.
- You cannot change your own permissions.
- A Super Admin already holds every permission except `credits:self_grant` and `credits:approve_self_grant`, so those are the only permissions you can grant or revoke for one. Change their role to limit their access.
- You can grant or revoke `credits:self_grant` or `credits:approve_self_grant`, directly or through a role, only if you hold it yourself.
- Every grant and revocation is recorded in the audit log with the reason, and the permissions before and after.
- If someone else changed the user's permissions while your editor was open, saving fails and asks you to reload the profile. Reload, review the current permissions, and try again.

To change full admin access, open the user's profile and choose **More > Change role** (also available from Overview). Select **Super Admin** to grant it, or another role to remove it, enter a reason, and confirm. Only a full administrator can make this change. You cannot change your own role or demote the last Super Admin.

## Full administrators

A full administrator is a user whose `isAdmin` flag is set. This is the legacy admin model. A full admin:

- Has every permission except `credits:self_grant` and `credits:approve_self_grant` implicitly, without it being listed in `adminPermissions`.
- Can act on other admins, subject to each action's safeguards.
- Can grant or revoke another user's full-admin flag, subject to role-change safeguards.

The platform refuses to demote the last Super Admin, whoever asks. When the target is the sole `isAdmin: true` user, the request returns an error regardless of the caller's role. Full admins also cannot change their own role.

Holding every explicit permission is not the same as being a full admin. A user with every explicit permission is still a delegated admin.

## Acting on admin accounts

On routes using `assertCanActOnAdminTarget`, delegated admins cannot act on users who themselves have admin access. For example, a delegated admin with `settings:manage` can change a regular user's free-form tags but cannot change another admin's tags. The error message is: "Only full administrators can [action] users with admin access".

Routes that call `assertCanActOnAdminTarget` enforce this guard: deletion scheduling and cancellation, tag changes, internal-mark changes, and signup grant actions (blocking, unblocking, releasing held or remaining signup credits, and revoking a held grant release). Moderation updates, email-verification actions, per-key rate limits, and published-page takedown or restore enforce the same safeguard. Bulk cohorts exclude admin-access targets for delegates, and undo re-checks each target before restoring it. A full administrator is not subject to this particular restriction.

## Declaring a permission on an admin route

A route using `adminApi` declares which permission each HTTP method requires. The middleware checks the caller's permissions before the handler runs. A route that does not declare at least one permission is rejected when initialized.

```ts
import { adminApi } from '@server/middlewares/adminApi';

export default adminApi({
  adminPermissions: {
    GET: 'support:read',
    PATCH: 'settings:manage',
  },
})
  .get(async (_req, res) => {
    res.status(200).json({ status: 'ok' });
  })
  .patch(async (_req, res) => {
    res.status(204).end();
  });
```

A `HEAD` request uses the `GET` permission unless the route declares a separate `HEAD` entry. API keys must include the `admin` scope to call an `adminApi` route, regardless of the user's permissions.

## Troubleshooting

If the admin entry or a tab is missing, check [Console tabs](#console-tabs); holding a permission does not by itself grant console access. An API response of `Missing permission: ...` names the permission required for that method. API keys also need the `admin` scope, and routes configured as session-only require a signed-in browser session.

## Existing references

- [User Management](./user-management.md) describes the internal-notes permission requirements (`support:read` to read, `users:moderate` to write) and the tags permission (`settings:manage`).
