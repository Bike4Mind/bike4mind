---
title: Feedback
description: Managing user feedback submissions in the Bike4Mind admin panel
sidebar_position: 4
tags: [admin, feedback, support]
---

# Feedback

The Feedback tab provides a centralized interface for reviewing, triaging, and managing user-submitted feedback. Administrators can search, filter by status and organization, update feedback status, delete entries, and export data to CSV.

## Control Panel

The feedback control panel provides all filtering and action controls in a single card at the top of the view.

### Search

The search input filters feedback by matching against the **username**, **email**, or **content** of feedback entries. Matching runs on the server across every report, not just the page on screen, and the request is sent shortly after you stop typing rather than on each keystroke. Report text older than 90 days is automatically deleted (see Data Retention below), so search will no longer match on the content of an expired report.

### Status Filters

Feedback status is managed through three checkbox filters that can be combined:

| Status | Default | Description |
|--------|---------|-------------|
| **New** | Checked | Newly submitted feedback that has not been triaged |
| **In Progress** | Unchecked | Feedback that is being actively addressed |
| **Closed** | Unchecked | Feedback that has been resolved or dismissed |

By default, only **New** feedback is shown. Toggle any combination of checkboxes to view multiple statuses simultaneously. Unchecking every box shows nothing rather than everything.

Within the selected statuses, reports are ordered purely by date -- there is no longer a New-before-In-Progress-before-Closed grouping. Ordering by a computed status rank cannot use the database's date indexes, which is what made the list slow to page; if you want to work one status at a time, filter to it.

### Organization Filter

A multi-select dropdown filters feedback by the submitting user's organization:

- Selecting nothing shows feedback from all organizations (the default)
- Individual organization names, taken from every report you can see

Multiple organizations can be selected at the same time. The list of available organizations is not narrowed by the filter itself, so selecting one does not remove the others from the dropdown.

### Sorting

Click the **Created At** column header to toggle between ascending and descending date order. The default sort order is descending (newest first). Sorting is by date alone and is applied across the whole filtered set on the server, so it reorders every match rather than just the rows currently on screen.

## Feedback List

Each feedback entry is displayed as a card row with the following columns:

| Column | Width | Description |
|--------|-------|-------------|
| **Created At** | ~16% | Timestamp in `Mon DD, YYYY HH:MM AM/PM` format with relative time (e.g., "2 days ago"). Tags associated with the feedback are shown as green chips below the date. |
| **Reporter** | ~21% | Organization name (bold), username, and email with tooltip showing the user ID |
| **Feedback** | ~46% | The feedback content, displayed with preserved whitespace and word wrapping. Scrollable if content exceeds 80px height. A **Truncated** chip appears if the original submission was cut down to the length cap, and expired content (see Data Retention below) renders as `[content expired]`. |
| **Actions** | ~17% | Status dropdown, deep-link buttons (see Deep Links below), and delete button |

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

### Deep Links

Two buttons on each row link out of the list:

| Button | What it does |
|--------|--------------|
| **Copy link to this report** (link icon) | Copies an absolute URL that reopens this tab with the one report pinned above the list. Safe to paste into a ticket or chat. |
| **Open the conversation** (forum icon) | Opens the session the report came from in a new tab, scrolled to the turn it was filed against. Shown only for a report attached to a session. |

A copied link pins its report in a card above the list whether or not it matches your current
filters or page; dismiss the card to return to the plain list, or expect the "no longer available"
notice if the report has since been deleted. In a very long conversation the jump may land on the
newest message first and reach the highlighted turn as older history loads.

### Refresh

The **Refresh** button reloads all feedback data from the server. It is disabled while data is loading.

### Export CSV

The **Export** button generates a CSV file containing every feedback entry matching the current filters -- not just the page on screen. Large result sets are capped at 5,000 rows; when the cap is hit, a toast says so explicitly rather than handing you a short file that looks complete. The exported file is named `feedback_YYYY-MM-DD.csv` with the current date. The CSV uses the `papaparse` library for generation.

Exported columns:

| Column | Description |
|--------|-------------|
| ID | Feedback document ID |
| Status | Current status (New, In Progress, Closed) |
| Username | Submitting user's username |
| Content | Feedback text, or `[content expired]` once the report is past the 90-day retention window (see Data Retention below) |
| Organization | User's organization |
| UpdatedAt | Last update timestamp |

The Export button is disabled when there is no feedback matching the current filters.

## Pagination

Pagination controls appear above the feedback list:

| Setting | Details |
|---------|---------|
| Items per page | Selectable: 10, 20, 50, or 100 (defaults to 20) |
| Navigation | Previous / Next buttons with current page and total pages |
| Total count | Displayed as "Total Feedback: N", the server-side count of every report matching the filters |

## Data Retention

Feedback text is **automatically deleted 90 days after submission**. The structured record (status, reporter, organization, tags, timestamps) is kept permanently; only the free-text content expires. Once a report's text has been deleted, the list and CSV export both show `[content expired]` in its place, and it will no longer match a content search.

## Best Practices

- Keep the **New** status filter checked to ensure incoming feedback is not missed. Leaving every status unchecked shows an empty list, not all reports.
- Use the conversation link when triaging a confusing report -- reading the turn it was filed against is usually faster than asking the reporter.
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
