---
title: Credit Analytics
description: Manage user credit balances and configure per-model cost settings for the platform
sidebar_position: 12
tags: [admin, credits, analytics, billing]
---

# Credit Analytics

The Credit Analytics tab provides tools for managing the platform's credit economy. It is organized into two sub-tabs: **User Credits** for viewing and adjusting individual user credit balances, and **Model Cost Settings** for configuring how many credits each AI model consumes per request.

## User Credits Manager

### Search and Sorting

A filter card at the top provides the following controls:

| Control | Description |
|---------|-------------|
| **Search users** | Filter users by name or email address. |
| **Sort by Credits** | Sort users by credit balance: Highest First or Lowest First. |
| **Refresh** | Reloads the user list from the server. |

### User Table

The user table displays the following columns:

| Column | Description |
|--------|-------------|
| **User** | The user's full name and email address. |
| **Credits** | The user's current credit balance, formatted with locale-appropriate separators. |
| **Last Login** | The date of the user's most recent login, or "Never" if they have not logged in. |
| **Status** | Status chips showing Active/Inactive state and an "Admin" badge for admin users. |
| **Created** | The date the user account was created. |
| **Actions** | View Profile and Credits adjustment buttons. |

### Actions

Each user row provides two actions:

| Action | Description |
|--------|-------------|
| **View Profile** | Opens the admin profile viewer for the user. |
| **Credits** | Opens the credit adjustment modal for the user. |

### Credit Adjustment Modal

The credit adjustment modal allows administrators to add or remove credits from a user's balance:

| Field | Description |
|-------|-------------|
| **User** | Displays the selected user's name or email (read-only). |
| **Current Balance** | Shows the user's current credit count (read-only). |
| **Amount** | The number of credits to add or remove. Minimum value is 10, with increments of 10. Default is 100. |
| **Note** | An optional text field for documenting the reason for the adjustment (e.g., "Promotional bonus", "Compensation for issue"). |

Two action buttons are provided:
- **Add Credits** (green) - Adds the specified amount to the user's balance.
- **Remove Credits** (red) - Subtracts the specified amount from the user's balance.

### Pagination

Pagination controls appear above and below the user table:

- **Previous / Next** buttons for page navigation
- **Page indicator** showing "Page X of Y"
- **Items per page** selector with options: 10, 20, 50, or 100 per page
- **Total Users** count

## Model Cost Settings

The Model Cost Settings sub-tab controls how many credits are charged for each AI model. Changes take effect immediately for all new requests.

### Model Type Tabs

Models are organized into two tabs:

| Tab | Description |
|-----|-------------|
| **Text Models** | Language models used for chat, completion, and analysis tasks. |
| **Image Models** | Image generation models. |

### Text Model Table

| Column | Description |
|--------|-------------|
| **Model Name** | The model's display name and a truncated description. |
| **Price Tier** | A tag indicating the model's pricing tier. A "Modified" badge appears if custom pricing has been applied. |
| **Input Cost** | The credit cost per input unit. Editable via a numeric input field. |
| **Output Cost** | The credit cost per output unit. Editable via a numeric input field. |

### Image Model Table

| Column | Description |
|--------|-------------|
| **Model Name** | The model's display name and a truncated description. |
| **Price Tier** | A tag indicating the model's pricing tier with a "Modified" badge for custom pricing. |
| **Generation Cost** | The credit cost per image generation. Editable via a numeric input field. |

### Saving and Reverting

When any model cost has been modified, a save bar appears at the bottom showing the count of modified models. It provides two actions:

| Action | Description |
|--------|-------------|
| **Reset Changes** | Reverts all unsaved modifications back to their previously saved values. |
| **Save Changes** | Persists all modified model costs to the server. Changes take effect immediately. |

Additionally, a **Revert back to default costing** button at the top resets all models to their calculated default costs. This action stages the changes but still requires clicking "Save Changes" to apply.

## Best Practices

- Use the "Sort by Credits: Lowest First" option to identify users who may be running low on credits and could benefit from a top-up or subscription upgrade.
- Always include a note when adjusting credits to maintain an audit trail of why changes were made.
- When modifying model costs, test with a small group first by using the credit adjustment feature to give test users additional credits.
- Review model costs periodically as upstream API pricing changes to ensure credit charges remain proportional.
- Use the "Revert back to default costing" option as a safety net if custom pricing gets out of alignment.

## Related Articles

- [Subscriptions](./subscriptions.md)
- [Organizations](./organizations.md)
