---
title: User Management
description: Comprehensive guide to managing users in the Bike4Mind admin panel
sidebar_position: 2
tags: [admin, users, management]
---

# User Management

The Users tab is the primary interface for administering user accounts on the Bike4Mind platform. It provides search, filtering, multiple display modes, inline editing, and bulk export capabilities. User management state (search terms, pagination, sort preferences, and filters) is persisted across sessions via local storage.

## Search

The search bar at the top of the Users tab allows you to find users by name, username, or email. Search is debounced to avoid excessive API calls while typing. When a search term is entered, the results automatically reset to page 1.

## Display Modes

The Users tab supports four distinct view modes, selectable from the **View Mode** dropdown:

| Mode | Description |
|------|-------------|
| **Slim** (default) | Compact table view showing Name, User ID, Email, Logins, Storage usage bar, Security (MFA status), Recent Activity, and action buttons |
| **Full** | Expanded card view with inline editing for all user fields, organized into sections: User Details, Permissions, Subscription, B4M Settings, Admin Actions, and Activity & Profile |
| **User Journey** | Chronological view of a user's lifecycle on the platform |
| **Recent Activity** | Focused view of recent user activity across the platform |

### Slim View Columns

| Column | Details |
|--------|---------|
| Name | Truncated to 15 characters with tooltip for full name |
| User ID | Monospaced font, displayed in a compact format |
| Email | Full email address |
| Logins | Login count indicator |
| Storage | Progress bar showing used vs. allocated storage with percentage and color coding (green/yellow/red based on usage threshold) |
| Security | MFA status badge |
| Recent Activity | Latest activity timestamp and action name |
| Actions | "Admin" button to open the full user view modal, plus a profile button |

### Full View Sections

Each user card in Full view contains the following sections:

| Section | Contents |
|---------|----------|
| **User Details** | Editable fields for name, username, email, and other profile information |
| **Permissions** | User level button (cycles through DemoUser, PaidUser, VIPUser, ManagerUser, AdminUser), Super Admin checkbox, predefined user tags, and custom tag input |
| **Subscription** | Current subscription status and details |
| **B4M Settings** | Platform-specific settings including credits, storage limit, and referral availability |
| **Admin Actions** | Ban, Moderate, and Delete user controls |
| **Activity & Profile** | Login details and admin profile view |

## Filtering

### Organization Filter

A multi-select dropdown for filtering users by organization. Options include:

- **All** - Shows users from all organizations (default)
- **Unassigned** - Shows users not assigned to any organization
- Individual organizations listed from the system

Multiple organizations can be selected simultaneously. Selecting "All" clears other selections.

### Tag Filter

A multi-select dropdown for filtering users by tags. Available tags include:

- **Admin** - Always present as a predefined tag
- **Predefined User Tags** - System-defined tags imported from `@bike4mind/common`
- **Custom Tags** - Additional tags retrieved from the API

Multiple tags can be selected to narrow results.

## Sorting

| Control | Options |
|---------|---------|
| **Sort By** | `Created At` (default), `Name` |
| **Order** | Toggle button switching between `A -> Z` (ascending) and `Z -> A` (descending) |

Changing the sort field or order resets to page 1.

## Pagination

Pagination controls appear both above and below the user list. Options include:

| Setting | Values |
|---------|--------|
| Items per page | 5, 10 (default), 20 |
| Navigation | Previous / Next buttons with current page and total pages display |
| Total count | Displayed as "Total Users: N" |

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

The Full view includes a **Login as User** button that allows an admin to impersonate the selected user for debugging purposes.

### Send System Message

The **Send Message** button opens a modal to send a system message directly to the user.

## User Authentication

Bike4Mind uses passwordless email authentication. When a user logs in, a one-time code (OTC) is sent to their registered email address — no password is required. Ensure the user's email address on file is correct and that the email service is functioning (see **Admin → General Ops → System Health**).

## User Permissions

The Permissions section in Full view provides:

| Control | Description |
|---------|-------------|
| **User Level** | Button that cycles through levels: DemoUser, PaidUser, VIPUser, ManagerUser, AdminUser. Color-coded by level. |
| **Super Admin** | Checkbox to grant or revoke admin privileges |
| **Predefined Tags** | Checkboxes for system-defined tags |
| **Custom Tags** | Text input to add comma-separated custom tags, with remove buttons for each custom tag |

## Admin Actions (Ban, Moderate, Delete)

The Admin Actions section provides destructive user operations:

| Action | Description |
|--------|-------------|
| **Ban** | Checkbox toggle. Bans the user without deleting their account. |
| **Moderate** | Checkbox toggle. Moderated users cannot use AI features. |
| **Delete** | Requires typing "DELETE" in a text field, then clicking the Delete button. A confirmation modal appears before the deletion is executed. This action cannot be undone. |

## Export

The **Download** button exports all users matching the current search and filter criteria as a CSV file named `users.csv`. The CSV includes the following columns:

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

The export fetches all matching users (not just the current page) before generating the CSV.

## Best Practices

- Use **Slim** view for quick scanning and **Full** view for detailed user administration.
- When creating external users, assign the **Customer** tag to provide appropriate model access.
- Prefer **banning** over **deleting** users to preserve audit trails. Deletion is permanent.
- Always confirm the environment banner color before performing destructive actions like user deletion.
- Use the **Download** feature to maintain offline records of user lists before making bulk changes.
- Use organization and tag filters together to narrow down to specific user cohorts.
- Review user permissions regularly and grant only the minimum necessary access.
- Notify users before making major changes to their accounts.

## Common Tasks

### Upgrading a User

1. Switch to **Full** view mode to access inline editing.
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
