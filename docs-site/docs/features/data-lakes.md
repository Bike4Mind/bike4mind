---
title: Data Lakes
description: Curated knowledge collections for AI-powered retrieval
sidebar_position: 17
---

# Data Lakes

Data Lakes are curated collections of documents that power AI retrieval in Bike4Mind. They provide structured, scoped access to knowledge bases so the AI can search and reference domain-specific content during conversations.

## How It Works

A Data Lake groups files under a common tag prefix and makes them available to AI tools like knowledge base search and retrieval. Each Data Lake has:

- **Name and slug** -- a human-readable identifier
- **File tag prefix** -- scopes which uploaded files belong to the lake
- **Access controls** -- user tags and entitlement gates determine who can query the lake
- **Organization scoping** -- lakes can be scoped to a specific organization

## Access Control

Data Lakes support two layers of access control:

1. **User tags** -- users with the required tag can access the lake's content
2. **Entitlements** -- subscription-level or role-based entitlement keys provide an additional gate

When an AI tool performs a knowledge base search, it automatically resolves which Data Lakes the current user can access based on their tags and entitlements.

## Lifecycle

Data Lakes follow a lifecycle with these statuses:

| Status | Description |
|--------|-------------|
| Draft | Being configured, not yet active |
| Active | Available for AI retrieval |
| Archiving | Being moved to cold storage |
| Archived | In cold storage, not searchable |
| Unarchiving | Being brought back from archive |
| Restoring | Being recovered from a delete |
| Deleting | Removal in progress |

Archiving and deleting are two separate reversal paths, and each has its own in-progress status --
`Unarchiving` comes back from `Archived`, `Restoring` comes back from `Deleted`. Only one lifecycle
action can hold a lake at a time.

## Use Cases

- **Domain-specific knowledge** -- upload medical literature, legal documents, or technical manuals and scope retrieval to authorized users
- **Organization knowledge bases** -- each org can maintain its own curated content
- **Product documentation** -- give AI access to internal docs for support workflows

## FAQ

**How do I create a Data Lake?**
Data Lakes are created and managed by administrators. Contact your admin to set up a new lake with the appropriate tag prefix and access controls.

**Can I query multiple Data Lakes at once?**
Yes. The AI retrieval tools automatically search across all Data Lakes you have access to based on your user tags and entitlements.

**How are files added to a Data Lake?**
Files are tagged with the lake's file tag prefix when uploaded. The lake tracks file count and total size automatically.

**Why does a reply say "Only part of your library was searched"?**
Grounded answers scan the library under per-turn bounds -- a candidate-document cap and a chunk
budget -- and they skip documents whose embeddings came from a different model than the one running
the query. When any of that applies, the reply carries a warning banner, and expanding it lists the
specific reasons. The important consequence is what the answer does *not* prove: a "nothing found"
on a partial scan is not evidence that the library holds nothing relevant. Narrow the question, or
wait if the banner says documents are still being re-indexed.

**I got "this data lake moved to '...' while it was being archived/deleted/restored". What happened?**
Two lifecycle actions ran on the same lake at once -- for example Archive and Delete were both
started from the lake's panel before the first finished. Only one of them can complete, and the
other reports this instead of overwriting it. The message names the status that won; the lake is in
that state and is safe to act on from there. Re-run the action you wanted if it is still available.

## Related

- [Knowledge Management](./knowledge-management.md) -- uploading and managing files
- [Smart Tools](./smart-tools.md) -- AI tools that query Data Lakes
