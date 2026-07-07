---
title: LibreOncology
description: A grounded, citation-first radiation-oncology learning surface built on the curated library
sidebar_position: 30
tags: [libreoncology, grounded-ai, citations, oncology, education]
---

# LibreOncology

LibreOncology is a self-contained learning surface for radiation oncology, built on top of the
Bike4Mind grounded-AI engine. Every answer it gives is retrieved from a **curated library** and
**cited** — it never draws on the open web, and it never shows uncited clinical content.

It is a focused v1: nine disease-site courses, a grounded tutor, AI-generated reference lessons,
a clinical reference tool, and a set of mission/transparency pages — all gated behind the
`libreoncology` access tag (admins bypass).

## Who can see it

LibreOncology is **tag-gated**. A user reaches it only if they carry the `libreoncology` feature
tag (or are an admin). The same check guards both the routes and the API endpoints, so an
ungated user can neither load a page nor call a LibreOncology endpoint.

## Navigation map

| Surface | Route | What it is |
| --- | --- | --- |
| **Home** | `/libreoncology` | The public landing page (login-only) — mission, credibility, and CTAs into the Tutor and course catalog. |
| **Tutor** | `/libreoncology/tutor` | The grounded chat (**subscriber-gated**) — ask anything; answers cite the curated library. Includes Prompt Templates, a Recent/Saved conversation rail, and a "Grounded" transparency badge. |
| **Courses** | `/libreoncology/courses` | The disease-site catalog (public/login-only) — nine sites (Head & Neck, Thoracic, Breast, Genitourinary, GI, Gynecologic, CNS & Brain, Heme/Lymphoma, Benign). |
| **Course** | `/libreoncology/courses/{course}` | A site's page (**subscriber-gated**): a **Content** tab listing the curated source documents, and a **Tutor** tab — a tutor scoped to that site's library. |
| **Module pathway** | `/libreoncology/courses/{course}/pathway/{module}` | A generated, grounded guided experience (**subscriber-gated**) whose **format follows the source content**: an **oral-exam** (stepped examiner question → reveal the cited expected answer) or a **walkthrough** (a scrollable cited article). Each carries an `AI draft — not reviewed` badge, a Sources view, "Ask the tutor," and Regenerate. Modules are derived from the lake (lake-leads), not a fixed section template. |
| **Resources** | `/libreoncology/resources` | A static clinical reference (public/login-only): dose constraints, fractionation schemes, and curated external references. Each row can hand a question to the tutor. |
| **Docs** | `/libreoncology/docs` | The founding documents (public/login-only) — vision, problem statement, business model, roadmap, and more. |
| **About / Transparency** | `/libreoncology/about`, `/libreoncology/transparency` | Mission and credibility pages (public/login-only). |
| **Admin** | `/libreoncology/admin`, `/libreoncology/admin/courses/{course}` | The authoring dashboard and per-course editor (**author-gated** — see [Authoring and review](#authoring-and-review-admin)). |

The public **Home** is the default index (`/libreoncology`); the Tutor and course content require a `libreoncology:pro` subscription (existing tagged users keep access via the comp-tag grant). Unsubscribed users hitting a gated surface are routed to `/libreoncology/upgrade`.

## What makes the answers trustworthy

### Grounded retrieval

Every tutor turn and every generated lesson runs **forced knowledge retrieval**: the curated
library is searched and injected as context before the model answers. Grounding does not depend
on the model choosing to call a tool — it always happens. Cited sources appear as a Sources strip;
clicking one opens the underlying passage in an in-surface drawer (read the source the answer came
from, without leaving the page).

### Curated sources only

Open-web tools are disabled on every LibreOncology session — no web search, no web fetch. This is
a fixed product guarantee, not a user setting. The **Grounded** badge in the header opens a
transparency panel that reads the session's real configuration back to you:

- **Grounded retrieval** — on
- **Curated sources only** — on
- **Course context** — the disease site(s) the tutor is focused on (or the whole library)
- **Web search** — off, by design

### Honest refusal

If the curated library cannot ground a topic, LibreOncology says so. A generated lesson that
returns no sources renders an explicit "couldn't ground this module" state rather than uncited
clinical content. Generated material is labeled as evidence synthesis — not personalized medical
advice.

## Working with the tutor

- **Prompt Templates** — a palette of clinical starting points (Explain Like a Mentor, Board Review
  Question, Treatment Decision Tree, Compare Approaches, Summarize the Evidence, Oral Exam Practice,
  Contouring Guide, Dose Constraints Review). Selecting one drops the prompt into the input for you
  to complete — it never auto-sends.
- **Selection actions** — select a passage in a source document and choose **Quote**, **Expand**, or
  **Explain**; the selection becomes a grounded prompt prefilled into the tutor.
- **Recent / Saved** — your conversations are listed by recency. Star a conversation to keep it under
  the **Saved** tab.
- **Grounded overview** — a course's Content tab can hand a "summarize this site's library" prompt to
  the scoped tutor.

## Generated module pathways

A module's modules are derived from the curated library (lake-leads): a course-map synthesis pass
enumerates the site's documents and proposes modules, each with a **format that follows its source
content** — an **oral-exam** (stepped examiner question → reveal the cited expected answer) or a
**walkthrough** (a scrollable, cited article). Each module's pathway is generated on demand from a
grounded turn and **cached on a backing session**, so a returning user (on any device) gets the
cached pathway with no new model call. **Regenerate** runs a fresh grounded turn; the **Sources**
view opens the cited documents. Every pathway shows an `AI draft — not reviewed` badge until a
specialist signs off — grounded clinical content is never shown without it.

## Authoring and review (admin)

Course-map content ships through a **draft → human review → publish** pipeline, operated from an
admin surface at `/libreoncology/admin`. Learners only ever see **published** content — an AI
draft, however fresh, is invisible until an author publishes it.

### The author role

The admin surface and its APIs gate on the scoped `libreoncology:author` entitlement (granted via
the user tag of the same name; platform admins and developers bypass). Authoring is independent of
the learner subscription — an author needs no `libreoncology:pro` plan, and buying a plan grants no
authoring rights. Authors see an **Admin** link in the LibreOncology header; everyone else doesn't
(and the routes/APIs deny regardless of link visibility).

### Dashboard

One row per disease site: publish state (none / draft only / published), draft status and revision,
the published version, the curated-document count, and two health badges —

- **stale** — the curated library changed since the draft was generated (cheap metadata check, no
  model calls), so a regenerate would see different sources;
- **generation failed** — the last synthesis attempt errored (with the failure message), so
  "no draft" is distinguishable from "generation keeps failing".

**Generate / Regenerate** runs the synchronous course-map synthesis (up to ~a minute). A draft a
human has touched is **never overwritten by regeneration** — the run is skipped and the dashboard
says so; discard the draft first to start over from clean AI output.

### Course editor

Per-course editing over the draft: rename/describe modules, switch a module's format
(oral-exam / walkthrough), reorder, merge two modules (source documents are combined server-side),
delete a module, or discard the whole draft. Every field carries an **ai / human provenance chip**,
so a reviewer can see at a glance which content is untouched AI output versus curated by a person.

Edits are optimistic-concurrency guarded: if the draft changed elsewhere (another author, a
regenerate) the change is rejected, the editor refreshes to the latest state, and a banner says so
— stale edits can never silently overwrite newer work.

**Publish** snapshots the reviewed draft as the next immutable version and makes it live for
learners; **Unpublish** takes the live snapshot down (learners see the empty state) while all
version history is kept. Publishing an empty draft is rejected — deliberate blanking goes through
Unpublish.

### Version history and audit

The editor's **Version history** tab lists every published version (who, when, from which draft
revision) and can open any version's full module snapshot. The **Audit** tab shows the append-only
receipt trail — generate, edit, reorder, merge, delete, discard, publish, unpublish — with
identifiers only (module ids, field names, revisions), never content values.

## Notes for operators

- LibreOncology sessions are created server-side with a fixed medical system prompt, the
  curated-sources-only tool configuration, and a lower sampling temperature for clinical accuracy.
  The clinical prompt is never shipped to the client.
- Retrieval is scoped by the user's `libreoncology` tag plus the data lake's required tag; there is
  no separate project record.
- Data lakes for LibreOncology are admin-managed and must be seeded per environment before non-local
  use.
