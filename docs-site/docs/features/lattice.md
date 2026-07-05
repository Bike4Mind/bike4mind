---
title: Lattice - Financial Modeling
description: Create and manipulate financial pro-forma models using natural language conversation
sidebar_position: 19
tags: [financial-modeling, spreadsheet, lattice, experimental]
---

# Lattice - Financial Modeling

*(Experimental Feature — enable in [Profile > Settings > Experimental Features](./profile-settings.md#experimental-features))*

Lattice lets you create and manipulate financial pro-forma models through natural language conversation. Build spreadsheet-like models by describing what you need — the AI structures the entities, attributes, and calculation rules for you.

> **Availability:** This feature may be enabled or disabled at the organizational level by your administrator. If the toggle is grayed out with "Disabled by administrator," contact your organization admin to request access.

---

## How to Enable

1. Click your **avatar** in the sidebar footer to open your Profile
2. Go to the **Settings** tab
3. Scroll to **Experimental Features**
4. Toggle **Lattice** on

Once enabled, Lattice models can be created and viewed within your notebook conversations.

## How It Works

Lattice models appear as interactive artifacts within your chat. When the AI creates a financial model, it renders with three view tabs:

### Table View

A spreadsheet-like interface showing entities (rows) and attributes (columns) with their values. You can see computed values update as the model changes.

### Formulas View

Displays all defined rules and formulas that compute values — SUM, SUBTRACT, and other operations that link entities and attributes together. This shows the logic behind the calculated fields.

### Chart View

Visualizes the model data as charts, making it easy to see trends and comparisons across entities.

## Creating Models

Ask the AI to build a financial model in natural language:

- "Create an income statement for a SaaS company with revenue of $1M, COGS at 20%, and operating expenses of $400K"
- "Build a 3-year pro-forma with 15% annual revenue growth"
- "Add a new line item for marketing spend at $50K per quarter"

The AI will structure the model with appropriate entities, attributes, and calculation rules, then render it as an interactive Lattice artifact.

## Modifying Models

Continue the conversation to adjust the model:

- "Increase the growth rate to 20%"
- "Add a column for Q4 projections"
- "What happens if we reduce COGS to 15%?"

The model updates in place with recalculated values.

---

## Related Features

- [Artifacts](./artifacts-system.md) - How interactive content renders in chat
- [Notebooks](./notebooks.md) - Where Lattice models live
- [Profile & Settings](./profile-settings.md) - Where you enable this feature
