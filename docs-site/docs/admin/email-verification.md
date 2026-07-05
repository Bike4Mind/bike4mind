---
title: Email Verification
description: Managing email verification status for users in the Bike4Mind admin panel
sidebar_position: 3
tags: [admin, email, verification]
---

# Email Verification

The Email Verification tab allows administrators to monitor and manage the email verification status of all users on the platform. From this tab, you can view verification states, resend verification emails, manually verify or unverify users, and manage pending email change requests.

## Overview

The tab displays a table of users with their email verification details. It supports search, status filtering, pagination, and bulk actions. All actions require confirmation through a modal dialog before execution.

## Search and Filtering

### Search

The search input supports finding users by username, email, or name. Search is debounced to reduce unnecessary API calls while typing.

### Status Filter

A dropdown filter narrows the user list by verification status:

| Filter Value | Description |
|-------------|-------------|
| **All Users** | Shows all users regardless of verification status |
| **Verified** | Shows only users whose email has been verified |
| **Unverified** | Shows only users who have not yet verified their email |
| **Pending Verification** | Shows users who have been sent a verification email but have not yet confirmed |

## User Table

The table displays the following columns:

| Column | Description |
|--------|-------------|
| **Username** | The user's login username |
| **Email** | Current email address. If a pending email change exists, the new email is shown below with an arrow indicator |
| **Name** | The user's display name |
| **Status** | Color-coded chip indicating the current state (see Status Indicators below) |
| **Verified At** | Date and time the email was verified, or `-` if not yet verified |
| **Last Sent** | Date and time the last verification email was sent |
| **Expires** | Expiration date of the verification token, or a warning indicator if expired |
| **Actions** | Context-sensitive action buttons |

## Status Indicators

The status column uses color-coded chips to indicate the user's current verification state:

| Status | Color | Condition |
|--------|-------|-----------|
| **Verified** | Green | Email has been successfully verified |
| **Pending** | Yellow (warning) | Verification email sent but not yet confirmed, token still valid |
| **Expired** | Red (danger) | Verification email was sent but the token has expired |
| **Not Sent** | Gray (neutral) | No verification email has been sent to this user |
| **Changing Email** | Blue (primary) | User has a pending email change request |

## Actions

The available actions depend on the user's current verification state:

### For Unverified Users

| Action | Description |
|--------|-------------|
| **Verify** | Manually mark the email as verified without requiring the user to click a verification link |
| **Resend** | Send a new verification email to the user's current email address |

### For Verified Users

| Action | Description |
|--------|-------------|
| **Unverify** | Revoke the verified status, requiring the user to verify their email again |

### For Users with Pending Email Changes

| Action | Description |
|--------|-------------|
| **Resend Change** | Resend the email change verification to the user's pending new email address |

## Confirmation Modal

All actions trigger a confirmation modal before execution. The modal displays:

- The action being performed (Resend, Verify, Unverify, or Resend Email Change)
- The affected user's email and username
- For unverify actions, a warning that the user will need to verify again
- Cancel and confirm buttons (the confirm button uses danger styling for unverify actions)

## Pagination

Pagination controls appear above and below the table:

| Setting | Values |
|---------|--------|
| Items per page | 10, 20 (default), 50 |
| Navigation | Previous / Next buttons with current page and total pages |
| Total count | Displayed as "Total Users: N" |

## Refresh

The **Refresh** button reloads the verification data from the server. It is disabled while data is being fetched.

## Error Handling

When an action fails, the error message from the backend is displayed as a toast notification. The data is automatically refreshed after an error to reflect any backend state changes (such as an expired token being automatically cancelled).

## Best Practices

- Use the **Pending Verification** filter to identify users who may need a reminder or manual verification.
- Check the **Expires** column before resending -- if a token is still valid and not expired, consider waiting before resending.
- Use **manual verification** sparingly and only for cases where the user cannot receive email (such as email delivery issues).
- The **Unverify** action should be used cautiously, as it requires the user to go through the verification process again.
- Monitor the **Changing Email** status to ensure email change requests are completing successfully.

---

## Related Articles

- [Admin Dashboard Overview](./overview.md) - Overall admin panel navigation
- [User Management](./user-management.md) - Full user administration
