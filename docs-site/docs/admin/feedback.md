---
title: Feedback
description: Managing user feedback submissions in the Bike4Mind admin panel
sidebar_position: 4
tags: [admin, feedback, support]
---

# Feedback

The Feedback tab provides a centralized interface for reviewing, triaging, and managing user-submitted feedback. Administrators can search, filter by subject, status and organization, update feedback status, delete entries, and export data to CSV.

## Where Feedback Comes From

| Surface | Tags | What it is about |
|---------|------|------------------|
| Help modal | `feedback`, `cs` | The product in general |
| Bug report modal | `bug`, `feedback`, `bugReport` | One answer, with its diagnostic snapshot attached |
| `/feedback <message>` in the chat composer | `feedback`, `slash-command` | The conversation as a whole |
| Help article feedback | -- | One help article, identified by its slug |
| Help chat feedback | -- | One help-chat answer |

A `/feedback` report is filed against the **session**, not a single turn. The newest turn in that session at the moment of writing is recorded separately as context, so a reader can see where the user was when they wrote it without the report being mistaken for a verdict on that one answer.

Help-center comments are written by readers in the help article and help chat panels. Only the
comment itself becomes a feedback report; what the reader *did* -- views, searches, the thumbs
rating, the "report outdated" flag -- stays in the help event store. The comment text follows the
same 90-day retention as every other report (see Data Retention below); the article slug and the
"outdated" flag are copied onto the report itself and are kept permanently, so an expired report
still says which article it was about. Each of these reports carries a **help context chip** in the
list showing the surface it came from, the article slug where there is one, and the "outdated" flag
if the reader set one, so it can be triaged without opening it. The thumbs verdict is the report's
own type (Thumbs Up / Thumbs Down), so it reads and filters like any other report, and a later
change to the thumbs follows onto it.

## Page Header

The page opens with the title **Feedback** and the number of reports matching the current filters. The actions on the right are a help button, **Refresh** and **Export CSV** (see Actions below).

## Filters

Below the header, one row holds the search box followed by the **Status**, **Subject** and **Organization** filter chips. A filter applies as soon as you pick a value; there is no Apply button. An unset chip is dashed and shows only its name; a set chip reads "Name: Value" and has an x that clears it. Changing any filter returns the list to its first page.

### Search

The search input filters feedback by matching against the **username**, **email**, or **content** of feedback entries. Matching runs on the server across every report, not just the page on screen, and the request is sent shortly after you stop typing rather than on each keystroke. Report text older than 90 days is automatically deleted (see Data Retention below), so search will no longer match on the content of an expired report.

### Status Filter

The **Status** chip filters by one or more statuses:

| Status | Default | Description |
|--------|---------|-------------|
| **New** | Selected | Newly submitted feedback that has not been triaged |
| **In progress** | Not selected | Feedback that is being actively addressed |
| **Closed** | Not selected | Feedback that has been resolved or dismissed |

By default, only **New** feedback is shown, and the chip reads "Status: New". Pick another status from the chip's menu to add it, or pick a selected one to remove it; with two selected the chip reads, for example, "Status: New +1". Clearing the chip, or removing its last status, shows every status, so the filter never leaves you with no status selected.

Within the selected statuses, reports are ordered purely by date -- there is no longer a New-before-In-Progress-before-Closed grouping. Ordering by a computed status rank cannot use the database's date indexes, which is what made the list slow to page; if you want to work one status at a time, filter to it.

### Organization Filter

The **Organization** chip filters feedback by the submitting user's organization. It appears once at least one report has an organization.

- Selecting nothing shows feedback from all organizations (the default)
- Individual organization names, taken from every report you can see

Pick several organizations from the chip's menu to combine them. The list of available organizations is not narrowed by the filter itself, so selecting one does not remove the others from the menu.

### Subject Filter

The **Subject** chip filters feedback by what the report is *about*. While it is unset, every report is shown whatever its subject (the default). Its menu offers:

| Menu entry | Shows |
|------------|-------|
| **Conversation turn** | Reports filed against one specific answer in a conversation |
| **Conversation** | Reports filed against a conversation as a whole, with no single answer named |
| **Product** | Reports about the product in general, filed outside any conversation |
| **Help** | Comments written on a help article or a help-chat answer |

A report's subject is decided when it is filed, narrowest first: one that names a turn is **Conversation turn**, one that names only a session is **Conversation**, and one attached to neither is **Product**. Help-center comments are recorded as **Help** by the help surfaces themselves rather than by that rule, which is what keeps them separable from general product feedback instead of landing in the same undifferentiated queue. Use the help context chip on the row (see Where Feedback Comes From above) to tell an article comment from a help-chat one.

Unlike the organization filter, only one subject can be selected at a time -- the server takes one subject or none. Click the x on the chip to clear it.

