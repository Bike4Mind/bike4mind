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

## Notes for operators

- LibreOncology sessions are created server-side with a fixed medical system prompt, the
  curated-sources-only tool configuration, and a lower sampling temperature for clinical accuracy.
  The clinical prompt is never shipped to the client.
- Retrieval is scoped by the user's `libreoncology` tag plus the data lake's required tag; there is
  no separate project record.
- Data lakes for LibreOncology are admin-managed and must be seeded per environment before non-local
  use.
