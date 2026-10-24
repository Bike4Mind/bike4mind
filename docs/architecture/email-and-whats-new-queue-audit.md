# Email and What's New queue audit: can any pair share a Lambda?

Audit of the three queue pairs that each run their own consumer Lambda: email marketing, email ingestion, and What's New. This is a record of a decision, not an implementation. Any merge is filed and shipped as its own change.

## Decision rule

Merge two queues into one queue + one consumer Lambda only where **consumer profile, retry policy and memory class all match**. Otherwise keep them separate. If in doubt, keep.

"Consumer profile" follows the existing SRE merge precedent (`infra/queues.ts`, comment above `sreJobQueueDLQ`): timeout, memory, IAM and resource links, and batch shape. It does not mean byte-identical handler code; that merge put two different handlers behind one dispatch discriminated by a `jobType` field.

## Verdicts

| Pair | Queues | Verdict | Reason |
|---|---|---|---|
| Email job / batch | `emailJobQueue`, `emailBatchQueue` | Keep | Memory class, timeout, batch shape and visibility all differ, and the two handlers are a fan-out producer and a sender. |
| Email ingestion / analysis | `emailIngestionQueue`, `emailAnalysisQueue` | Keep | IAM differs (`bedrock:*` plus SES vs `bedrock:InvokeModel`), timeout differs (5 vs 2 minutes), and the parser is an S3-event consumer while the analyzer takes `{ emailId }`. |
| Release notes / highlights | `whatsNewGenerationQueue`, `whatsNewHighlightsQueue` | Merge (follow-up: https://github.com/Bike4Mind/bike4mind/issues/5662) | The two subscriptions match field for field (timeout, links, permissions, files, batch shape) and both use retry 3 with identical 14-day encrypted DLQs. |

Not covered: the Tavern and Analytics candidates and the queue-per-consumer CLAUDE.md rule from the issue's original description. The tightened acceptance dropped them.

## 1. Email marketing

Evidence: `infra/emailMarketing.ts`.

| | `emailJobQueue` (orchestrator) | `emailBatchQueue` (sender) |
|---|---|---|
| Handler | `apps/workers/src/queueHandlers/emailJobOrchestrator.dispatch` | `apps/workers/src/queueHandlers/emailBatch.dispatch` |
| Queue visibility timeout | 10 minutes | 3 minutes |
| Lambda timeout | 5 minutes | 2 minutes |
| Lambda memory | unset (SST default) | 512 MB |
| Batch shape | `SINGLE_RECORD_BATCH` (size 1) | `partialResponses: true` over the handler's record loop |
| Links | secrets, `websocketApi`, `emailBatchQueue`, `eventBus` | secrets, `websocketApi`, `eventBus` |
| Extra env | none | `APP_URL` (tracking links) |
| Retry / DLQ | retry 3, default DLQ (4-day, unencrypted) | retry 3, default DLQ (4-day, unencrypted) |
| Producers | `apps/client/pages/api/admin/email/jobs/[id]/start.ts`, `apps/client/pages/api/admin/email/jobs/[id]/send.ts`, `apps/workers/src/cron/emailCampaignScheduler.ts` | `apps/workers/src/queueHandlers/emailJobOrchestrator.ts` (`Resource.emailBatchQueue.url`) |

Scaling: no reserved concurrency on either. The orchestrator fans a job out into batches of `EMAILS_PER_BATCH = 25` (`emailJobOrchestrator.ts`, same directory), sent 10 messages per `SendMessageBatch`.

Retry policy matches; memory class (unset vs 512 MB), timeout and batch shape do not, and a merged consumer would have to size every orchestrator invocation for the sender. **Verdict: keep.** Reason: the orchestrator and sender fail the profile and memory criteria.

## 2. Email ingestion

Evidence: `infra/emailIngestion.ts`.

| | `emailIngestionQueue` (parser) | `emailAnalysisQueue` (analyzer) |
|---|---|---|
| Handler | `apps/workers/src/emailIngestion/emailParser.dispatch` | `apps/workers/src/emailIngestion/emailAnalyzer.dispatch` |
| Queue visibility timeout | 5 minutes | 3 minutes |
| Lambda timeout | 5 minutes | 2 minutes |
| Lambda memory | 512 MB | 512 MB |
| Runtime | `nodejs24.x` | `nodejs24.x` |
| Batch shape | `partialResponses: true` | `SINGLE_RECORD_BATCH` |
| IAM | `bedrock:*` on `*`; `ses:SendEmail`, `ses:SendRawEmail` on `*` | `bedrock:InvokeModel` on `*` |
| Links | secrets, ingestion bucket, both queues, `fabFileBucket`, `generatedImagesBucket`, `websocketApi` | secrets, `websocketApi`, `fabFileBucket`, `generatedImagesBucket` |
| Payload | S3 `ObjectCreated` event (raw-emails/ prefix) | `{ emailId }` |
| Producer | S3 bucket notification (`emailIngestionBucketNotification`) | the parser Lambda |
| Retry / DLQ | retry 3, default DLQ (4-day, unencrypted) | retry 3, default DLQ (4-day, unencrypted) |

Memory, runtime and retry match. Timeout, batch shape, IAM and links do not. Merging would give the LLM analyzer the SES send permission and a wider Bedrock grant, and would let a slow analysis hold up parsing of inbound mail. **Verdict: keep.** Reason: the pair fails the profile criterion on IAM and timeout, so a merge widens the analyzer's permissions.

## 3. What's New

Evidence: `infra/queues.ts` (release notes on the legacy `whatsNewGenerationQueue` name; highlights as `whatsNewHighlightsQueue`).

| Field | `whatsNewGenerationQueue` (release notes) | `whatsNewHighlightsQueue` |
|---|---|---|
| Handler | `apps/workers/src/queueHandlers/releaseNotes.dispatch` | `apps/workers/src/queueHandlers/whatsNewHighlights.dispatch` |
| Queue visibility timeout | 8 minutes | 8 minutes |
| Lambda timeout | 5 minutes | 5 minutes |
| Lambda memory | unset (same SST default) | unset (same SST default) |
| Runtime | unset | unset |
| VPC | `lambdaVpc` | `lambdaVpc` |
| Links | secrets, `websocketApi` | secrets, `websocketApi` |
| IAM | Bedrock invoke on the same five model/profile ARN patterns; `cloudwatch:PutMetricData` | identical |
| `copyFiles` | `tiktoken_bg.wasm` | identical |
| Batch shape | `SINGLE_RECORD_BATCH` | `SINGLE_RECORD_BATCH` |
| Retry / DLQ | retry 3, 14-day, KMS-encrypted DLQ; queue KMS-encrypted | identical |
| Payload | `ReleaseNotesJobPayloadSchema` (`b4m-core/common/src/schemas/releaseNotes.ts`), already carries `kind: 'release-notes'` | `WhatsNewHighlightsPayloadSchema` (`packages/server-utils/src/whatsNew/whatsNewHighlights.types.ts`), no discriminator |

No row differs except the handler. Memory is "unset for both, so the same SST default"; no number is asserted. **Verdict: merge**, using the SRE pattern: one queue, one dispatch that routes on a discriminator (`kind`; highlights would gain one).

Producers (all must keep working through a migration):

- Release notes: `packages/scripts/src/releaseNotes/releaseNotesEnqueue.ts`, run from `.github/workflows/prod-release.yml`. It reads `RELEASE_NOTES_QUEUE_URL` from a GitHub secret, gated by `vars.RELEASE_NOTES_ENABLED` and an assumed role from `secrets.AWS_RELEASE_NOTES_ROLE_ARN`. The queue URL and role are provisioned outside this repo.
- Highlights: `apps/client/pages/api/admin/generate-highlights.ts` (admin route) and `apps/workers/src/cron/whatsNewHighlights.ts` via `infra/cron.ts` (`whatsNewHighlightsCron`, currently `enabled: false`).

Risks a merge must handle:

- **External producer.** The release workflow holds the old queue URL as a secret. Renaming or replacing `whatsNewGenerationQueue` breaks release notes silently (the enqueue step is `continue-on-error`). Keep the existing queue and add highlights to it, rather than creating a new queue.
- **Shared blast radius.** One concurrency pool and one DLQ. A highlights backfill can delay a release announcement, and a poison highlights message lands in the release-notes DLQ.
- **Observability keys on queue/function names**, listed in the checklist below.

Observations (not fixed here):

- `apps/client/pages/api/admin/whats-new-backfill.ts` still enqueues a `WhatsNewGenerationPayload` to `whatsNewGenerationQueue`. `releaseNotes.dispatch` recognizes it as legacy, logs, and drops it (`isLegacyPayload`), so the route has no effect.
- `apps/workers/src/queueHandlers/whatsNewGeneration.ts` (the retired generator) is still in the tree and is no longer wired to a queue subscription in `infra/queues.ts`.
- `infra/emailMarketing.ts` comments still say batches of 16 recipients; the orchestrator uses 25.
- The highlights DLQ alarm is tagged `application: 'WhatsNewGeneration'`, while the release-notes one is `ReleaseNotes` (`infra/dlqAlarms.ts`).

## Merge-cost checklist (What's New)

Every in-repo file a merged queue touches:

- `infra/queues.ts`: both queues, both DLQs, both subscriptions, and the export lists.
- `infra/dlqAlarms.ts`: DLQ alarm entries for `release-notes` and `whats-new-highlights`.
- `infra/dashboard.ts`: the What's New dashboard reads the release-notes function, queue and DLQ names.
- `infra/logMonitor.ts`: both subscriptions' log groups.
- `infra/alarms.ts`: Lambda error alarm on the release-notes function.
- `infra/web.ts`: DLQ URL map entries (`release-notes`, `whats-new-highlights`) and the linked queue URLs (`whatsNewHighlightsQueue`, `whatsNewGenerationQueue`).
- `infra/cron.ts`: `whatsNewHighlightsCron` links `whatsNewHighlightsQueue`.
- `packages/server-utils/src/utils/dlqRegistry.ts` and its test: registry labels and source queues.
- `b4m-core/resource/src/manifestCoverage.test.ts`: exemptions for both queues.
- `packages/scripts/src/selfhostParityPolicy.ts`: queue and schedule parity entries for both queues.
- `infra/__tests__/releaseNotesQueue.test.ts`: matches the release-notes subscription by variable name and handler.
- Handlers and producers: `apps/workers/src/queueHandlers/releaseNotes.ts`, `apps/workers/src/queueHandlers/whatsNewHighlights.ts`, `packages/scripts/src/releaseNotes/releaseNotesEnqueue.ts`, `apps/client/pages/api/admin/generate-highlights.ts`, `apps/client/pages/api/admin/whats-new-backfill.ts`, `apps/workers/src/cron/whatsNewHighlights.ts`, and the two payload schemas above.

Out of repo: the `RELEASE_NOTES_QUEUE_URL` and `AWS_RELEASE_NOTES_ROLE_ARN` secrets and the `RELEASE_NOTES_ENABLED` variable in the GitHub repo settings, and the role's `sqs:SendMessage` grant on the queue.
