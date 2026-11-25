---
title: Publish & Share
description: Publish any reply, artifact, or file to a public link and share it on Bluesky, X, or LinkedIn
sidebar_position: 22
tags: [publish, share, artifacts, social, hosting]
---

# Publish & Share

Turn anything you create in Bike4Mind into a shareable, hosted page. **Create and share** lets you publish three kinds of content to a clean public URL — and broadcast it with one click to Bluesky, X/Twitter, or LinkedIn (or copy the link / the markdown).

## What you can publish

| Surface              | Where                                           | Public URL          |
| -------------------- | ----------------------------------------------- | ------------------- |
| **A reply**          | The `⋮` menu on any assistant reply → **Share** | `/p/r/{id}`         |
| **A file (FabFile)** | A file's `⋮` menu → **Publish to public link**  | `/p/f/{id}`         |
| **An artifact**      | The Artifacts gallery `⋮` menu → **Share**      | `/p/u/{you}/{slug}` |

Each publish opens a dialog with the live URL plus the social-share bar (Bluesky · X · LinkedIn · Copy Link · Copy Markdown · native share).

## How it works

- **Replies and files** are snapshotted server-side and rendered as a clean, read-only page (markdown for replies, the file body for files). The snapshot means the page keeps working even if you later edit the original.
- **Artifacts** are published as a hosted static bundle: your artifact is rendered to a single `index.html` and served under your scope. HTML and SVG artifacts become real pages. React artifacts run interactively on the isolated published page, including an entry and the sibling React files it imports from the same reply. Other types render their source.

Published pages are served under Bike4Mind's own domain with strict, per-page Content-Security-Policy and a visibility check on every request.

The Live Artifacts gear opens when you publish a page. Its reward becomes eligible after another signed-in account with a verified email views the page. Your own account must also meet the verification and account-age requirements shown in Gears.

## Publish a multi-file React app

Ask for the entry and all its sibling React files in the same reply. Each sibling needs a unique identifier matching the name used by its relative imports, such as `import Counter from './Counter'` and `identifier="Counter"`.

Open **Share** on the entry artifact's card or in its side panel, choose the audience, and create the share link. The entry and the files it imports publish together as one interactive page. Publishing the whole reply still shows React artifacts as source code.

To pick up edits to the entry or its existing siblings, use **Refresh from source** in your published-artifacts list. If you add or rename an imported file, publish again from the entry card so the new file set is included.

## Visibility — who can see it

Every published item has a visibility tier. They form an ordered ladder from most- to least-restricted:

| Visibility       | Who can view                                |
| ---------------- | ------------------------------------------- |
| **private**      | You (the owner) and admins                  |
| **project**      | Members of the project it's published under |
| **organization** | Members of your organization                |
| **public**       | Anyone with the link (no sign-in)           |

Defaults depend on where you publish (your **user** space defaults to _private_; an **organization** space defaults to _organization_). You can change an item's visibility any time from your published-artifacts list — making a private item public, or taking a public one back to private.

:::tip
A **public** link works for anyone, even logged out. A **private/project/organization** link requires the viewer to be signed in and authorized — anonymous visitors get a 401.
:::

## Search engines

**Public does not mean listed in Google.** These are two different promises, and Bike4Mind keeps them separate:

- **"Anyone with the link can view"** — what _public_ means. The page loads for anyone you send the URL to, signed in or not.
- **"Findable by searching"** — a _separate_ opt-in, off by default.

Every published page is served with `noindex, nofollow` (as both an `X-Robots-Tag` header and an in-page `<meta name="robots">`) unless you explicitly turn on **List in search engines** in the share dialog. That switch appears only for a public, ungated item, because it can't do anything otherwise.

