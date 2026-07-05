---
title: Invite Codes
description: Create, manage, and track registration invite codes for controlling user access to the platform
sidebar_position: 7
tags: [admin, invites, registration]
---

# Invite Codes

The Invite Codes tab allows administrators to create and manage registration invite codes that control access to the Bike4Mind platform. Invite codes can be single-use or unlimited-use, and their lifecycle is tracked from creation through redemption.

## Tab Layout

The interface is organized into two tabs that separate invite codes by their current availability:

| Tab | Description |
|-----|-------------|
| **Available** | Invite codes that have not yet been used (or unlimited-use codes that have not expired). Displayed with a green left-border accent. |
| **Used** | Invite codes that have been redeemed or have expired. Displayed with a gray left-border accent. |

Each tab shows a count of its items in the tab label (e.g., "Available (12)" / "Used (5)").

## Creating Invite Codes

Click the **Create** button to open the creation modal. The modal provides the following options:

| Field | Description |
|-------|-------------|
| **Number of Invites** | How many invite codes to generate in a single batch. Must be at least 1. |
| **Allow unlimited use** | When checked, the invite code can be reused by multiple people. Unlimited-use invites automatically expire 90 days after creation. Single-use invites do not automatically expire. |

After submission, the new codes appear in the Available tab.

## Invite Table Columns

Each invite code row displays the following information:

| Column | Description |
|--------|-------------|
| **Code** | The unique invite code string. Click to copy to clipboard. A tooltip confirms when copied. |
| **Created By** | The admin user who generated the code. |
| **Created At** | Timestamp of when the code was created. Sortable in ascending or descending order by clicking the column header. |
| **Status** | Current status of the invite code: `open`, `waiting`, `used`, or `expired` (for unlimited-use codes past their expiry date). Unlimited-use codes display an infinity icon with a tooltip showing the expiry date. |
| **Used by** | For single-use codes, shows the user who redeemed the code. For unlimited-use codes, shows a clickable count (e.g., "3 use/s") that expands to reveal the full usage history with usernames and timestamps. |
| **Actions** | Per-row action buttons for status changes and deletion. |

## Per-Row Actions

Each invite code row has individual action buttons:

| Action | Icon | Description |
|--------|------|-------------|
| **Set Open** | Circle | Sets the invite status to `open` |
| **Set Waiting** | Hourglass | Sets the invite status to `waiting` |
| **Set Used** | Collapse | Sets the invite status to `used` |
| **Delete** | Trash | Permanently deletes the invite code |

## Multi-Select and Bulk Operations

Invite codes can be selected individually via their checkboxes, or all codes in the current tab can be selected using the header checkbox. When one or more codes are selected, a bulk action toolbar appears with the following operations:

| Bulk Action | Description |
|-------------|-------------|
| **Set Multiple Open** | Changes all selected invites to `open` status |
| **Set Multiple Waiting** | Changes all selected invites to `waiting` status |
| **Set Multiple Used** | Changes all selected invites to `used` status |
| **Delete Multiple** | Deletes all selected invites after confirmation |

Bulk delete triggers a confirmation modal that displays the number of selected invites and requires explicit confirmation before proceeding.

## Pagination

Pagination controls appear above and below the invite table with the following options:

- **Previous / Next** buttons for page navigation
- **Page indicator** showing "Page X of Y"
- **Items per page** selector with options: 5, 10, or 20 per page

## Additional Controls

| Control | Description |
|---------|-------------|
| **Refresh** | Reloads the invite codes list from the server |
| **Create** | Opens the batch creation modal |

## Best Practices

- Use single-use invite codes for individual invitations to maintain a clear audit trail of who used which code.
- Use unlimited-use invite codes for events or campaigns where multiple signups are expected within a limited time window. These automatically expire after 90 days.
- Regularly review the Used tab to track adoption and clean up old codes.
- Use bulk operations to efficiently manage large numbers of invite codes at once.

## Related Articles

- [Subscribers](./subscribers.md)
- [Bulk Import](./bulk-import.md)
