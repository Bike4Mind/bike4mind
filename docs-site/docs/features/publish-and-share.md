---
title: Publish & Share
description: Publish any reply, artifact, or file to a public link and share it on Bluesky, X, or LinkedIn
sidebar_position: 22
tags: [publish, share, artifacts, social, hosting]
---

# Publish & Share

Turn anything you create in Bike4Mind into a shareable, hosted page. **Create and share** lets you publish three kinds of content to a clean public URL — and broadcast it with one click to Bluesky, X/Twitter, or LinkedIn (or copy the link / the markdown).

## What you can publish

| Surface | Where | Public URL |
|---|---|---|
| **A reply** | The `⋮` menu on any assistant reply → **Share** | `/p/r/{id}` |
| **A file (FabFile)** | A file's `⋮` menu → **Publish to public link** | `/p/f/{id}` |
| **An artifact** | The Artifacts gallery `⋮` menu → **Share** | `/p/u/{you}/{slug}` |

Each publish opens a dialog with the live URL plus the social-share bar (Bluesky · X · LinkedIn · Copy Link · Copy Markdown · native share).

## How it works

- **Replies and files** are snapshotted server-side and rendered as a clean, read-only page (markdown for replies, the file body for files). The snapshot means the page keeps working even if you later edit the original.
- **Artifacts** are published as a hosted static bundle: your artifact is rendered to a single `index.html` and served under your scope. HTML and SVG artifacts become real pages; other types (code, Python, React, Recharts, Mermaid, …) render their source.

Published pages are served under Bike4Mind's own domain with strict, per-page Content-Security-Policy and a visibility check on every request.

## Visibility — who can see it

Every published item has a visibility tier. They form an ordered ladder from most- to least-restricted:

| Visibility | Who can view |
|---|---|
| **private** | You (the owner) and admins |
| **project** | Members of the project it's published under |
| **organization** | Members of your organization |
| **public** | Anyone with the link (no sign-in) |

Defaults depend on where you publish (your **user** space defaults to *private*; an **organization** space defaults to *organization*). You can change an item's visibility any time from your published-artifacts list — making a private item public, or taking a public one back to private.

:::tip
A **public** link works for anyone, even logged out. A **private/project/organization** link requires the viewer to be signed in and authorized — anonymous visitors get a 401.
:::

## Search engines

**Public does not mean listed in Google.** These are two different promises, and Bike4Mind keeps them separate:

- **"Anyone with the link can view"** — what *public* means. The page loads for anyone you send the URL to, signed in or not.
- **"Findable by searching"** — a *separate* opt-in, off by default.

Every published page is served with `noindex, nofollow` (as both an `X-Robots-Tag` header and an in-page `<meta name="robots">`) unless you explicitly turn on **List in search engines** in the share dialog. That switch appears only for a public, ungated item, because it can't do anything otherwise.

What the opt-out does *not* affect:

- **Link previews still work.** Pasting the URL into Slack, Discord, iMessage, or a social post still renders a title/description card. Unfurlers read Open Graph tags and ignore robots directives; search crawlers honor them.
- **The link still works.** Anyone you send it to can open it. Not being indexed is not access control.

Turning the switch back off purges the CDN copy immediately, so the page stops being served as indexable right away. Note that removing a page from a search index that already crawled it is up to the search engine — use the gates below if the content is actually sensitive.

:::warning
Never rely on a URL being hard to guess. If content shouldn't be seen by everyone, use a **passphrase**, a **domain restriction**, or a non-public visibility tier — not the absence of a search listing.
:::

## Managing what you've published

- **List:** `GET /api/publish/artifacts` returns everything you can see (yours + anything shared with you).
- **Update:** change `title`, `description`, or `visibility` (owner/admin).
- **Unpublish:** delete an item — it's soft-deleted and immediately drops from all listings and stops serving (404). The slug becomes free to reuse.

## Safety notes

- **Public means public.** Anyone with a public link can view it — don't publish anything you wouldn't post openly. Being absent from search results is not protection; see [Search engines](#search-engines).
- **Published artifact bundles run on a separate origin.** Author JavaScript does execute, but never on the app's origin. On a normal deployment each artifact is framed from **its own per-artifact origin** (`{id}.usercontent.app.<domain>`) — that separate origin *is* the isolation boundary, and it also isolates artifacts from each other. Because it is cross-origin to the app, code in the bundle cannot read the app's cookies or `localStorage`, and cannot call `/api/*` with your credentials. (Where that per-artifact host isn't provisioned, the bundle falls back to a same-origin `<iframe sandbox="allow-scripts">` `srcdoc` with **no** `allow-same-origin`, which puts it on an opaque origin instead. Both paths keep the app origin out of reach; they differ in mechanism.)
- Bundles are validated at publish time: no `iframe`s, no `eval`/`new Function`/`document.write`, and assets/scripts must come from an allowlist.

## API reference (power users)

All publish endpoints require auth (`x-api-key` or a bearer token). See the [Publish & Share Cookbook](./publish-and-share-cookbook.md) for copy-paste recipes.

| Method & path | Purpose |
|---|---|
| `POST /api/publish/reply` | Publish a reply (`{ sessionId, messageId }`) |
| `POST /api/publish/fabfile` | Publish a file (`{ fabFileId }`) |
| `POST /api/publish/artifact/upload-url` | Step 1: request presigned upload(s) for a bundle |
| `POST /api/publish/artifact/finalize` | Step 3: validate + publish the uploaded bundle |
| `GET /api/publish/artifacts` | List artifacts you can see |
| `GET /api/publish/artifacts/{publicId}` | Fetch one |
| `PATCH /api/publish/artifacts/{publicId}` | Update title/description/visibility, or `{"discoverable": true\|false}` to change the search listing |
| `DELETE /api/publish/artifacts/{publicId}` | Unpublish (soft-delete) |
