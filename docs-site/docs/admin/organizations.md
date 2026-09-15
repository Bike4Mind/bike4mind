---
title: Organizations
description: Create, search, filter, and manage organizations and personal workspaces on the platform
sidebar_position: 11
tags: [admin, organizations, teams]
---

# Organizations

The Organizations tab provides administrators with tools to browse, create, and manage all organizations on the Bike4Mind platform. This includes both team organizations and personal workspaces. The interface supports searching, filtering, sorting, and editing organization profiles.

## Search and Filters

A filter card at the top of the page provides the following controls:

| Control | Description |
|---------|-------------|
| **Search by name** | A debounced text input (300ms) that filters organizations by name. A loading spinner appears in the input while results are being fetched. |
| **Type** | A dropdown to filter by organization type: All types, Personal, or Organization. |
| **Sort by** | A dropdown to select the sort field: Name, Created Date, or Updated Date. |
| **Direction** | A dropdown to set sort direction: Ascending or Descending. |
| **Create Organization** | Opens a modal to create a new organization. |

## Organization Table

The main table displays organization records with the following columns:

| Column | Description |
|--------|-------------|
| **Name** | The organization's display name. |
| **Type** | A color-coded chip: "Personal" (blue/primary) or "Organization" (green/success). |
| **Users** | The number of users associated with the organization. |
| **Billing Contact** | The billing contact for the organization, or a dash if not set. |
| **Credits** | The organization's current credit balance. |
| **Actions** | Edit and View buttons for each organization. |

## Actions

Each organization row provides two action buttons:

| Action | Description |
|--------|-------------|
| **Edit** | Opens the organization profile editor in a modal dialog, allowing administrators to modify organization settings. After saving changes and closing the modal, the organization list is automatically refreshed. |
| **View** | Navigates to the full organization profile page at `/organizations/{id}` in a new view. |

## Creating Organizations

Click the **Create Organization** button to open a creation modal with:

| Field | Description |
|-------|-------------|
| **Organization Name** | The name for the new organization. Cannot be empty. |

After entering a name, click **Create** to submit. The list refreshes automatically upon successful creation. A toast notification appears if the name is left empty.

## Infinite Scroll Pagination

Rather than traditional page-based pagination, the organizations list uses infinite scroll. As you scroll to the bottom of the table, additional organizations are automatically loaded. A loading spinner appears at the bottom of the table while fetching the next page. The total count of currently loaded organizations is displayed below the table (e.g., "Showing 42 organizations").

## Organization Profile Editor

When editing an organization via the Edit button, a modal opens containing the `OrganizationProfileUpdated` component. This provides a detailed editing interface for the organization's settings and configuration. Changes are saved through the modal, and the organization list refreshes when the modal is closed.

## Best Practices

- Use the Type filter to quickly distinguish between personal workspaces and team organizations.
- Sort by "Created Date" in descending order to see the most recently created organizations first.
- Review organizations with zero credits to identify accounts that may need attention.
- Use the search bar for quick lookups when handling support requests related to specific organizations.

## Related Articles

- [Subscriptions](./subscriptions.md)
- [Credit Analytics](./credit-analytics.md)
