---
title: Publish & Share — Cookbook
description: Practical recipes for getting the most out of publish-and-share — from one-click social posts to scripted bundle hosting
sidebar_position: 23
tags: [publish, share, cookbook, recipes, examples, api]
---

# Publish & Share — Cookbook

Practical, copy-paste recipes for [Publish & Share](./publish-and-share.md). Start with the UI recipes; the API recipes at the end are for power users and automation.

---

## In-app recipes

### 1. Share a great answer to LinkedIn

You asked Bike4Mind something and the reply is gold. Share it:

1. Hover the reply → open the `⋮` menu → **Share**.
2. The dialog shows a `…/p/r/{id}` link. Click **LinkedIn** (or **Bluesky** / **X**).
3. Done — the public viewer page renders your reply as clean, formatted markdown.

> The page is a **snapshot** — editing the original session later won't change what you shared.

### 2. Hand a reply to another AI tool

Want to continue a thought in Claude, ChatGPT, or Gemini? In the Share dialog, click **Copy Markdown** — the full reply lands on your clipboard as markdown, ready to paste into any other tool.

### 3. Publish a visual artifact (HTML / SVG) as a real web page

1. Open the **Artifacts** gallery.
2. On an `html` or `svg` artifact, open `⋮` → **Share**.
3. You get a hosted page at `…/p/u/{you}/{slug}` — a real, styled web page anyone can open.

Great for: one-page reports, landing snippets, dashboards built in pure HTML/CSS, diagrams, generated SVG art.

:::tip Static today
Artifacts publish as **static** pages. HTML/CSS and SVG render fully. Artifacts that depend on inline JavaScript (interactive React/Recharts widgets) currently publish as a **source view** — the code shows, but scripts don't run on the app origin (a security measure). For interactive output now, prefer self-contained HTML/CSS/SVG.
:::

### 4. Share a file

In any file list, open a file's `⋮` menu → **Publish to public link** → you get a `…/p/f/{id}` viewer. This is separate from the existing **Share** (invite-based collaboration) — "Publish to public link" creates an anonymous, link-based page.

### 5. Choose the right audience

When publishing, pick the visibility that fits:

| You want… | Use |
|---|---|
| A link for the open internet / social | **public** |
| Something only your company sees | **organization** |
| Something only a project team sees | **project** |
| A private draft only you can open | **private** (the default for your space) |

Change your mind later from your published list — bump a private draft to public when it's ready, or pull a public page back to private.

### 6. Update or take something down

From your published-artifacts list you can edit the title/description, flip visibility, or **delete** to unpublish. Deleting stops the page from serving immediately and frees the slug to reuse.

---

## API & automation recipes

All endpoints take `x-api-key: $YOUR_KEY` (or a bearer token). Examples use `BASE=https://app.bike4mind.com` — swap for your env.

### 7. Publish a reply via API

```bash
curl -s -H "x-api-key: $KEY" -H "Content-Type: application/json" \
  -X POST "$BASE/api/publish/reply" \
  -d '{"sessionId":"<sessionId>","messageId":"<questId>"}'
# → { "publicId": "...", "url": "/p/r/...", "visibility": "private", ... }
```

Re-running with the same `{sessionId, messageId}` is idempotent — you get the same `publicId` back, not a duplicate.

### 8. Publish an HTML bundle via the 3-step flow

This is exactly what the gallery **Share** button does under the hood. Host any folder of static files (one `index.html` at the root, plus assets):

```bash
KEY=$YOUR_API_KEY
BASE=https://app.bike4mind.com
UID=<your-user-id>            # GET /api/identify
SLUG=my-dashboard

# Step 1 — request a presigned upload for each file
UP=$(curl -s -H "x-api-key: $KEY" -H "Content-Type: application/json" \
  -X POST "$BASE/api/publish/artifact/upload-url" \
  -d "{\"tier\":\"user\",\"scopeId\":\"$UID\",\"slug\":\"$SLUG\",\"title\":\"My Dashboard\",
       \"visibility\":\"public\",
       \"files\":[{\"path\":\"index.html\",\"size\":$(wc -c < index.html),\"mimeType\":\"text/html\"}]}")

DRAFT=$(echo "$UP" | jq -r .draftId)
PUTURL=$(echo "$UP" | jq -r '.uploadUrls[0].url')

# Step 2 — upload the bytes straight to storage (presigned PUT)
curl -s -X PUT -H "Content-Type: text/html" --data-binary @index.html "$PUTURL"

# Step 3 — validate + publish
curl -s -H "x-api-key: $KEY" -H "Content-Type: application/json" \
  -X POST "$BASE/api/publish/artifact/finalize" \
  -d "{\"draftId\":\"$DRAFT\"}"
# → { "url": "/p/u/<UID>/my-dashboard", ... }
```

Multi-file bundles: list every file in `files[]` (≤ 50 files, ≤ 10 MB each, ≤ 50 MB total), then `PUT` each returned `uploadUrls[i].url`. Reference assets with **relative** paths in your HTML (`assets/app.css`, `logo.png`) — the serve layer rewrites them to absolute gated URLs automatically.

### 9. Understand validation failures

`finalize` returns `422` with a structured `violations[]` if the bundle is unsafe:

```json
{ "error": "Validation failed",
  "violations": [
    { "type": "forbidden_iframe", "message": "Iframes are not permitted", "file": "index.html" },
    { "type": "csp_violation",    "message": "Disallowed script source: https://cdn.evil/x.js" }
  ] }
```

Common causes: an `iframe`, a non-allowlisted external `script`/`stylesheet` host, `eval`/`new Function`/`document.write` in an inline script, a missing root `index.html`, or a relative asset not present in the bundle.

### 10. List, re-scope, and unpublish

```bash
# Everything you can see
curl -s -H "x-api-key: $KEY" "$BASE/api/publish/artifacts" | jq '.artifacts[] | {slug, visibility, url:("/p/"+ .source.kind)}'

# Make one public
curl -s -H "x-api-key: $KEY" -H "Content-Type: application/json" \
  -X PATCH "$BASE/api/publish/artifacts/<publicId>" -d '{"visibility":"public"}'

# Unpublish (soft-delete)
curl -s -H "x-api-key: $KEY" -X DELETE "$BASE/api/publish/artifacts/<publicId>"
```

---

## Tips & gotchas

- **Slugs are scoped & overwrite-in-place.** Re-publishing the same `{scope, slug}` replaces the previous version (a one-version snapshot is kept for forensics). Use a fresh slug for a distinct page.
- **Public caching.** Public pages get edge-friendly cache headers; non-public pages are `no-store`. After flipping visibility, a public page may take a few minutes to fully propagate.
- **Tokens & safety.** Never paste secrets into a published page — public bundles are world-readable, and even private ones are static snapshots.
- **What renders well as a bundle:** self-contained HTML + CSS, inline SVG, Google-Fonts typography. What doesn't (yet): anything requiring inline JS to be interactive.
