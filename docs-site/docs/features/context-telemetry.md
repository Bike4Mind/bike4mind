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
- The telemetry we can identify from the last 90 days is deleted, and the settings card tells you whether the deletion was confirmed
- You can re-enable at any time

### Basic (default)
- Operational metrics only: model selection, response times, token counts, tool success/failure rates
- Collected under our legitimate interest in service reliability (GDPR Article 6(1)(f))
- Excludes fields that could fingerprint your behavior

### Enhanced
- Everything in Basic, plus detailed diagnostics: context composition breakdown, system prompt details, cache efficiency, truncation patterns, and tool error details
- Requires your explicit opt-in consent
- Helps us diagnose complex issues faster

## Turning Telemetry Off

1. In **Profile > Settings > Help Improve Bike4Mind**, click **None**.
2. In the **Stop Telemetry Collection** dialog, click **Stop & Delete**. This cannot be undone.
3. Collection stops and the card reads "Collection is stopped."
4. Bike4Mind deletes the telemetry it can identify from the last 90 days, then checks that none of it is left.
5. When the check passes, the card shows "Deleted the telemetry we could identify from the last 90 days."

If the deletion cannot be confirmed, the card says so and shows a **Retry deletion** button. Collection stays stopped while you retry. You can also click **None** and **Stop & Delete** again to run the deletion and the check again. If a retry still cannot confirm the deletion, contact support.

The confirmation appears right after the deletion runs. It is not shown again after you reload the page.

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

- **Opt out at any time** - Switch to "None" to stop collection and delete the telemetry we can identify from the last 90 days. The settings card confirms the deletion, or offers a retry if it cannot
- **Export your data** - Click "Export telemetry data" next to the telemetry level buttons to download a JSON file of all your telemetry records. This does not include your notebooks or files; use **Export All** on the Notebooks and Knowledge Files cards in General settings for those
- **Right to erasure** - Runs when you opt out. You only need to contact support if the card still cannot confirm the deletion after a retry

## Legal Basis

- **Basic tier**: Legitimate interest in operational reliability and service quality (documented in our Legitimate Interest Assessment per EDPB Guidelines 1/2024)
- **Enhanced tier**: Your explicit consent, which you can withdraw at any time by switching to Basic or None
