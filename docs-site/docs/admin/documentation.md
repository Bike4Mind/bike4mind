---
title: Documentation Browser
description: Admin tab for browsing, searching, and filtering platform documentation loaded from Docusaurus
sidebar_position: 21
tags: [admin, documentation, reference]
---

# Documentation Browser

The Documentation tab in the admin panel provides a centralized interface for browsing all platform documentation. It dynamically loads documentation metadata from the Docusaurus docs site and presents it in a searchable, filterable card grid. This allows administrators to quickly locate and access relevant documentation without leaving the admin panel.

## How It Works

On mount, the Documentation tab fetches metadata for all documentation articles from the `/api/documentation/docusaurus-meta` endpoint. Each article includes a title, description, category, tags, and a direct URL to the full Docusaurus page. Articles are displayed as cards in a responsive grid layout (1 column on mobile, 2 on medium screens, 3 on large screens).

## Searching

The search bar at the top of the tab filters documentation in real time. It matches against three fields on each article:

| Field | Match Type |
|-------|------------|
| **Title** | Case-insensitive substring |
| **Description** | Case-insensitive substring |
| **Tags** | Case-insensitive substring on each tag |

When a search term is active, a chip appears next to the section heading showing the current search query, and the filtered count is displayed.

## Category Filters

Below the search bar, a row of clickable chips allows filtering by documentation category. Selecting a category restricts the displayed articles to that category. Selecting "All" removes the category filter.

| Category | Icon | Color |
|----------|------|-------|
| All | Description | Neutral |
| Admin Settings | Settings | Primary |
| Architecture | Account Tree | Success |
| Development | Code | Warning |
| Migration | Swap Horiz | Danger |
| API Reference | Api | Info |
| Agents | Smart Toy | Primary |
| Features | Featured Play List | Success |
| Client-Side | Code | Warning |
| AWS | Cloud | Info |
| Artifacts | Extension | Primary |
| Security | Security | Danger |
| Databases | Storage | Info |
| Testing | Bug Report | Warning |
| Onboarding | School | Success |
| Files | Folder | Neutral |
| Tags Search | Local Offer | Info |
| General | Help | Neutral |

Category and search filters can be combined. For example, selecting "Security" and searching for "auth" shows only security-category articles matching "auth."

## Documentation Cards

Each documentation card displays:

- **Category icon and color** in the card header
- **Title** of the article
- **Category chip** showing the resolved category name
- **Description** summarizing the article content
- **Tags** (up to 3 visible, with a "+N more" overflow chip)
- **"Open in Docusaurus" button** that opens the full article in a new browser tab

## Refresh

A Refresh button next to the search bar re-fetches documentation metadata from the API. This is useful if the Docusaurus site has been updated since the admin panel was loaded. The button shows a loading spinner while the fetch is in progress.

## Status Alerts

The tab shows contextual alerts:

| Condition | Alert |
|-----------|-------|
| Documentation loaded successfully | Green alert showing the total article count |
| No documentation found | Warning alert advising to check if Docusaurus is running |
| Fetch error | Warning alert indicating the load failure |

## Best Practices

- Use the category filter to narrow results before searching, especially when the documentation set is large.
- If no documentation appears after a fresh load, verify that the Docusaurus docs site is running and accessible from the current environment.
- The Refresh button is particularly useful in development environments where documentation content changes frequently.

---

## Related Articles

- [Admin Dashboard Overview](./overview.md) - Overall admin panel layout and navigation