What the opt-out does _not_ affect:

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
- **Published artifact bundles run on a separate origin.** Author JavaScript does execute, but never on the app's origin. On a normal deployment each artifact is framed from **its own per-artifact origin** (`{id}.usercontent.app.<domain>`) — that separate origin _is_ the isolation boundary, and it also isolates artifacts from each other. Because it is cross-origin to the app, code in the bundle cannot read the app's cookies or `localStorage`, and cannot call `/api/*` with your credentials. (Where that per-artifact host isn't provisioned, the bundle falls back to a same-origin `<iframe sandbox="allow-scripts">` `srcdoc` with **no** `allow-same-origin`, which puts it on an opaque origin instead. Both paths keep the app origin out of reach; they differ in mechanism.)
- Bundles are validated at publish time: no `iframe`s, no `eval`/`new Function`/`document.write`, and assets/scripts must come from an allowlist.

## Publish a stored artifact with the v1 API

The v1 API publishes an artifact you already stored in Bike4Mind. You send the artifact id; the server reads the stored content itself, so you do not upload any bytes. See the [Cookbook](./publish-and-share-cookbook.md) recipes "Publish a stored artifact with the v1 API" and "Refresh or take down a v1 page" for copy-paste commands.

### Endpoints

| Method & path                           | Purpose                                                                                  |
| --------------------------------------- | ---------------------------------------------------------------------------------------- |
| `POST /api/v1/artifacts/{id}/publish`   | Publish the artifact's current version. Optional `slug`, `visibility` and `access_gate`. |
| `POST /api/v1/artifacts/{id}/republish` | Replace the page's content with the artifact's current version. Takes no body.           |
| `DELETE /api/v1/artifacts/{id}/publish` | Take the page down. The artifact itself is unchanged and can be published again.         |

All three need an API key or bearer token with the `artifacts:publish` scope, and only the artifact's owner can use them. For publish and republish, an artifact that is shared with you, a deleted one and one that does not exist all answer `404`. Unpublish answers `404` only when you have no published page for that id, so you can still take down a page whose artifact was deleted.

### The flow

1. **Publish.** `POST /api/v1/artifacts/{id}/publish` with an optional body. An empty body publishes the page publicly under a slug generated from the artifact's title. A successful publish returns `201`.
2. **Read the response.** It carries the page's absolute `url`, its `slug`, its `visibility`, the kind of gate it has (`access_gate.kind`, or `null`), `published_version` and `published_at`. The passphrase is never returned.
3. **Republish when the artifact changes.** `POST /api/v1/artifacts/{id}/republish` keeps the address, visibility and gate, and keeps earlier versions of the page. It returns `200` with the page.
4. **Unpublish to take it down.** `DELETE /api/v1/artifacts/{id}/publish` returns `204`.

The request body of publish accepts only these fields; any other field is rejected.

| Field         | Meaning                                                                                                                                              |
| ------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- |
| `slug`        | The page address, 3 to 64 characters of lowercase letters, digits and single hyphens. Omitted: one is generated from the title.                      |
| `visibility`  | `private`, `organization` or `public`. Default `public`.                                                                                             |
| `access_gate` | `{"kind":"passphrase","passphrase":"<8 to 128 characters>"}` or `{"kind":"domain","allowed_domains":["example.com"]}`. `allowed_domains` takes 1 to 20 domains. Needs `visibility: "public"`. |

The gate and the visibility are written in the same request, so a gated page is never reachable without its gate. The passphrase is stored only as a hash. An `allowed_domains` entry admits a viewer whose verified email is on that domain or one of its subdomains; each entry must be a registrable domain, not a public suffix such as `co.uk`.

### The page address

The URL is absolute, for example `https://app.example.com/p/u/<userId>/<slug>`. The address contains your user id, so anyone who has the link can see that id. The address format is the same for every page you publish and does not change.

### The `artifacts:publish` scope

- API keys created before this scope existed need `artifacts:publish` added. Creating a key with **Full access** includes it.
- The scope covers the three v1 routes above. It also applies when you call these web app routes with an API key: `POST /api/publish/artifact/upload-url`, `POST /api/publish/artifact/finalize`, `GET /api/publish/artifacts` and `/api/publish/artifacts/<id>`. Existing keys keep working on those routes for now; add `artifacts:publish` to any key you publish with.
- The scope does not let a key read your stored artifacts. Add `notebooks:read` as well if the same key also lists or fetches artifacts through `/api/v1/artifacts`.

### What gets published

The server renders the artifact's current version into one `index.html`, and the page shows that version.

| Artifact type            | Published page                                                                                                                                        |
| ------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------- |
| `html` (a full document) | Served as it is, with the share footer added before `</body>`.                                                                                        |
| `html` (a fragment)      | Wrapped in a minimal page shell. A fragment is any content with no `<html>` tag.                                                                      |
| `svg`                    | Wrapped in the same page shell.                                                                                                                       |
| `react`                  | Built into an interactive page. Only single-file React artifacts publish this way; for several files, use the in-app **Share** on the entry artifact. |
| Any other type           | Shown as source code.                                                                                                                                 |

### Limits and validation

- The rendered `index.html` can be at most 10 MB. A bigger one fails with `422` and a `violations` entry of type `size_exceeded`.
- The page is validated before it goes live: no `iframe`s, no `eval`, `new Function` or `document.write`, and scripts and stylesheets must come from the allowlist. A rejected page returns `422` with a `violations` list; each entry has a `type`, a `message` and, when known, a `file` and `line`.
- Your total published storage has a limit. A page that would go over it returns `400` with `errorCode: "storage_limit_exceeded"`.
- Each publish or republish counts once against a daily allowance over a rolling 24 hours: 200 actions, or 20 actions during the first 7 days of an account. Admins are not limited. Past it you get `429` with `code: "publish_rate_limited"` and a `Retry-After` header. A publish that fails before the page is written hands its action back.
- The usual per-user API rate limit also applies and answers `429`.
- These slugs are reserved and return `422`: `api`, `admin`, `static`, `p`, `u`, `o`, `pj`, `r`, `f`, `a`, `_next`, `health`.

### Errors

| Status | When                                                                                                                                                                                                                      |
| ------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `400`  | The page would exceed your storage limit.                                                                                                                                                                                 |
| `403`  | The key does not have `artifacts:publish`, or your organization's sharing settings do not allow public links (publish with `visibility: "public"`, or republish a page that is public or has a share link).               |
| `404`  | The artifact is not yours to publish, or (republish, unpublish) it has no published page.                                                                                                                                 |
| `409`  | Publish: the artifact already has a page, the slug is used by another of your pages, or another request published the same artifact first. Republish: the page changed or a revision is in progress; reload it and retry. |
| `422`  | Invalid body, `access_gate` without `visibility: "public"`, a reserved slug, a domain that is not registrable, an empty artifact, or a page that failed validation.                                                       |
| `429`  | Rate limit or daily allowance reached.                                                                                                                                                                                    |

If two requests publish the same artifact at once, one succeeds and the other gets `409`. Call republish instead of retrying publish.

### Unpublish and caching

Unpublishing a page that has a passphrase or domain gate stops it serving right away: the next request returns `404`. An ungated public page is also cached at the edge, so it can keep serving the old content for a few seconds after the unpublish.

## API reference (power users)

All publish endpoints require auth (`x-api-key` or a bearer token). See the [Publish & Share Cookbook](./publish-and-share-cookbook.md) for copy-paste recipes.

For a user-scoped bundle, set `scopeId` to your authenticated user ID. Your editable
display name or username does not select a publishing namespace.

| Method & path                              | Purpose                                                                                              |
| ------------------------------------------ | ---------------------------------------------------------------------------------------------------- |
| `POST /api/publish/reply`                  | Publish a reply (`{ sessionId, messageId }`)                                                         |
| `POST /api/publish/fabfile`                | Publish a file (`{ fabFileId }`)                                                                     |
| `POST /api/publish/artifact/upload-url`    | Step 1: request presigned upload(s) for a bundle                                                     |
| `POST /api/publish/artifact/finalize`      | Step 3: validate + publish the uploaded bundle                                                       |
| `GET /api/publish/artifacts`               | List artifacts you can see                                                                           |
| `GET /api/publish/artifacts/{publicId}`    | Fetch one                                                                                            |
| `PATCH /api/publish/artifacts/{publicId}`  | Update title/description/visibility, or `{"discoverable": true\|false}` to change the search listing |
| `DELETE /api/publish/artifacts/{publicId}` | Unpublish (soft-delete)                                                                              |

To publish a stored artifact by its id, use the `artifacts:publish` routes in [Publish a stored artifact with the v1 API](#publish-a-stored-artifact-with-the-v1-api).

### The upload flow (bundles)

Use `/api/publish/artifact/upload-url` and `/api/publish/artifact/finalize` when you publish a folder of files rather than a stored artifact. The steps are upload-url, then a `PUT` of each file to its returned URL, then finalize.

- In the upload-url request, each file's `size` must equal the byte length you upload, and the `PUT` must send the same `Content-Type` as the file's `mimeType`. The upload URL is signed for exactly that size and type.
- Upload URLs expire after 10 minutes. Request new ones if you run past that. If an entry in `uploadUrls` also has a `headers` object, send those headers with the `PUT`.
- A bundle holds at most 50 files, 10 MB each and 50 MB in all, with exactly one `index.html` at the root. Allowed types are images, fonts, audio, video, and HTML, CSS, plain text, Markdown, JavaScript, JSON, WebAssembly, web manifest, XML, PDF and `application/octet-stream`.
- File paths cannot contain `..`, a leading `/`, a backslash or control characters.
- `slug` is lowercase kebab-case, 3 to 64 characters, and not one of the reserved slugs listed above. Publishing the same `{scopeId, slug}` again replaces the page.
- These routes count against the same daily allowance, once per bundle at upload-url.
- Finalize returns the relative path (`/p/u/<userId>/<slug>`); prefix it with your app's base URL for a link you can open.

## Troubleshooting

- `POST /api/publish/gate/passphrase` answers `400` with `error: "Invalid request"` and a `details` array when its body is wrong. Each entry has a `code`, a `path` (for example `["path"]`) and a `message`. The body fields are `path` (the page's viewer path, not `pathname`) and `passphrase`. A wrong passphrase, an unknown or ungated page, and a locked viewer stay terse: `403`, `404` and `423`.
- If a React publish reports `Cannot resolve`, check that every imported sibling appears in the same reply and that its identifier matches the import's basename. Give files distinct names even when case or extensions differ.
- If refresh reports that a sibling cannot be found, restore the file in its original chat or publish the current entry and its files again. Refresh uses the source chat and the sibling names recorded when you published.
- Use static imports for published React apps. Dynamic `import()` is rejected at publish time. Unsupported packages also produce a named validation error; use a supported package or inline the code.
- Use inline CSS for published React layouts. Tailwind classes do not load on the published page, and charts need explicit dimensions to render reliably.

- If a user-scoped upload returns 403, check that `scopeId` is your user ID.
- After too many incorrect passphrase attempts, wait for the retry interval before
  trying again. The limit applies to your IP address for that artifact.
- A bundle can hold several pages. Any other `.html` file in it opens at its own URL
  (for example `/p/u/{scopeId}/{slug}/guide/intro.html`) in the same protected viewer as
  the main page, and one passphrase unlock covers every page in the bundle. Link pages
  to each other with relative links such as `guide/intro.html` or `../index.html`.
- PDFs, MP4/WebM video, audio and common image formats in a bundle open in the browser
  when linked, and `<video>`/`<audio>` elements play with seeking, including on
  passphrase-protected pages. They are delivered from file storage through short-lived
  links issued after the access check. Use MP4 rather than HLS for video.
- Those storage links stay valid until they expire: 15 minutes for a file you open or
  download. Media playing in a passphrase-protected page keeps working until the unlock
  that opened the page expires (at most 2 hours). On pages protected by sign-in, an
  organization, an email domain or a protected share link, media links last 15 minutes,
  so a long video can stop seeking after that; reload the page to get fresh links.
  Unpublishing an artifact, changing its passphrase, revoking a share link or removing
  someone from an organization does not revoke links already issued. Treat those changes
  as taking effect once those windows have passed.
- A script in the page that loads its own audio, video or PDF (for example with `fetch`)
  gets the file from the page's own address, so it works as long as the file is under
  about 4 MB. Larger files, and files played by a plain `<video>`/`<audio>` element, come
  from file storage.
- An HTML export, and a protected page on a deployment without file storage links,
  include media files directly in the page while they fit (3 MB per file, 6 MB in all).
  Files that do not fit are left out, and the response names them in its
  `X-Publish-Dropped-Asset-Names` header.
- Do not put a `%` in a bundle file or folder name. Such a file cannot be opened from a link
  or by its URL; rename it (for example `100-percent.pdf`) before publishing.
- Other files (archives, SVG, data files) download when opened. Add `?download=1` to any
  file's URL, a page's included, to download it instead of viewing it.
- WebAssembly modules are served as `application/octet-stream`, so
  `WebAssembly.instantiateStreaming` rejects them. Load them with
  `WebAssembly.instantiate` on the fetched bytes instead.
