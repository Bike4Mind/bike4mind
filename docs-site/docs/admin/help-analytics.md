---
title: Help Center Analytics
description: Monitor help center usage, identify documentation gaps, and review user feedback on articles and AI chat responses
sidebar_position: 37
tags: [admin, analytics, help-center, feedback]
---

# Help Center Analytics

The Help Center Analytics dashboard gives administrators visibility into how the help system is being used. It surfaces which articles are popular, where documentation gaps exist, and what users think about both articles and AI chat responses. Access it from the **AI** section in the Admin sidebar.

## Date Range Filter

At the top of the dashboard, use the **From** and **To** date inputs to narrow all data to a specific period. When no dates are set, all-time data is shown. Events are automatically expired after 90 days.

## Overview Cards

Six summary cards display at the top:

| Card | Description |
|------|-------------|
| Total Views | Total number of article views across all users |
| Unique Articles | Count of distinct articles that have been viewed |
| Total Searches | Number of searches performed in the help center |
| Article Feedback | Total thumbs-up and thumbs-down ratings on articles |
| Chat Queries | Number of questions asked to the AI help assistant |
| Chat Feedback | Total thumbs-up and thumbs-down ratings on AI chat responses |

## Tabs

Each tab includes a summary description explaining its purpose. Long text in any table cell can be hovered to reveal the full content in a tooltip.

### Popular Articles

Most-viewed help articles ranked by total views. Each row shows the article title, slug, and view count. Use this to understand which topics users need help with most.

### Search Gaps

Searches that returned zero results, grouped by query and sorted by frequency. This is the most actionable tab — each entry represents a topic users are looking for that has no matching documentation. Use it to prioritize new articles.

### Article Feedback

Per-article rating breakdown. Columns include:

- **Helpful** — count of thumbs-up ratings
- **Not Helpful** — count of thumbs-down ratings
- **Outdated** — count of users who flagged the article as outdated
- **Total** — total feedback submissions

Prioritize articles with high "Not Helpful" or "Outdated" counts for revision.

### Article Comments

Recent individual feedback entries with comments and outdated reports. Shows the article slug, rating, report type (if flagged as outdated), user comment, and date. Hover over any comment to view the full text. This gives a chronological view of incoming feedback and is useful for spotting newly reported issues.

### Recent Questions

Most common AI chat questions, grouped by query text with a count and last-asked date. Frequent topics may indicate areas that need dedicated help articles rather than relying on AI responses.

### Chat Feedback

User feedback on AI chat responses — helps improve the system prompt and RAG lookups. Each row shows the user's question, a **View** button for the answer, the rating (Good/Bad), any comment, and the date.

Clicking **View** opens a detail modal with:

- The full question (scrollable if long)
- The full AI answer rendered as markdown (with independent scrolling)
- A fixed footer showing the rating, comment, and date

Use this to identify cases where the AI gave poor answers, which can inform improvements to the system prompt or the articles behind the RAG lookups.
