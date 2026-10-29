---
title: Waitlist
description: Manage people on the waitlist and generate personalized invite codes with custom resource allocations
sidebar_position: 8
tags: [admin, waitlist]
---

# Waitlist

The Waitlist tab (under People in the admin sidebar) provides a management interface for people who have signed up for the Bike4Mind waitlist. Administrators can review waitlist requests, generate personalized invite codes with custom credit and storage allocations, and send welcome emails directly from this panel.

## Waiting Notification

When people on the waitlist are waiting for an invite, a dismissible warning banner appears at the top of the tab. The banner shows the exact count (e.g., "There are 5 people on the waitlist waiting for an invite."). This notification can be dismissed for the current session by clicking the close button.

## Search and Refresh

The header section includes:

| Control | Description |
|---------|-------------|
| **Search** | A text input to filter the waitlist by name or email. Search is debounced to avoid excessive API calls while typing. |
| **Refresh** | Reloads the waitlist from the server. |

## Waitlist Table

The waitlist is displayed in a table with the following columns:

| Column | Description |
|--------|-------------|
| **Name** | The person's first and last name. |
| **Email** | The person's email address. |
| **Date** | The date the person signed up for the waitlist. |
| **Status** | A chip indicator showing either "Waiting" (neutral) or "Invite Sent" (green/success). |
| **Actions** | Action buttons for generating invites and removing people from the waitlist. |

## Actions

Each row provides two actions:

| Action | Description |
|--------|-------------|
| **Generate Invite** | Opens a dialog to create a personalized invite code for the person. This button is disabled once an invite has already been generated. |
| **Delete** | Removes the person from the waitlist after a browser confirmation dialog. |

## Generate Invite Dialog

When generating an invite, a dialog opens with a required reason (choose a preset such as "Approved from the waitlist queue" and add an optional note; the reason is not recorded yet) and the following fields:

| Field | Default | Description |
|-------|---------|-------------|
| **Starting credits** | 500 | The number of credits to grant the new user upon registration. Adjustable in increments of 100. |
| **Starting storage** | 1000 MB | The amount of storage space to allocate to the new user. Adjustable in increments of 100 MB. |
| **Email message** | Default welcome message | An optional custom email body to send with the invite. If left blank, a default welcome message is used that includes the credit and storage information. |

Upon clicking **Generate and send invite**, the system creates an invite code, associates it with the person, and sends an email with the code and welcome message. On success, the dialog closes and a confirmation toast appears. If the invite code is generated but the email fails to send, the dialog stays open and shows the code so you can copy it and share it another way.

## Pagination

Pagination controls appear above and below the waitlist table:

- **Previous / Next** buttons for page navigation
- **Page indicator** showing "Page X of Y"
- **Items per page** selector with options: 5, 10, or 20 per page
- **Total Items** count displayed alongside the pagination controls

## Best Practices

- Monitor the waiting notification banner regularly to ensure timely responses to new signups.
- Customize the starting credits and storage based on the person's use case or any promotional campaigns.
- Use the custom email message field for personalized onboarding when reaching out to specific people.
- After generating an invite, verify the person's status changes to "Invite Sent" in the table.

## Related Articles

- [Invite Codes](./invite-codes.md)
- [Bulk Import](./bulk-import.md)
