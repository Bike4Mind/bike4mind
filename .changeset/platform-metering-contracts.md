---
"@bike4mind/common": major
"@bike4mind/llm-adapters": major
"@bike4mind/services": major
---

Require durable batch settlement methods on `ITransformBatchRepository`, include each batch result's `customId`, and include per-call billing usage on `IntentDecision`. Custom repository adapters and typed completion fixtures must supply these new required members.

Remove the retired Google Calendar integration and its setting keys from the public common contracts, and remove `creditTransactionRepository` from `NotebookCurationAdapters`; hosts now meter executive-summary completions instead of deducting a flat curation fee.