The subject filter combines with search, status and organization rather than replacing them, and the CSV export respects it along with the rest.

### Sorting

Click the **Created** column header to toggle between ascending and descending date order. The default sort order is descending (newest first). Sorting is by date alone and is applied across the whole filtered set on the server, so it reorders every match rather than just the rows currently on screen.

## Feedback List

Reports are listed in one table with the following columns:

| Column | Description |
|--------|-------------|
| **Created** | Timestamp in `Mon DD, YYYY HH:MM AM/PM` format with relative time (e.g., "2 days ago"). Tags associated with the feedback are shown as neutral chips below the date. |
| **Reporter** | Organization name (bold), username, email, and the user ID as a short chip (for example `690078...0001`). Click the chip to copy the full ID. |
| **Feedback** | The feedback content, displayed with preserved whitespace and word wrapping. Scrollable if content exceeds 80px height. A **Truncated** chip appears if the original submission was cut down to the length cap, and expired content (see Data Retention below) renders as `[content expired]`. |
| **Status** | A status select (see Update Status below) |

The last cell of each row holds a **...** button that opens the row menu: **Copy link to this report**, **Open the conversation** (see Deep Links below) and **Delete feedback**. The button shows while you hover or focus the row, and always on touch screens. No row has a delete button of its own.

The **Created** header is clickable and toggles the sort direction, displaying an up or down arrow to indicate the current order.

On a narrow window the table keeps its columns and scrolls sideways inside its own frame instead of squeezing them.

## Actions

### Update Status

Each feedback entry has a status select in its **Status** column:

| Status | Description |
|--------|-------------|
| **New** | Initial state for incoming feedback |
| **In progress** | Feedback is being investigated or worked on |
| **Closed** | Feedback has been addressed or dismissed |

Changing the status triggers an immediate API update. A toast notification confirms the change, showing a preview of the feedback content and the reporter's information.

### Delete Feedback

Open the row menu (**...**) and choose **Delete feedback**. A **Delete feedback** dialog names the reporter and says the deletion cannot be undone. Pick a reason (Spam or abuse, Duplicate report, Test submission) or write a note of at least 5 characters to enable the red **Delete feedback** button. The reason is not stored, because deleting a report does not record one. Upon successful deletion, a toast notification confirms the action with a preview of the deleted content.

### Deep Links

Two items in each row's menu link out of the list. The card a copied link pins above the list offers the same two as icon buttons.

| Menu item | What it does |
|-----------|--------------|
| **Copy link to this report** | Copies an absolute URL that reopens this tab with the one report pinned above the list. Safe to paste into a ticket or chat. |
| **Open the conversation** | Opens the session the report came from in a new tab, scrolled to the turn it was filed against. Shown only for a report attached to a session. |

A copied link pins its report in a card above the list whether or not it matches your current
filters or page; dismiss the card to return to the plain list, or expect the "no longer available"
notice if the report has since been deleted. In a very long conversation the jump may land on the
newest message first and reach the highlighted turn as older history loads.

### Refresh

The **Refresh** button in the page header reloads all feedback data from the server. It is disabled while data is loading. If the list fails to load, a **Try again** button appears in place of the rows.

### Export CSV

The **Export CSV** button in the page header generates a CSV file containing every feedback entry matching the current filters -- not just the page on screen. Large result sets are capped at 5,000 rows; when the cap is hit, a toast says so explicitly rather than handing you a short file that looks complete. The exported file is named `feedback_YYYY-MM-DD.csv` with the current date. The CSV uses the `papaparse` library for generation.

Exported columns:

| Column | Description |
|--------|-------------|
| ID | Feedback document ID |
| Status | Current status (New, In Progress, Closed) |
| Username | Submitting user's username |
| Content | Feedback text, or `[content expired]` once the report is past the 90-day retention window (see Data Retention below) |
| Organization | User's organization |
| HelpArticle | Article slug for a help-article report; empty for every other source |
| UpdatedAt | Last update timestamp |

The **Export CSV** button is disabled when there is no feedback matching the current filters.

## Pagination

The table has one pager, in its footer:

| Setting | Details |
|---------|---------|
| Rows per page | Selectable: 25, 50, or 100 (defaults to 25) |
| Navigation | Previous and next arrow buttons |
| Range | Displayed as "1 to 25 of N", where N is the server-side count of every report matching the filters (also shown beside the page title) |

## Data Retention

Feedback text is **automatically deleted 90 days after submission**. The structured record (status, reporter, organization, tags, timestamps) is kept permanently; only the free-text content expires. Once a report's text has been deleted, the list and CSV export both show `[content expired]` in its place, and it will no longer match a content search.

## Best Practices

- Keep **New** in the status filter to ensure incoming feedback is not missed.
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
