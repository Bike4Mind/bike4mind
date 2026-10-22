---
title: Claude Fable 5 & Claude Mythos 5
description: Archived system card for Anthropic's Mythos-class frontier model (Fable 5 / Mythos 5)
sidebar_position: 2
---

# Claude Fable 5 &amp; Claude Mythos 5 — System Card

> **Status — suspended.** Access to Claude Fable 5 and Claude Mythos 5 was
> suspended on **June 12, 2026** following a US government export-control
> directive. Anthropic has stated it is working to restore access. **The system
> card itself remains published** — which is why we archive it here.

## The document

- 🔗 **Canonical landing page:**
  [anthropic.com/claude-fable-5-mythos-5-system-card](https://www.anthropic.com/claude-fable-5-mythos-5-system-card)
- 📰 **Launch announcement** (carries the suspension notice):
  [anthropic.com/news/claude-fable-5-mythos-5](https://www.anthropic.com/news/claude-fable-5-mythos-5)
- 📄 **PDF (~26 MB, 319 pages):** the full system card is kept as a local archive
  **outside the repo** (it's a 26 MB binary — too heavy to track in git). Fetch a
  fresh copy from the canonical landing page above, which redirects to the
  published PDF.

## What the card documents

### Two configurations, one model

Fable 5 and Mythos 5 are the **same underlying model** exposed under two
configurations:

- **Fable** — stricter, built-in safeguards. The default, broadly available
  configuration.
- **Mythos** — fewer constraints in some areas, with correspondingly tighter
  access controls.

### Safeguard architecture

- **Domain routing.** Queries flagged by the cyber and biology safeguards are
  automatically routed to **Opus 4.8** instead of being answered by Fable.
- **Transparency.** Users are informed whenever this redirection occurs.
- **Frequency.** Anthropic expects routing to trigger in fewer than 5% of
  interactions with the model.
- **Data retention.** Using Fable requires **30-day data retention** for safety
  monitoring.

### Alignment results

- Mythos 5's measured level of misaligned behavior was **low, and similar to
  that of Opus 4.8**.
- The card includes automated alignment-evaluation metrics demonstrating
  comparable performance to earlier models, alongside the full suite of
  safeguard evaluations.

### Capabilities

State-of-the-art on nearly all tested benchmarks, with exceptional performance
in:

- Software engineering / agentic coding
- Knowledge work
- Scientific research
- Vision and computer use

## Why this lives in our docs

Bike4Mind's architecture treats the frontier model as a **swappable engine**
behind a disciplined propose-approve pipeline. When an engine is pulled out from
under us — by deprecation, suspension, or regulation, as happened here — the
contract we relied on (its safeguards, routing behavior, alignment posture, and
capability envelope) still matters for everything we built on top of it. The
model card is that contract in writing, so we keep it.

## Sources

- [Claude Fable 5 and Claude Mythos 5 — Anthropic](https://www.anthropic.com/news/claude-fable-5-mythos-5)
- [Claude Fable — Anthropic](https://www.anthropic.com/claude/fable)
- [Anthropic Claude Fable 5 on AWS — AWS News Blog](https://aws.amazon.com/blogs/aws/anthropic-claude-fable-5-on-aws-mythos-class-capabilities-with-built-in-safeguards-now-available/)
- [Claude Fable 5 brings Mythos to the masses — Tom's Hardware](https://www.tomshardware.com/tech-industry/artificial-intelligence/claude-fable-5-brings-mythos-to-the-masses-anthropics-next-frontier-model-is-state-of-the-art-on-nearly-all-tested-benchmarks)
