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

## Managing what you've published

- **List:** `GET /api/publish/artifacts` returns everything you can see (yours + anything shared with you).
- **Update:** change `title`, `description`, or `visibility` (owner/admin).
- **Unpublish:** delete an item — it's soft-deleted and immediately drops from all listings and stops serving (404). The slug becomes free to reuse.

## Safety notes

- **Public means public.** Anyone with a public link can view it — don't publish anything you wouldn't post openly.
- **Published artifact bundles are static.** For security, author-supplied inline JavaScript is **not executed** when a bundle is served from the app origin — inline scripts are stripped and the page renders without them. Interactive (JS-driven) artifacts will be supported once bundles are served from an isolated sandbox origin (tracked separately). Today, lean on HTML/CSS and SVG for rich visual artifacts.
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
| `PATCH /api/publish/artifacts/{publicId}` | Update title/description/visibility |
| `DELETE /api/publish/artifacts/{publicId}` | Unpublish (soft-delete) |
