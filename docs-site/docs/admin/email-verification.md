---
title: Email Verification
description: Managing email verification status for users in the Bike4Mind admin panel
sidebar_position: 3
tags: [admin, email, verification]
---

# Email Verification

The Email Verification tab allows administrators to monitor and manage the email verification status of all users on the platform. From this tab, you can view verification states, resend verification emails, manually verify or unverify users, and manage pending email change requests.

## Overview

The tab displays a table of users with their email verification details. It supports search, status filtering, pagination, and bulk actions. The page opens with the title **Email verification** and the number of matching users, with a help button and **Refresh** on the right. Verify and unverify open a dialog that asks for a reason; resending a link applies at once.

## Search and Filtering

### Search

The search input supports finding users by username, email, or name. Search is debounced to reduce unnecessary API calls while typing.

### Status Filter

The **Status** filter chip, next to the search box, narrows the user list by verification status. While it is unset, all users are shown regardless of verification status. Its menu offers:

| Filter Value | Description |
|-------------|-------------|
| **Verified** | Shows only users whose email has been verified |
| **Unverified** | Shows only users who have not yet verified their email |
| **Pending verification** | Shows users who have been sent a verification email but have not yet confirmed |

The filter applies as soon as you pick a value; there is no Apply button. Click the x on the chip to clear it. Changing the search or the status returns the list to its first page.

## User Table

The table displays the following columns:

| Column | Description |
|--------|-------------|
| **User** | The user's login username, their display name below it, and the user ID as a short chip (for example `690078...0001`). Click the chip to copy the full ID. |
| **Email** | Current email address, shortened with an ellipsis when it is too long for the column. If a pending email change exists, the new email is shown below with an arrow indicator. Blank for an account created through an OAuth provider that did not assert a verified email - that account has no email on file and signs in through its provider |
| **Status** | Status chip indicating the current state (see Status Indicators below) |
| **Verified** | Date and time the email was verified, or a dash if not yet verified |
| **Last sent** | Date and time the last verification email was sent, or a dash |
| **Link expires** | Expiration date and time of the verification link, or **Expired** with the date once it has passed |

The last cell of each row holds a **...** button that opens the row's actions (see Actions below). On a narrow window the table keeps its columns and scrolls sideways inside its own frame instead of squeezing them.

## Status Indicators

The status column uses status chips to indicate the user's current verification state:

| Status | Color | Condition |
|--------|-------|-----------|
| **Verified** | Green | Email has been successfully verified |
| **Pending** | Amber | Verification email sent but not yet confirmed, token still valid |
| **Expired** | Red | Verification email was sent but the token has expired |
| **Not sent** | Gray | No verification email has been sent to this user |
| **Changing email** | Indigo | User has a pending email change request |

## Actions

Open a row's menu (**...**) to see its actions. The available actions depend on the user's current verification state:

### For Unverified Users

| Action | Description |
|--------|-------------|
| **Verify email** | Manually mark the email as verified without requiring the user to click a verification link |
| **Resend verification email** | Send a new verification email to the user's current email address |

### For Verified Users

| Action | Description |
|--------|-------------|
| **Unverify email** | Revoke the verified status, requiring the user to verify their email again |

### For Users with Pending Email Changes

| Action | Description |
|--------|-------------|
| **Resend email change link** | Resend the email change verification to the user's pending new email address |

## Verify and Unverify Dialog

**Verify email** and **Unverify email** open a dialog before anything changes. The dialog displays:

- The action being performed (Verify email or Unverify email)
- The affected user's email and username
- For unverify, a note that the user will have to verify the address again
- A reason: pick a preset (Ownership confirmed by support, Bounced or invalid address, Internal testing) or write a note of at least 5 characters. The reason is recorded with the change.
- Cancel and confirm buttons (the confirm button is red for unverify)

## Resending Links

**Resend verification email** and **Resend email change link** apply as soon as you pick them, with no confirmation step, and a toast confirms the send. While a send is in progress, the same item in that row's menu is disabled and reads **Sending verification email** or **Sending email change link**, so a second click cannot send twice.

## Pagination

The table has one pager, in its footer:

| Setting | Values |
|---------|--------|
| Rows per page | 25 (default), 50, 100 |
| Navigation | Previous and next arrow buttons |
| Range | Displayed as "1 to 25 of N", where N is the number of matching users (also shown beside the page title) |

While the next page loads, the current rows stay on screen.

## Refresh

The **Refresh** button in the page header reloads the verification data from the server. It is disabled while data is being fetched. If the list fails to load, a **Try again** button appears in place of the rows.

## Error Handling

When an action fails, the error message from the backend is displayed as a toast notification. The data is automatically refreshed after an error to reflect any backend state changes (such as an expired token being automatically cancelled).

## Best Practices

- Use the **Pending verification** filter to identify users who may need a reminder or manual verification.
- Check the **Link expires** column before resending -- if a token is still valid and not expired, consider waiting before resending.
- Use **manual verification** sparingly and only for cases where the user cannot receive email (such as email delivery issues).
- The **Unverify** action should be used cautiously, as it requires the user to go through the verification process again.
- Monitor the **Changing Email** status to ensure email change requests are completing successfully.

---

## Related Articles

- [Admin Dashboard Overview](./overview.md) - Overall admin panel navigation
- [User Management](./user-management.md) - Full user administration
