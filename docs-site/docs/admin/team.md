---
title: Team
description: Manage the internal team member contact list for User Ops coordination
sidebar_position: 30
tags: [admin, team, management]
---

# Team

The Team tab provides an internal contact list for managing team members used in User Ops coordination. Administrators can create, edit, and remove team member entries, each containing contact information and organizational details.

## Team Member List

Team members are displayed in a table, sorted alphabetically by name. Each row shows the member's name, phone number (clickable to initiate a call), and optional email, role, and department. An empty field shows a dash.

When no team members exist, the page shows "No team members yet" with a **Create team member** button.

### Table Columns

| Column | Description |
|--------|-------------|
| **Name** | Team member's full name |
| **Phone** | Phone number, rendered as a clickable `tel:` link |
| **Email** | Email address, if present |
| **Role** | Role label displayed as a chip (e.g., "Lead") |
| **Department** | Department label (e.g., "Ops") |

### Row Actions

Click a row to open the edit dialog for that member. Each row also has a **...** menu with two actions:

| Action | Description |
|--------|-------------|
| **Edit** | Opens the edit dialog to update the member's information |
| **Remove** | Opens a confirmation dialog, then removes the member |

## Creating a Team Member

Click the **Create team member** button to open the creation dialog. The dialog contains a form with the following fields:

| Field | Required | Description |
|-------|----------|-------------|
| **Name** | Yes | Full name of the team member |
| **Phone** | Yes | Phone number |
| **Email** | No | Email address |
| **Role** | No | Role or title within the team |
| **Department** | No | Department or team affiliation |

Validation requires that both Name and Phone are non-empty. If validation fails, an error message is displayed within the form. The dialog cannot be closed while a creation request is in progress.

## Editing a Team Member

Click a team member's row, or choose **Edit** from its **...** menu, to open the edit dialog. The form is pre-populated with the member's current information. The same validation rules apply: Name and Phone are required. Changes are saved by clicking the **Update team member** button.

## Deleting a Team Member

Choose **Remove** from a team member's **...** menu. A confirmation dialog names the member; click **Remove** to delete the entry, or **Cancel** to keep it. If the deletion fails, the dialog stays open with the error so you can retry or cancel.

## Best Practices

- Keep the contact list current by removing members who are no longer on the team.
- Use the Role and Department fields to help quickly identify who handles what.
- Add phone numbers in international format for distributed teams.

---

## Related Articles

- [World Time](./world-time.md) - Time zone reference for distributed teams
- [Admin Dashboard Overview](./overview.md) - Navigation and layout
