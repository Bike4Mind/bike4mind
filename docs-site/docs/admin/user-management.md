---
title: User Management
description: Comprehensive guide to managing users in the Bike4Mind admin panel
sidebar_position: 2
tags: [admin, users, management]
---

# User Management

The Users tab is the primary interface for administering user accounts on the Bike4Mind platform. It is a single server-driven table with search, filters, built-in views, column sorting, grouping by email domain, and CSV export. The header shows the total number of accounts and how many were active this week.

The view, filters, sort, grouping, page, and page size are kept in the URL, so reloading the page or sharing the link restores the same list. The search text is not put in the URL, because it often holds an email address.

## Search

The search box at the top of the Users tab finds users by name, username, email, or user ID. Search is debounced to avoid excessive API calls while typing, and it returns to page 1. Press `/` anywhere in the admin panel to focus it.

## Views

The tabs above the table are built-in views. Each one clears the filters and applies its own:

| View | Shows |
|------|-------|
| **All** (default) | Every user |
| **New this week** | Users who signed up in the last 7 days |
| **High risk** | Users whose signup risk assessment is high |
| **Suspended** | Banned users |

Each tab shows its count. If you set filters by hand that match a view exactly, that view's tab is highlighted.

### Saved views

To keep a combination of filters, sort, page size and grouping, click **Save view** and give it a name. The view appears as its own tab after the built-in ones and is stored on the server, so it follows you to any device. Tick **Share with all admins** to show it to every admin; only you can change or delete it.

Each saved tab you own has a **...** menu with **Rename**, **Share with all admins** (or **Make personal**) and **Delete**. Opening a saved view always starts at page 1. You can keep up to 50 views.

## Signup risk review

Open **Risk review** in the admin sidebar to review accounts flagged by signup risk scoring.
AI access is automatically held while a review is pending, including free models and AI requests
through API keys. These users can still sign in and access their existing data. The AI refusal
message directs them to contact support to request a review.

Choose **Approve** for a legitimate account to lift its signup review hold. Approval does not
remove a separate manual AI restriction or suspension. **Undo**, available for 30 seconds,
restores the review hold. Later rescores update the evidence but never clear a pending hold or
overturn an approval. Choose **Suspend** for an abusive account to block account access.

Existing pending reviews also hold AI access. If an approved user still cannot use AI, check for
separate restrictions, suspension, and normal plan or credit limits. Signup-domain credit holds
are independent of account risk reviews.

## Columns

| Column | Details |
|--------|---------|
| User | Avatar, name (or username or email), and email |
| Status | **Suspended** (banned), **Restricted** (moderated), **New** (recently created), or **Active** |
| Plan | User level |
| Signed up | Account creation date |
| Last active | Most recent activity |
| Credits | Current credit balance |
| 30d spend | Credits spent in the last 30 days |
| API keys | Number of live API keys |
| Risk | Signup risk band: High, Medium, or Low |

Click a row to open the user's [profile page](#user-profile-page). The row's **...** menu has **Open profile** and **Copy user ID**; using it does not open the row.

### Selecting rows

Use the checkboxes to select rows. Shift-click selects a range, and `x` toggles the focused row. Changing a filter, the view, or the search clears the selection; moving between pages keeps it. Once every row on the page is selected, **Select all N matching** extends the selection to every user that matches the current filters.

### Bulk actions

While rows are selected, a bar under the table offers these actions (on a narrow screen they sit in one **Actions** menu):

| Action | Effect |
|--------|--------|
| **Suspend** | Blocks sign-in, ends live sessions and disables their API keys |
| **Restrict** | Turns off AI features; users can still sign in and reach their data |
| **Adjust credits** | Sets, adds or removes credits; every change is written to the credit ledger |
| **Revoke API keys** | Disables every active API key the users own |
| **Add tag** | Adds a tag to users who do not have it yet |
| **Contain** | Suspends the users, sets their credits to 0 and revokes their API keys, together for each user. Optionally also blocks new signups from their email domains |

Each action opens a dialog with a dry run: how many users will change, who is excluded (you and other admins are never included), and how many API keys and credits are affected. A reason is required and is recorded in the audit log for every user.

