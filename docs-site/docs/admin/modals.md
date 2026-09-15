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
| **Status** | Toggle button showing enabled (green, power icon) or disabled (neutral, power-off icon). Click to toggle. | No |
| **Type** | Chip showing "Modal" (primary) or "Banner" (warning) | Yes |
| **Title / Message** | The modal title (or text message for banners), with subtitle shown below | Yes |
| **Description** | Truncated description text with a tooltip for full content | No |
| **Targeting** | User tags displayed as chips (up to 2 visible, with overflow count). Shows "All users" if no tags are set. | No |
| **Priority** | Badge with priority number. Values 5 and above use danger color. | Yes |
| **Created** | Creation timestamp | Yes |
| **Updated** | Last update timestamp | Yes |
| **Actions** | Edit, Preview, and Delete buttons | No |

### Sorting

Click any sortable column header to sort ascending. Click again to toggle to descending. An arrow icon indicates the current sort direction; an unfold icon indicates unsorted columns.

### Search

The search bar above the table filters modals by matching the query against:

- Title
- Text message (for banners)
- Description
- Tags

The search resets pagination to the first page whenever the query changes.

### Pagination

Pagination controls appear below the table when there are results:

| Control | Description |
|---------|-------------|
| **Rows per page** | Select 5, 10, 25, or 50 rows per page (default: 10) |
| **Range indicator** | Shows "X-Y of Z modals" |
| **Navigation** | First, Previous, Next, Last page buttons |

## Creating a Modal

Click the "Create New Modal" button to open the wizard. The wizard uses a step-by-step flow with a progress stepper at the top.

### Wizard Steps

The wizard steps differ slightly depending on whether you are creating a modal or a banner:

**For Modals:**

| Step | Name | Fields |
|------|------|--------|
| 1 | Type | Choose between Modal and Banner |
| 2 | Content | Title (required), Subtitle, Description (required), Close button toggle, Agree button toggle |
| 3 | Media | Upload image via drag-and-drop or enter a URL directly |
| 4 | Targeting | Start date (required), End date (required), Priority, Enable toggle, User tags with suggestions |
| 5 | Behavior | Display frequency preset (First Time Only, Weekly Reminder, Persistent, Custom) |
| 6 | Review | Summary of all settings with live preview option |

**For Banners:**

| Step | Name | Fields |
|------|------|--------|
| 1 | Type | Choose between Modal and Banner |
| 2 | Message | Notification title (required), Banner message (required), Optional description, Close/action button toggles |
| 3 | Media | Same as modal |
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

Click the Edit icon on any table row to re-open the wizard pre-populated with the existing modal data. The wizard title changes to "Edit Modal" or "Edit Banner" accordingly.

## Previewing a Modal

Click the Preview icon on a table row to see how the modal will appear to end users. For images stored in S3, the preview generates a presigned URL for display. The preview opens in a GenericModal component matching the actual user-facing rendering.

## Deleting a Modal

Click the Delete icon to open a confirmation dialog. The dialog shows the modal title and warns that the action cannot be undone. Confirming the deletion removes the modal permanently.

## Toggling Enabled/Disabled

Click the status icon (power button) on any table row to instantly toggle the modal between enabled and disabled states. A success toast confirms the change.

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
