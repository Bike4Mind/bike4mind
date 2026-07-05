---
title: Team
description: Manage the internal team member contact list for User Ops coordination
sidebar_position: 30
tags: [admin, team, management]
---

# Team

The Team tab provides an internal contact list for managing team members used in User Ops coordination. Administrators can create, edit, and remove team member entries, each containing contact information and organizational details.

## Team Member List

Team members are displayed as a responsive grid of cards, sorted alphabetically by name. Each card shows the member's name, phone number (clickable to initiate a call), and optional details including email, role, and department.

When no team members exist, an informational alert prompts the administrator to use the Create Team Member button.

### Card Information

| Field | Description |
|-------|-------------|
| **Name** | Team member's full name (displayed prominently with a person icon) |
| **Phone** | Phone number, rendered as a clickable `tel:` link |
| **Email** | Email address (shown below a divider if present) |
| **Role** | Role label displayed as a colored chip (e.g., "Lead") |
| **Department** | Department label displayed as a neutral chip (e.g., "Ops") |

### Card Actions

Each card provides two action buttons:

| Action | Description |
|--------|-------------|
| **Edit** | Opens the edit modal to update the member's information |
| **Delete** | Prompts a browser confirmation dialog, then removes the member |

## Creating a Team Member

Click the **Create Team Member** button to open the creation modal. The modal contains a form with the following fields:

| Field | Required | Description |
|-------|----------|-------------|
| **Name** | Yes | Full name of the team member |
| **Phone** | Yes | Phone number |
| **Email** | No | Email address |
| **Role** | No | Role or title within the team |
| **Department** | No | Department or team affiliation |

Validation requires that both Name and Phone are non-empty. If validation fails, an error message is displayed within the form. The modal cannot be closed while a creation request is in progress.

## Editing a Team Member

Click the edit icon on any team member card to open the edit modal. The form is pre-populated with the member's current information. The same validation rules apply: Name and Phone are required. Changes are saved by clicking the **Update Team Member** button.

## Deleting a Team Member

Click the delete icon on any team member card. A browser confirmation dialog asks for confirmation before proceeding. If the deletion fails, an error alert is displayed at the top of the team list.

## Best Practices

- Keep the contact list current by removing members who are no longer on the team.
- Use the Role and Department fields to help quickly identify who handles what.
- Add phone numbers in international format for distributed teams.

---

## Related Articles

- [World Time](./world-time.md) - Time zone reference for distributed teams
- [Admin Dashboard Overview](./overview.md) - Navigation and layout
