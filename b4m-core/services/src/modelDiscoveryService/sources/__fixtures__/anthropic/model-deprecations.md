# Model deprecations


## Overview

Anthropic uses the following terms to describe the model lifecycle: Active, Legacy, Deprecated, Retired.

## Model status

<Note>
  [Claude Mythos Preview](https://anthropic.com/glasswing) (`claude-mythos-preview`) is deprecated. To migrate to [Claude Mythos 5](https://anthropic.com/glasswing) (`claude-mythos-5`), see the [migration guide](/docs/en/about-claude/models/migration-guide#migrating-from-claude-mythos-preview).
</Note>

Current and recently retired models are listed in the following table with their status:

| API model name             | Current state | Deprecated        | Tentative retirement date          |
| -------------------------- | ------------- | ----------------- | ---------------------------------- |
| claude-fable-5             | Active        | N/A               | Not sooner than June 9, 2027       |
| claude-opus-5              | Active        | N/A               | Not sooner than July 24, 2027      |
| claude-opus-4-8            | Active        | N/A               | Not sooner than May 28, 2027       |
| claude-opus-4-7            | Active        | N/A               | Not sooner than April 16, 2027     |
| claude-opus-4-6            | Active        | N/A               | Not sooner than February 5, 2027   |
| claude-opus-4-5-20251101   | Active        | N/A               | Not sooner than November 24, 2026  |
| claude-opus-4-1-20250805   | Deprecated    | June 5, 2026      | August 5, 2026                     |
| claude-opus-4-20250514     | Retired       | April 14, 2026    | June 15, 2026                      |
| claude-sonnet-5            | Active        | N/A               | Not sooner than June 30, 2027      |
| claude-sonnet-4-6          | Active        | N/A               | Not sooner than February 17, 2027  |
| claude-sonnet-4-5-20250929 | Active        | N/A               | Not sooner than September 29, 2026 |
| claude-sonnet-4-20250514   | Retired       | April 14, 2026    | June 15, 2026                      |
| claude-3-7-sonnet-20250219 | Retired       | October 28, 2025  | February 19, 2026                  |
| claude-haiku-4-5-20251001  | Active        | N/A               | Not sooner than October 15, 2026   |
| claude-3-5-haiku-20241022  | Retired       | December 19, 2025 | February 19, 2026                  |
| claude-3-haiku-20240307    | Retired       | February 19, 2026 | April 20, 2026                     |

## Deprecation history
### 2026-06-05: Claude Opus 4.1 model

On June 5, 2026, Anthropic notified developers using Claude Opus 4.1 of its upcoming retirement on the Claude API.

| Retirement date | Deprecated model           | Recommended replacement |
| --------------- | -------------------------- | ----------------------- |
| August 5, 2026  | `claude-opus-4-1-20250805` | `claude-opus-4-8`       |

### 2026-04-14: Claude Sonnet 4 and Claude Opus 4 models

<Note>
  These models were retired June 15, 2026.
</Note>

On April 14, 2026, Anthropic notified developers using Claude Sonnet 4 and Claude Opus 4 models of their upcoming retirement on the Claude API.

| Retirement date | Deprecated model           | Recommended replacement |
| --------------- | -------------------------- | ----------------------- |
| June 15, 2026   | `claude-sonnet-4-20250514` | `claude-sonnet-4-6`     |
| June 15, 2026   | `claude-opus-4-20250514`   | `claude-opus-4-8`       |

### 2026-02-19: Claude Haiku 3 model

<Note>
  This model was retired April 20, 2026.
</Note>

On February 19, 2026, Anthropic notified developers using Claude Haiku 3 model of its upcoming retirement on the Claude API.

| Retirement date | Deprecated model          | Recommended replacement     |
| --------------- | ------------------------- | --------------------------- |
| April 20, 2026  | `claude-3-haiku-20240307` | `claude-haiku-4-5-20251001` |
