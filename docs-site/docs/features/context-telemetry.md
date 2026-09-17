---
title: Performance Telemetry
description: How Bike4Mind collects and protects pseudonymized performance telemetry
sidebar_position: 22
tags: [telemetry, privacy, gdpr, settings]
---

# Performance Telemetry

Bike4Mind collects pseudonymized performance telemetry to monitor service reliability, detect anomalies, and optimize costs. This page explains what we collect, how we protect your privacy, and how to control your preferences.

## What We Collect

Telemetry captures operational metadata from AI completions — **never your prompts, responses, or personal information**.

| Data | Examples |
|------|----------|
| **Model metrics** | Which AI model was used, response time, token counts |
| **Performance** | Latency, cache hit rates, cost per request |
| **Anomalies** | Context overflow, tool failures, slow responses |
| **Tool usage** | Which tools were invoked, success/failure counts |

## What We Never Collect

- Your prompts or messages
- AI responses or generated content
- Your name, email, or any direct identifiers
- Uploaded files or their contents

## Privacy Protection

All telemetry data is **pseudonymized** using cryptographic one-way hashes (HMAC-SHA256) with daily rotating keys. This means:

- Your telemetry entries cannot be traced back to you
- Even Bike4Mind administrators cannot identify which user generated a telemetry entry
- A different hash is generated each day, preventing long-term tracking
- No lookup table exists that maps hashes to users

## Your Consent Choices

You can choose your telemetry level at any time in **Profile > Settings > Help Improve Bike4Mind**:

### None
- No telemetry is collected
- All your existing telemetry data is permanently deleted
- You can re-enable at any time

### Basic (default)
- Operational metrics only: model selection, response times, token counts, tool success/failure rates
- Collected under our legitimate interest in service reliability (GDPR Article 6(1)(f))
- Excludes fields that could fingerprint your behavior

### Enhanced
- Everything in Basic, plus detailed diagnostics: context composition breakdown, system prompt details, cache efficiency, truncation patterns, and tool error details
- Requires your explicit opt-in consent
- Helps us diagnose complex issues faster

## Your Own Context Breakdown

Every message you send has a **Context** entry in its message menu. It opens a breakdown of that one turn: how many tokens each system-prompt layer, tool definition, attached file and conversation-history entry used, which layers were dropped and why, what retrieval found, how much of the model's context window was left over, and the cache read/write split.

- **Your own turns only.** People you share a notebook with cannot open it, and neither can Bike4Mind administrators - their inspector reads only the pseudonymized telemetry described above.
- **Counts and names, never content.** No prompt text, no reply text, no tool output.
- **Available at Basic and Enhanced.** At None the entry is hidden and the request behind it is refused.
- **Independent of the administrator's sharing setting.** If your administrator has not enabled telemetry sharing, nothing is sent to us, but your level still decides whether you can open this view.
- **Computed on demand, never stored.** It is derived from the message in your notebook rather than from your telemetry record, so it lasts exactly as long as that message does and disappears when you delete it. Telemetry records are still deleted at 90 days.

## Data Retention

All telemetry data is **automatically deleted after 90 days**. There is no way to extend this — the cleanup runs daily.

## Your Rights

- **Opt out at any time** — Switch to "None" and all historical data is immediately deleted
- **Export your data** — Click "Export My Data" next to the telemetry level buttons to download a JSON file of all your telemetry records
- **Right to erasure** — Handled automatically when you opt out; no need to contact support

## Legal Basis

- **Basic tier**: Legitimate interest in operational reliability and service quality (documented in our Legitimate Interest Assessment per EDPB Guidelines 1/2024)
- **Enhanced tier**: Your explicit consent, which you can withdraw at any time by switching to Basic or None
