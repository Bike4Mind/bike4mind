---
title: Documentation Browser
description: Admin page for browsing, searching, and filtering platform documentation loaded from Docusaurus
sidebar_position: 21
tags: [admin, documentation, reference]
---

# Documentation Browser

The Docs page in the admin panel gives you one place to browse the platform documentation. It loads documentation metadata from the Docusaurus docs site and shows it as a searchable grid of cards, so you can find an article without leaving the admin panel. You open it from **Settings > Docs** in the admin sidebar.

## How It Works

When the page opens, it fetches metadata for every documentation article from the `/api/documentation/docusaurus-meta` endpoint. Each article has a title, description, category, tags, and a link to the full Docusaurus page. The page header shows how many articles match the current category and search.

## Category Tabs

A row of tabs under the page header filters the articles by category. Pick a tab to show only that category, or **All** to remove the filter. On a narrow screen the row scrolls sideways.

The categories are: All, Admin settings, Architecture, Development, Migration, API reference, Agents, Features, Client-side, AWS, Artifacts, Security, Databases, Testing, Onboarding, Files, Tags search, and General.

## Searching

The search box under the tabs filters the articles as you type. Press `/` to jump to it. It matches against three fields on each article:

| Field           | Match Type                             |
| --------------- | -------------------------------------- |
| **Title**       | Case-insensitive substring             |
| **Description** | Case-insensitive substring             |
| **Tags**        | Case-insensitive substring on each tag |

You can combine a category and a search. For example, picking "Security" and searching for "auth" shows only security articles that match "auth".

## Documentation Cards

Each card shows:

- **Title** of the article, with an **Open** button that opens the full article in a new browser tab
- **Description** summarizing the article
- **Category** as a chip
- **Tags** (up to 3, with a "+N more" chip for the rest)

## Refresh

The **Refresh** button in the page header fetches the metadata again. Use it when the docs site has changed since you opened the page. The articles already on screen stay visible while the refresh runs, with an "Updating" bar above them.

## Loading, Empty and Error States

| Condition                         | What you see                                                                                                            |
| --------------------------------- | ----------------------------------------------------------------------------------------------------------------------- |
| First load in progress            | A "Loading docs" spinner where the cards will appear                                                                    |
| The docs site returns no articles | "No docs found", with a Refresh button                                                                                  |
| A search matches nothing          | "No docs match" and your search, with a Clear search button                                                             |
| A category has no articles        | "No docs in" and the category, with a Show all docs button                                                              |
| The metadata request fails        | "Docs failed to load", with a Try again button. If articles were already on screen, they stay visible under the message |

## Best Practices

- Pick a category before searching to narrow a large set of articles.
- If no articles appear after a fresh load, check that the Docusaurus docs site is running and reachable from the current environment, then refresh.
- Refresh is most useful in development environments, where documentation changes often.

---

## Related Articles

- [Admin Dashboard Overview](./overview.md) - Overall admin panel layout and navigation
