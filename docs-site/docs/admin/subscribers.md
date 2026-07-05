---
title: Subscribers
description: Manage waitlist subscribers and generate personalized invite codes with custom resource allocations
sidebar_position: 8
tags: [admin, subscribers, waitlist]
---

# Subscribers

The Subscribers tab provides a management interface for people who have signed up for the Bike4Mind waitlist. Administrators can review subscriber requests, generate personalized invite codes with custom credit and storage allocations, and send welcome emails directly from this panel.

## Waiting Subscribers Notification

When there are subscribers waiting for invite codes, a dismissible warning banner appears at the top of the tab. The banner shows the exact count of waiting subscribers (e.g., "There are 5 subscribers waiting for invite codes."). This notification can be dismissed for the current session by clicking the close button.

## Search and Refresh

The header section includes:

| Control | Description |
|---------|-------------|
| **Search** | A text input to filter subscribers by name or email. Search is debounced to avoid excessive API calls while typing. |
| **Refresh** | Reloads the subscriber list from the server. |

## Subscriber Table

The subscriber list is displayed in a table with the following columns:

| Column | Description |
|--------|-------------|
| **Name** | The subscriber's first and last name. |
| **Email** | The subscriber's email address. |
| **Date** | The date the subscriber signed up for the waitlist. |
| **Status** | A chip indicator showing either "Waiting" (neutral) or "Invite Sent" (green/success). |
| **Actions** | Action buttons for generating invites and deleting subscribers. |

## Actions

Each subscriber row provides two actions:

| Action | Description |
|--------|-------------|
| **Generate Invite** | Opens a modal to create a personalized invite code for the subscriber. This button is disabled once an invite has already been generated. |
| **Delete** | Removes the subscriber from the waitlist after a browser confirmation dialog. |

## Generate Invite Modal

When generating an invite for a subscriber, a modal dialog opens with the following fields:

| Field | Default | Description |
|-------|---------|-------------|
| **Starting Credits (Tokens)** | 500 | The number of credits to grant the new user upon registration. Adjustable in increments of 100. |
| **Starting Storage** | 1000 MB | The amount of storage space to allocate to the new user. Adjustable in increments of 100 MB. |
| **Email Message** | Default welcome message | An optional custom email body to send with the invite. If left blank, a default welcome message is used that includes the credit and storage information. |

Upon clicking **Generate & Send Invite**, the system creates an invite code, associates it with the subscriber, and sends an email with the code and welcome message. A success confirmation is displayed before the modal automatically closes.

## Pagination

Pagination controls appear above and below the subscriber table:

- **Previous / Next** buttons for page navigation
- **Page indicator** showing "Page X of Y"
- **Items per page** selector with options: 5, 10, or 20 per page
- **Total Items** count displayed alongside the pagination controls

## Best Practices

- Monitor the waiting subscribers notification banner regularly to ensure timely responses to new signups.
- Customize the starting credits and storage based on the subscriber's use case or any promotional campaigns.
- Use the custom email message field for personalized onboarding when reaching out to specific subscribers.
- After generating an invite, verify the subscriber's status changes to "Invite Sent" in the table.

## Related Articles

- [Invite Codes](./invite-codes.md)
- [Bulk Import](./bulk-import.md)
