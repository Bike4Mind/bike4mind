---
title: User Migration
description: Bulk migrating users into the Bike4Mind platform via the admin panel
sidebar_position: 5
tags: [admin, migration, users]
---

# User Migration

The Migration tab provides a tool for bulk importing users into the Bike4Mind platform. This tab is conditionally available and only appears when the `enableUserMigration` feature flag is active. When migration is enabled and the admin panel opens to the Users tab, it automatically redirects to the Migration tab.

## Availability

The Migration tab is controlled by the `enableUserMigration` prop passed to the Admin Page component. When this flag is not set:

- The Migration tab does not appear in the sidebar navigation
- The tab panel is not rendered in the main content area
- The admin panel defaults to the Users tab as normal

## Migration Workflow

The migration process follows a multi-step workflow:

### Step 1: Configure Options

Before entering user data, configure the migration settings:

| Option | Default | Description |
|--------|---------|-------------|
| **Send Email to Users** | Unchecked | When checked, a welcome email with a one-time login link is sent to each migrated user. When unchecked, no emails are sent and the admin must share account details with users directly. |

A "Migration Tutorial" button is available that navigates to `/developer/migration` for detailed guidance.

### Step 2: Enter User Data

Enter user information in the text area using a comma-separated format with one user per line:

```
Full Name, email@example.com
Another User, another@example.com
```

Each line must follow the `name, email` format where:
- The name can contain spaces and special characters
- The email must be a valid email address format

### Step 3: Parse User List

Click the **Parse User List** button to validate the entered data. The parser:

- Splits the text by newlines
- Validates each line against the `name, email` pattern using a regex
- If all lines are valid, displays the parsed users in a scrollable card list showing name and email
- If any line is invalid, displays an error message: "The data entered does not match the given format"

### Step 4: Select Organization (Optional)

Use the organization selector to optionally assign all migrated users to a specific organization. When an organization is selected:

- A warning message confirms: "Users will be added to the selected organization"
- The system checks whether adding the new users would exceed the organization's seat limit
- If the seat limit would be exceeded, a warning is displayed and the migration is blocked until seats are increased

### Step 5: Execute Migration

Click the **Migrate Users** button to execute the migration. This button is disabled when:

- No users have been parsed
- The parsed data contains errors
- The organization seat limit would be exceeded
- A migration is already in progress (shows loading state)

### Step 6: Review Results

After successful migration, a modal displays the results:

| Column | Description |
|--------|-------------|
| **Name** | The migrated user's name |
| **Email** | The migrated user's email address |

When emails are not sent, users will need to log in via the standard OTC flow using their registered email address. A **Copy CSV** button copies all results to the clipboard in CSV format (Name, Email) for offline record-keeping.

## Organization Seat Validation

When an organization is selected, the migration tool calculates whether the existing user count plus the number of users being migrated exceeds the organization's total seat allocation. If it would exceed the limit, the **Migrate Users** button is disabled and a warning is shown.

## Best Practices

- Always **parse the user list** before executing migration to catch formatting errors early.
- When not sending emails, export the results CSV and share account details with users directly — they can log in via the OTC flow using their registered email.
- Check the organization's available seats before migrating a large batch of users into an organization.
- Use the **Migration Tutorial** link for first-time setup guidance.
- For large migrations, consider breaking them into smaller batches to make result review more manageable.
- When sending invitation emails, confirm that the email service is functioning correctly before migrating a large batch.

---

## Related Articles

- [Admin Dashboard Overview](./overview.md) - Overall admin panel navigation
- [User Management](./user-management.md) - Managing individual user accounts after migration
