---
title: Data Lake Cost Governance
description: Set the embedding spend and throughput levers for data-lake ingestion, and read the provider's live rate limits to set them from
sidebar_position: 38
tags: [admin, data-lakes, cost, embedding, rate-limits]
---

# Data Lake Cost Governance

Every file that enters a data lake gets embedded, and every embedding call spends both money and a
share of the provider's rate limit. This settings group is where a platform admin bounds both.

Find it under **Admin -> Settings -> AI -> Data Lake Cost Governance**.

## The levers

| Lever | What it bounds |
|---|---|
| **Data Lake Embedding Spend Enabled** | Master switch. Off means no data-lake file indexes at all. |
| **Embedding Budget Per Run / Per Lake / Per Period (USD)** | Money, at three scopes. `0` means stop, not "unlimited". |
| **Embedding Budget Period (hours)** | The window the per-period budget resets on. |
| **Embedding Max Calls Per Minute** | Provider requests per minute across all data-lake work. |
| **Embedding Max Tokens Per Minute** | Provider tokens per minute -- the quantity providers actually meter. |
| **Vectorize Chunk Batch Size** | How many passages ride in one provider call. |
| **Cost Tier Multipliers** | Scale the run and lake budgets by whether a lake is individual- or organization-owned. |

The two throughput levers are complementary and a call must fit **both**. Calls-per-minute bounds
requests; tokens-per-minute bounds tokens. A call cap alone does not bound tokens, because one call
carries a whole batch of passages.

## Provider limits

Underneath the levers is a **Check provider limits** button. It asks the configured embedding
provider what it currently allows, using the credential that environment already holds, and shows
the answer beside the levers.

Use it before setting the throughput levers. A rate limit belongs to the provider organization
behind the key, so it cannot be known from the code and it differs between environments -- the
shipped defaults are deliberately conservative, sized to be safe on the smallest tier any
deployment might be on, not to describe yours.

The panel reports measured tokens/min and requests/min, what percentage of that your current levers
represent, and a suggested value that leaves headroom for query-side embedding. Query embedding
shares the same per-model pool but is deliberately exempt from these levers, so that a search never
queues behind a bulk re-index.

:::note This costs one small embedding call
The limits only appear on a real provider response, so the button spends a few tokens each time it
is pressed. It never runs on its own -- opening this page reads nothing.
:::

:::warning Re-check after a provider key rotation
A rate limit belongs to the provider organization behind the key, so rotating that key can change
the ceiling -- to a different tier, or to a different organization entirely.

On OpenAI you do not have to remember to look. Every OpenAI embedding call already carries the
ceiling in its response headers, from ingest and from query alike, so workers report what they
measure without being asked and without spending anything extra:

- A key rotated to a **different provider organization** reports as a fresh `[embedding-limits] ...
  ceiling measured` line at info level, naming an organization the log has not carried before. A new
  organization appearing there is itself the signal that the account behind the key moved.
- A ceiling that moves **on the organization you already had** -- a tier or quota change -- logs an
  `[embedding-limits] ... ceiling CHANGED` warning naming the old figure and the new one.

Every line names the provider account it describes. That matters because a user can store their own
provider key under **Profile -> Settings -> API Keys**, and their embedding calls then report their
own organization's ceiling rather than the platform account's. Check which account a line names
before reconciling a platform lever against its figure.

Automatic reporting is OpenAI-only today. VoyageAI publishes the same headers but reaches the
provider through a different SDK call, so it reports nothing on its own -- **Check provider limits**
still reads it on demand. Bedrock and Ollama publish no such headers at all; see [When it says the
limits are unavailable](#when-it-says-the-limits-are-unavailable).

That reporting tells you a reconciliation is due; it does not perform one. Press **Check provider
limits** and bring the levers back in line with what it reports. This matters most on environments
where the key is set by an operator and not held by anyone day to day, which is precisely where a
stale number could otherwise sit unnoticed for a long time.
:::

### When it says the limits are unavailable

- **Bedrock** publishes quotas through AWS Service Quotas rather than response headers, so they
  cannot be read this way. Check the AWS console instead.
- **Ollama** runs locally and has no provider rate limit to report.
- **No credential configured** means there is no account whose limits could be read. Set the
  provider key first.
- **Could not reach the provider** means the reading failed. That is *unknown*, not *unlimited* --
  leave the levers where they are and retry rather than raising them.

## Troubleshooting

**A file failed with "data-lake cost governance denied it".** Expected when a lever is doing its
job. The message names which one: a budget, the master switch, or a throughput limit. Adjust the
named lever, then re-index the file with **Re-process** on the file itself.

**The measured ceiling changed since last time.** Expected after a provider key rotation - the new
key may belong to a different tier or organization. Search the ingest logs for `[embedding-limits]`
to see what each worker measured, when, and for which account. Confirm the line names the platform
account before acting on it: a user with their own stored provider key reports their organization's
ceiling, not yours. Then re-read the levers against the new figure - the change reports itself, but
reconciling it is still a deliberate operator action.

**A lever change did not take effect.** Settings are cached in-process for up to five minutes, so a
running worker can keep using the previous value for a few minutes after a save. Wait it out before
concluding the change did not apply.

**Indexing is slower than expected.** Compare each throughput lever against the measured ceiling
using **Check provider limits**. A lever sitting at a small fraction of measured capacity throttles
bulk re-indexing without any other symptom -- nothing else in the product surfaces that mismatch.

**A single file will not index no matter what.** If one call's tokens exceed the entire
tokens-per-minute window, no amount of waiting helps and the failure is reported as permanent.
Either raise the tokens-per-minute lever or lower the vectorize chunk batch size so each call is
smaller.