- A batch is limited to 500 users. If more match, narrow the filters first.
- **Block email domains** (Contain only) adds the users' email domains to the blocked email domains setting before any user is changed. The dry run lists every domain it would block and the ones already blocked. Well-known public mail domains such as gmail.com are skipped, but the list is not exhaustive, so check the domains before you confirm. It needs permission to edit admin settings.
- If the matching users change between the dry run and the confirm, nothing is applied and the dialog shows the new count to confirm again.
- After a bulk action, an **Undo** button is shown for 30 seconds. It restores the whole batch and unblocks the email domains the batch added (domains that were already blocked stay blocked). Sessions that were ended stay ended.

### Recent activity

The **Recent activity** button shows a panel of recent user activity across the platform.

## User Profile Page

Each user has a full-page profile at `/admin/users/<userId>`, opened by clicking the user's row in the Users tab or **Open profile** in the row menu. It is admin-only, like the rest of the admin panel. The **Users** button at the top returns to the Users tab.

The header shows the user's name, email, avatar, account status, user level, organization, signup method, and created and last-active dates. **Adjust credits** and **Suspend** are quick actions; **More** contains the other account actions.

To edit the user's name or email, open **More > Edit profile**. The username is displayed read-only. Change the fields in the modal and click **Save Changes**. Wait for the success notification before closing the modal; the profile header refreshes after a successful save. If saving fails, keep the modal open, correct any validation error, and retry.

The page has six tabs. The selected tab is kept in the URL, for example `?tab=activity` or `?tab=admin` (Overview is the default and has no parameter), so a link can open a specific tab.

| Tab | Contents |
|-----|----------|
| **Overview** | Account details, access, subscription, recent activity, and internal notes |
| **Activity** | The user's recent activity |
| **Credits** | Credit ledger and spending |
| **API keys** | The user's API keys |
| **Sign-ins** | Sign-in history and sessions |
| **Admin log** | Administrative actions recorded for the user |

