---
title: Feedbacks
description: Managing user feedback submissions in the Bike4Mind admin panel
sidebar_position: 4
tags: [admin, feedback, support]
---

# Feedbacks

The Feedbacks tab provides a centralized interface for reviewing, triaging, and managing user-submitted feedback. Administrators can search, filter by status and organization, update feedback status, delete entries, and export data to CSV.

## Control Panel

The feedback control panel provides all filtering and action controls in a single card at the top of the view.

### Search

The search input filters feedback by matching against the **username** or **content** of feedback entries. Results update as you type.

### Status Filters

Feedback status is managed through three checkbox filters that can be combined:

| Status | Default | Description |
|--------|---------|-------------|
| **New** | Checked | Newly submitted feedback that has not been triaged |
| **In Progress** | Unchecked | Feedback that is being actively addressed |
| **Closed** | Unchecked | Feedback that has been resolved or dismissed |

By default, only **New** feedback is shown. Toggle any combination of checkboxes to view multiple statuses simultaneously. Feedback items are sorted by status order (New first, then In Progress, then Closed), with date sorting applied within each status group.

### Organization Filter

A multi-select dropdown filters feedback by the submitting user's organization:

- **All** - Shows feedback from all organizations (default when no specific selection is made)
- Individual organization names extracted from the feedback data

Multiple organizations can be selected at the same time.

### Sorting

Click the **Created At** column header to toggle between ascending and descending date order. The default sort order is descending (newest first). Sorting is applied within each status group -- New items appear first, followed by In Progress, then Closed, regardless of sort direction.

## Feedback List

Each feedback entry is displayed as a card row with the following columns:

| Column | Width | Description |
|--------|-------|-------------|
| **Created At** | ~16% | Timestamp in `Mon DD, YYYY HH:MM AM/PM` format with relative time (e.g., "2 days ago"). Tags associated with the feedback are shown as green chips below the date. |
| **Reporter** | ~21% | Organization name (bold), username, and email with tooltip showing the user ID |
| **Feedback** | ~46% | The feedback content, displayed with preserved whitespace and word wrapping. Scrollable if content exceeds 80px height. |
| **Actions** | ~17% | Status dropdown and delete button |

### Header Row

A sticky header row labels each column. The **Created At** header is clickable and toggles the sort direction, displaying an up or down arrow to indicate the current order.

## Actions

### Update Status

Each feedback entry has a dropdown that allows changing the status:

| Status | Description |
|--------|-------------|
| **New** | Initial state for incoming feedback |
| **In Progress** | Feedback is being investigated or worked on |
| **Closed** | Feedback has been addressed or dismissed |

Changing the status triggers an immediate API update. A toast notification confirms the change, showing a preview of the feedback content and the reporter's information.

### Delete Feedback

The delete button (trash icon) on each feedback entry initiates deletion. A confirmation modal appears with the message "Are you sure you want to delete the feedback?" before the deletion is executed. Upon successful deletion, a toast notification confirms the action with a preview of the deleted content.

### Refresh

The **Refresh** button reloads all feedback data from the server. It is disabled while data is loading.

### Export CSV

The **Export** button generates a CSV file containing all currently filtered and sorted feedback entries. The exported file is named `feedback_YYYY-MM-DD.csv` with the current date. The CSV uses the `papaparse` library for generation.

Exported columns:

| Column | Description |
|--------|-------------|
| ID | Feedback document ID |
| Status | Current status (New, In Progress, Closed) |
| Username | Submitting user's username |
| Content | Full feedback text |
| Organization | User's organization |
| UpdatedAt | Last update timestamp |

The Export button is disabled when there is no feedback matching the current filters.

## Pagination

Pagination controls appear above the feedback list:

| Setting | Details |
|---------|---------|
| Items per page | 20 (fixed) |
| Navigation | Previous / Next buttons with current page and total pages |
| Total count | Displayed as "Total Feedback: N" reflecting the filtered count |

## Best Practices

- Keep the **New** status filter checked to ensure incoming feedback is not missed.
- Regularly review and triage feedback by updating statuses from New to In Progress as items are being addressed.
- Use the organization filter when investigating feedback patterns specific to a particular customer or team.
- Export feedback to CSV before closing out a sprint or support cycle to maintain records.
- Use the search function to find feedback related to specific features or issues by searching for keywords in the content.
- Avoid deleting feedback unless it is spam or duplicate -- prefer closing feedback to maintain a historical record.

---

## Related Articles

- [Admin Dashboard Overview](./overview.md) - Overall admin panel navigation
- [User Management](./user-management.md) - Managing the users who submitted feedback
- [Analytics](./analytics.md) - Platform usage analytics
