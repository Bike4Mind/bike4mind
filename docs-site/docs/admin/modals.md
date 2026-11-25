---
title: Modals Management
description: Admin tab for creating, editing, previewing, and managing modals and banners shown to users
sidebar_position: 22
tags: [admin, modals, announcements, ui]
---

# Modals Management

The Modals tab in the admin panel provides a full management interface for modals and banners displayed to end users. Administrators can create new announcements, edit existing ones, preview how they appear, toggle their enabled state, and delete them. Modals tagged with "whatsNew" are excluded from this tab and managed in the dedicated What's New tab.

## Modals Table

All modals (excluding What's New modals) are displayed in a sortable, searchable, paginated table with the following columns:

| Column | Description | Sortable |
|--------|-------------|----------|
| **Status** | "Active" when the modal is enabled, "Inactive" when it is disabled | No |
| **Type** | "Modal" or "Banner" | Yes |
| **Title** | The title, with the subtitle (modals) or banner message (banners) on a second line. Sorts by title | Yes |
| **Description** | The description on one line, with the full text on hover | No |
| **Targeting** | User tags, comma separated. Shows "All users" if no tags are set. | No |
| **Priority** | The priority number | Yes |
| **Created** | Creation date, with the time below | Yes |
| **Updated** | Last update date, with the time below | Yes |

Click a row to open it in the wizard. Each row also has a "..." actions menu with:

- **Edit modal** - opens the wizard with the modal's data
- **Preview modal** - shows the modal as users see it
- **Enable modal** / **Disable modal** - turns the modal on or off
- **Delete modal** - removes the modal after a typed confirmation

On a narrow screen the table scrolls sideways inside its own frame, and the "..." menu stays visible.

### Sorting

Click a sortable column header to sort by that column. Click it again to reverse the order.

### Search

The search box above the table filters modals by matching the query against:

- Title
- Text message (for banners)
- Description
- Tags

Changing the search returns you to the first page. When nothing matches, the table offers a "Clear search" action.

### Pagination

Pagination controls appear below the table. Choose 25, 50, or 100 rows per page (default: 25), and use the previous and next page buttons to move through the list.

## Creating a Modal

Click "Create modal" to open the wizard in a dialog. A progress stepper at the top shows where you are, and the footer holds Back, Cancel, and Next. On the last step, Next becomes "Create modal" (or "Create banner"). Close the dialog with its close button, Cancel, or Esc. Clicking outside the dialog does not close it, and if you have made changes, closing asks you to confirm before your entries are discarded. If a save fails, the wizard stays open with your entries.

### Wizard Steps

The wizard steps differ slightly depending on whether you are creating a modal or a banner:

**For Modals:**

| Step | Name | Fields |
|------|------|--------|
| 1 | Type | Choose Modal or Banner |
| 2 | Content | Title (required), Subtitle, Description (required), Close button toggle, Agree button toggle |
| 3 | Media | Upload image via drag-and-drop or enter a URL directly. Optionally add a product video: a 16:9 cut, a 9:16 cut, and a poster image for each. A poster needs its video, and invalid URLs block Next |
| 4 | Targeting | Start date (required), End date (required), Priority, Enable toggle, User tags with suggestions |
| 5 | Behavior | Display frequency preset (First Time Only, Weekly Reminder, Persistent, Custom) |
| 6 | Review | Summary of all settings, with a "Show live preview" button |

**For Banners:**

| Step | Name | Fields |
|------|------|--------|
| 1 | Type | Choose Modal or Banner |
| 2 | Message | Notification title (required), Banner message (required), Optional description, Close/action button toggles |
| 3 | Media | Image only (no video) |
| 4 | Targeting | Same as modal |
| 5 | Behavior | Same as modal |
| 6 | Review | Same as modal |

### Display Frequency Presets

The Behavior step provides presets for controlling how often a modal is shown to each user:

| Preset | Threshold | Description |
|--------|-----------|-------------|
| **First Time Only** | 1 | Show only once to each user |
| **Weekly Reminder** | 7 | Show once per week |
| **Persistent** | 999 | Keep showing until the user agrees |
| **Custom** | Configurable | Set custom view and agree thresholds |

### User Tag Targeting

Tags determine which users see the modal. Predefined tag suggestions include:

`new-user`, `premium`, `free-tier`, `beta-tester`, `power-user`, `inactive`, `trial`, `enterprise`

Tags must be in kebab-case format (lowercase letters, numbers, and hyphens). Leave tags empty to show the modal to all users.

## Editing a Modal

Click a row, or choose **Edit modal** from its "..." menu, to re-open the wizard with the existing modal data. The dialog title changes to "Edit modal" or "Edit banner", and the last step's button reads "Update modal" or "Update banner".

## Previewing a Modal

Choose **Preview modal** from a row's "..." menu to see how the modal will appear to end users. For images stored in S3, the preview generates a presigned URL for display. The preview uses the same component as the user-facing modal.

## Deleting a Modal

Choose **Delete modal** from a row's "..." menu to open a confirmation dialog. Type the modal's title (or the word `delete` for an untitled modal) to enable the **Delete modal** button. Pick a reason or write a short note as well; the button stays disabled until you do. The reason is not recorded, but the deletion itself appears in the Admin log. Deleting removes the modal permanently. If the delete fails, the dialog stays open and an error toast explains why.

## Toggling Enabled/Disabled

Choose **Enable modal** or **Disable modal** from a row's "..." menu to switch the modal on or off. A success toast confirms the change, and the Status column updates.

## Best Practices

- Set both the Agree and View counters even for modals without agree buttons, as the system requires both counter configurations.
- Use the Priority field to control display order when multiple modals are active simultaneously. Higher priority values display first.
- Use the Start Date and End Date fields to schedule time-limited announcements without needing to manually disable them later.
- Preview modals before enabling them to verify the layout, images, and content appear correctly.
- Use specific user tags for targeted announcements rather than showing all modals to all users.

---

## Related Articles

- [Admin Dashboard Overview](./overview.md) - Overall admin panel layout and navigation
- [What's New Modals](./whats-new.md) - Managing What's New feature announcements