Use **More** for role, product-access, subscription, compliance, restriction, and deletion actions (see [Admin Actions](#admin-actions-ban-moderate-delete)).

Old links of the form `/admin?userId=<userId>` redirect to the user's profile page. An unknown or malformed user id shows **User not found**; any other loading error shows a retry button.

## Risk flags

Under the profile statistics, named risk badges show activity that needs a closer look.
Click a badge to see its rule, the exact UTC window, and the counts or values behind it.
There is no combined risk score, and a flag does not automatically restrict the account.

| Badge | Rule |
|-------|------|
| **Repeated failed sign-ins** | At least 5 failed identity checks or blocked sessions in 24 hours. Failed passwords are not included in this audit source. |
| **New IP or device** | A successful sign-in in the last 7 days uses an IP or browser and operating system combination absent from earlier retained successful sign-ins. At least 3 earlier successes are required. |
| **Credit spend spike** | Spending over the current UTC day and 6 previous days reaches 3 times the preceding 30-day average rate. The baseline needs at least 7 active days and 100 credits, and recent spend must reach 200 credits. |
| **Prior moderation** | At least 1 image moderation incident in 30 days, excluding incidents reviewed as false positives. |

For sign-in flags, **View in timeline** opens the Activity tab filtered to sign-ins
and the UTC calendar days covering the evidence window. **View credits** opens
the Credits tab for a spend spike. **Open compliance** opens the moderation history.
Sign-in comparisons use retained audit history, so they cannot establish whether an
address or device appeared before that history.

**No risk flags** means none of these rules fired. It does not establish that the account
is safe or that every kind of sign-in failure was recorded. If the flags cannot be loaded,
use **Try again**; a read failure is shown separately from an empty result. Access requires
an administrator session; API keys cannot read the IP evidence.

## Internal notes and profile tags

On a user's profile, **Overview > Internal notes** stores plain-text support context.
Reading requires `support:read`; adding, editing, and deleting require
`users:moderate`. Full administrators have both permissions. Notes show their
original author and time, and **View history** shows attributed revisions.
Deletion hides a note while retaining its history; the Undo notification restores
it. Legacy inline notes remain visible but read-only. Impersonated sessions cannot
write notes.

In **Access > Tags > Edit**, add or remove free-form tags with suggestions from
existing tags. Saving requires `settings:manage`. Tags are limited to 100 distinct
values of 1 to 64 characters. Role and product-access grants use their dedicated
actions and cannot be changed through the free-form tag editor. Successful saves
refresh the user list and tag filters. Activity and Admin log record note actions
without note bodies, and tag actions with before/after values.

If the notes card is missing, check the signed-in administrator's `support:read`
permission. Use **Reload notes** or **Reload history** after a read failure. A stale
note version or tag snapshot is rejected: reload the profile and reapply the change
to the current state. If a tag is too long or duplicates another tag, correct it
before saving.

## Filtering

Click **Filter** to add a filter chip. Each chip shows its current value; click it to change the value, or remove it. **Clear filters** removes them all.

| Filter | Values |
|--------|--------|
| Status | Active, Suspended, Restricted |
| Plan | DemoUser, PaidUser, VIPUser, ManagerUser, AdminUser |
| Risk | High, Medium, Low (users with no risk assessment match none of these) |
| Signed up | Last hour, day, week, or month |
| Sign-in method | Email, Google, GitHub, Facebook, Okta, SAML |
| Email verified | Verified, Not verified |
| API keys | Has keys, No keys |
| Organization | One or more organizations, or **No organization** |
| Tags | One or more tags, including **Admin** for super admins |

The **Signed up** column shows the first provider linked to the account, or Email when none is linked. The **Sign-in method** filter matches any linked provider, and Email matches only accounts with no linked provider. An account created with an email code that later linked Google shows as Google, and appears under the Google filter but not Email.

Filters are applied on the server, so they cover every user, not just the current page. Changing a filter returns to page 1.

## Grouping by email domain

Set **Group by** to **Email domain** to list users under a header per email domain, with the user count for each. **Show only this domain** on a header filters the list to that domain (subdomains included).

## Sorting

Click the **User**, **Signed up**, **Last active**, or **Credits** column header to sort by it; click again to reverse the order. The default is **Signed up**, newest first. Changing the sort returns to page 1.

## Pagination

The footer below the table shows the range of rows on the page (for example "1 to 25 of 1,234"), a **Rows per page** selector (25, 50, or 100; 25 is the default), and previous and next page buttons.

## Creating a User

Click the **Create User** button to open the Create User modal. The form is organized into three sections:

### Basic Information

| Field | Required | Description |
|-------|----------|-------------|
| Username | Yes | Unique username for login |
| Email | Yes | Must contain `@` |
| Full Name | Yes | Display name |

### User Settings

| Field | Default | Description |
|-------|---------|-------------|
| User Level | DemoUser | One of: DemoUser, PaidUser, VIPUser, ManagerUser, AdminUser |
| Admin Privileges | Unchecked | Grants admin access; automatically linked to the "Admin" tag |
| User Tags | Required (at least 1) | Determines which models are available to the user. For external users, the "Customer" tag is recommended |

### Resources

| Field | Default | Description |
|-------|---------|-------------|
| Initial Credits | 10,000 | Starting credit balance |
| Storage Limit | 1,000 MB | Maximum storage allocation |

The form requires all basic fields to be filled and at least one tag selected before submission is allowed.

## Editing a User

In **Full** view mode, user fields can be edited inline. Changed fields are highlighted, and an **Update** button appears in the user card header when changes are detected. Changes are saved via the API when the Update button is clicked.

Available editable fields include:

- Name, username, email
- Admin status and user level
- User tags (predefined and custom)
- Ban and moderation status
- Storage limit and credits
- Subscription details

### Login as User

The user profile page header has a **Login as User** button that allows an admin to impersonate the selected user for debugging purposes.

### Send System Message

The **Send Message** button opens a modal to send a system message directly to the user.

## User Authentication

Bike4Mind uses passwordless email authentication. When a user logs in, a one-time code (OTC) is sent to their registered email address — no password is required. Ensure the user's email address on file is correct and that the email service is functioning (see **Admin → General Ops → System Health**).

## User Permissions

The **Roles** section on the profile page's Overview tab provides:

| Control | Description |
|---------|-------------|
| **User Level** | Button that cycles through levels: DemoUser, PaidUser, VIPUser, ManagerUser, AdminUser. Color-coded by level. |
| **Super Admin** | Checkbox to grant or revoke admin privileges |
| **Predefined Tags** | Checkboxes for system-defined tags |
| **Custom Tags** | Text input to add comma-separated custom tags, with remove buttons for each custom tag |

## Admin Actions (Ban, Moderate, Delete)

Destructive user operations live in the **Danger zone** on the Admin tab of the user profile page:

| Action | Description |
|--------|-------------|
| **Ban** | Checkbox toggle. Bans the user without deleting their account. |
| **Moderate** | Checkbox toggle. Moderated users cannot use AI features. |
| **Delete** | Requires typing "DELETE" in a text field, then clicking the Delete button. A confirmation modal appears before the deletion is executed. This action cannot be undone. Deleting from the profile page returns you to the Users tab. |
| **Compliance** | Opens the user's compliance details. |

Ban and moderation changes are staged like any other field. When you click **Update** with a ban or moderation change pending, a confirmation dialog names the change before anything is saved; **Cancel** saves nothing.

## Export

The **Export CSV** button exports all users matching the current search and filter criteria as a CSV file named `users.csv`. The CSV includes the following columns:

| Column | Description |
|--------|-------------|
| Name | User's display name |
| Organization | Organization name |
| Username | Login username |
| Email | Email address |
| Logins | Total number of logins |
| Last Login | Timestamp of most recent login |
| Created At | Account creation timestamp |
| Is Admin | Yes/No |
| Is Banned | Yes/No |

The export includes all matching users, not just the current page, up to 15,000 rows. If the export hits that cap, a warning asks you to narrow the filters to export the rest.

## Best Practices

- Use the list for quick scanning and the user's profile page for detailed administration.
- When creating external users, assign the **Customer** tag to provide appropriate model access.
- Prefer **banning** over **deleting** users to preserve audit trails. Deletion is permanent.
- Always confirm the environment banner color before performing destructive actions like user deletion.
- Use **Export CSV** to maintain offline records of user lists before making bulk changes.
- Use organization and tag filters together to narrow down to specific user cohorts.
- Review user permissions regularly and grant only the minimum necessary access.
- Notify users before making major changes to their accounts.

## Common Tasks

### Upgrading a User

1. Open the user's profile page by clicking their row.
2. Click the **User Level** button to cycle through levels (DemoUser, PaidUser, VIPUser, ManagerUser, AdminUser).
3. Alternatively, add specific permission tags for fine-grained access control.
4. Click **Update** to save changes.

### Handling Support Requests

1. Use **Login as User** to reproduce the issue in the user's environment.
2. Check the user's activity, login history, and account status for clues.
3. Document findings and resolution steps.
4. Use **Send Message** to communicate the resolution to the user.

### Managing Subscriptions

1. Use **Grant Subscription** in the User Details section for manual extensions.
2. Check both Individual and Team subscription status in the Subscription section.
3. Monitor credit usage for unusual patterns via the Credits field.
4. Manually adjust credits if necessary.

## Troubleshooting

### User Cannot Log In

- Check if the account is **banned** or **moderated** in the Admin Actions section.
- Verify the email address is correct — the one-time code is sent to the email on file.
- **If the Email field is blank**, the account has no email on file and *cannot* receive a one-time
  code. This is a supported account shape: an account created through a social/OAuth provider that
  did not assert the email as verified is stored without one. That user signs in through the same
  provider they signed up with, not by email code. To move them onto email login, have them add an
  address from **Profile > Email Address > Add Email** and confirm the verification link.
- Confirm the email service is working via **Admin → General Ops → System Health**.
- Check the user's login history for suspicious activity.

### Missing Features

- Verify the **User Level** is appropriate for the features they need.
- Check **organization membership** — some features require org association.
- Review **user tags** for required permissions (e.g., "Developer" tag for API access).

### Credit Issues

- Check the current credit balance in the B4M Settings section.
- Review the credit purchase date for recent activity.
- Manually adjust credits if a billing discrepancy is confirmed.

## Security Notes

- All administrative actions are logged for audit purposes.
- Login uses one-time codes delivered to the user's registered email — codes are time-limited and single-use.
- Login history tracks device and location information to help identify suspicious activity.
- Regular security audits of user permissions are recommended.

---

## Related Articles

- [Admin Dashboard Overview](./overview.md) - Overall admin panel navigation
- [Email Verification](./email-verification.md) - Managing email verification status
- [User Migration](./user-migration.md) - Bulk user migration
- [Analytics](./analytics.md) - User activity analytics
