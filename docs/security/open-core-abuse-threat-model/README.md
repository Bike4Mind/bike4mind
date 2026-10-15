# Open-Core Abuse Threat Model: CSAM Detection and Reporting

This document describes the CSAM safeguard pipeline implemented in this open-core repository,
covering detection surface, evidence preservation, human triage, and the NCMEC reporting flow.

## Legal basis

18 U.S.C. section 2258A requires an Electronic Service Provider (ESP) that obtains actual
knowledge of apparent CSAM to submit a report to NCMEC. Every confirmed block event is a
potential knowledge event. Detection without a reporting path creates a worse legal posture
than no detection at all; the pipeline below closes that gap.

## Detection surface

Two code paths scan images before they reach users:

| Path | Trigger | Implementation |
|---|---|---|
| Generated images | After every generation / edit | `b4m-core/services/src/llm/imageModerationGate.ts` |
| Uploaded images | S3 `ObjectCreated` event | `apps/client/server/s3/moderateUploadedFile.ts` |

Both paths call `RekognitionImageModerationService` (`b4m-core/utils/src/imageModeration/index.ts`),
which blocks on `Explicit` or `Explicit Nudity` labels at or above 90% confidence. The gate
retries up to three times and fails closed: a transient scanner error leaves the file in
`moderationStatus: 'pending'` (held, not served, retryable) rather than passing it through.

Self-host installs skip Rekognition scanning (no AWS credentials); the `B4M_SELF_HOST` guard
is present in both paths. Self-host operators are not registered ESPs and this reporting
path does not apply to them.

## Evidence preservation

**What is protected today**

`FabFile.moderationStatus: 'blocked'` prevents the DB row from being hard-deleted:

- `FabFile.hardDeleteOneById` folds `$ne: 'blocked'` into the `findOneAndDelete` predicate
  atomically (no TOCTOU window). A blocked file cannot be destroyed through the normal
  hard-delete path.
- `FabFile.hardDeleteByIds` pre-checks for blocked files before calling `deleteMany` and
  additionally filters `$ne: 'blocked'` in the delete predicate (belt-and-suspenders).
- The data lake sweep and purge callers catch the resulting legal-hold error and skip the
  blocked file rather than re-throwing for DLQ retry.
- An `ImageModerationIncident` row written at block time carries the labels, user ID, session,
  and file reference. It has no TTL and is retained indefinitely.

**What is NOT yet protected**

- **S3 object bytes.** The data lake sweep paths (`cleanupDeletedDataLake`, `purgeDataLakeConnectionFiles`)
  delete S3 objects before reaching the hard-delete guard. A lake containing a blocked file
  will skip the DB row but will lose the S3 bytes. Operators should apply S3 Object Lock
  to blocked files at block time to make byte preservation explicit and tamper-evident.
- **User-initiated file delete.** `fabFileService/delete.ts` does not currently check
  `moderationStatus` before deleting the S3 object. A user who uploaded the blocked file
  can trigger the S3 deletion through the normal delete flow. The FabFile DB row is still
  protected by the hard-delete guard.

Both gaps are tracked as follow-up work. The DB row and the NCMEC report are durable; the
primary evidence for the identity of the uploader and the timestamp is preserved.

## Block-to-triage flow

```
Detection -> block (FabFile.moderationStatus = 'blocked')
          -> ImageModerationIncident created (reviewStatus absent => 'pending_review')
          -> Admin triage queue: GET /api/admin/moderation-incidents
          -> Human review: POST /api/admin/moderation-incidents/:id/verdict
               confirmed_csam  -> NCMEC CyberTip submitted -> reviewStatus = 'reported'
               false_positive  -> reviewStatus = 'false_positive' (no NCMEC submission)
               record_manual_report -> filed by hand on the CyberTipline web form
                                       -> reviewStatus = 'reported', reportChannel = 'manual'
```

The triage queue returns incidents with `reviewStatus` absent or `'pending_review'`, oldest
first (`ImageModerationIncidentSchema.index({ reviewStatus: 1, createdAt: 1 })`).

## NCMEC reporting flow

The NCMEC service lives at `b4m-core/services/src/ncmecService/index.ts`. It submits a
CyberTip via the NCMEC CyberTipline ESP API (report.cybertip.org/ispws/documentation/):

1. `POST /submit` with an XML report body — receives the `reportId`.
2. `POST /finish` with the `reportId` — finalizes the report. Without `/finish`, NCMEC
   deletes the unfinished report 24 hours after `/submit`. The incident is only marked
   `'reported'` after `/finish` succeeds.

The `reportId` is logged immediately after `/finish` returns and before the DB write, so
it is recoverable from CloudWatch even if the DB write subsequently fails.

**Credentials:** `NCMEC_ESP_ID` and `NCMEC_API_KEY` are SST secrets linked to the Next.js
function. The route resolves them from `Resource.NCMEC_ESP_ID.value` (not `process.env`).
Set per stage with `sst secret set`. `NCMEC_USE_SANDBOX` defaults to true: anything other
than an explicit `'false'` uses the test host, so a missing value cannot post to production.

**Idempotency and concurrency:**
- `claimForNcmecSubmission` atomically transitions `pending_review`/absent -> `confirmed_csam`.
  Only one concurrent admin request can claim a given incident; others receive 409.
- `updateReviewStatus` uses `$nin: ['reported', 'confirmed_csam']` for `false_positive`
  transitions, preventing a concurrent false_positive verdict from overriding an in-flight
  NCMEC submission.
- On NCMEC failure, the verdict route distinguishes two outcomes:
  - **Rejected** (`NcmecRejectedError`, non-2xx on `/submit`): no tip was filed; the route
    rolls back `confirmed_csam` -> `pending_review` and returns 502.
  - **Unknown** (timeout, network error, or missing `reportId` in 2xx): NCMEC may have
    already received the submission; the route does NOT roll back and leaves the incident
    in `confirmed_csam`. After 10 minutes it surfaces in the `staleConfirmedCsam` list.
  - **FinishFailed** (`NcmecFinishFailedError`): `/submit` succeeded but `/finish` failed
    (non-2xx or network error). The `reportId` is persisted on the incident. Use
    `{ verdict: "retry_finish" }` to re-call `/finish` within NCMEC's 24-hour window.
    If that window has passed, use `{ verdict: "mark_reported", ncmecReportId }` to close
    the incident after verifying with NCMEC. `requeue` is refused (409) when a `reportId`
    is stored, because that report must be finalized -- not filed a second time.

  Recovery verdicts (all via `POST /api/admin/moderation-incidents/:id/verdict`):

  | Verdict | When to use |
  |---|---|
  | `mark_reported` | Operator confirmed with NCMEC that the tip was received; supply `ncmecReportId`. |
  | `requeue` | Operator confirmed with NCMEC that no tip was filed; moves back to `pending_review`. |
  | `retry_finish` | `/finish` failed but reportId is stored; re-calls `/finish` within NCMEC's 24-hour window. |

**Manual reporting (web form):** the statute requires the report, not the API. Until ESP API
credentials are provisioned (the `confirmed_csam` verdict returns 503 without them), or
whenever the API is unavailable, an admin files the CyberTip by hand on the CyberTipline web
form and records it with `{ verdict: "record_manual_report", ncmecReportId }`. This moves the
incident from `pending_review`/absent straight to `'reported'` in one atomic write, stores
`reportChannel: 'manual'` and the admin's user id in `reportedBy`, and needs no NCMEC
credentials. The report id must be letters, digits and dashes only. It does not act on a
`confirmed_csam` claim; resolve that through the recovery verdicts first: `retry_finish` when
an unfinished report id is stored (once NCMEC's 24-hour window has passed, file by hand and
use `mark_reported` with the new report id instead), otherwise (once the claim is stale) `mark_reported` if NCMEC
holds a tip, or `requeue` followed by `record_manual_report` if it does not. A refused
`record_manual_report` still logs the supplied report id.

`reportChannel: 'manual'` marks incidents recorded through `record_manual_report`. An incident
without it was recorded by the API path or by `mark_reported` / `retry_finish`. Every path to
`'reported'` stamps `reportedAt` and stores the acting admin's user id in `reportedBy`.

**Before going live:** validate the exact XML schema, element names, and endpoint paths with
your NCMEC ESP representative. Run a full end-to-end test against the NCMEC test host
(`exttest.cybertip.org/ispws`) before pointing at the production host (`report.cybertip.org/ispws`).

## Self-host divergence

Self-host installs (`B4M_SELF_HOST=true`) skip image moderation entirely. They are not
registered ESPs, carry no Rekognition credentials, and this reporting pipeline does not
apply to them.

## Key files

| File | Purpose |
|---|---|
| `b4m-core/utils/src/imageModeration/index.ts` | Rekognition scan, retry, fail-closed |
| `b4m-core/services/src/llm/imageModerationGate.ts` | Gate for generated images |
| `apps/client/server/s3/moderateUploadedFile.ts` | Gate for uploaded images |
| `packages/database/src/models/content/ImageModerationIncidentModel.ts` | Audit trail |
| `packages/database/src/models/content/FabFileModel.ts` | Block state + hard-delete guard |
| `b4m-core/services/src/ncmecService/index.ts` | CyberTipline submission (/submit + /finish) |
| `apps/client/pages/api/admin/moderation-incidents/index.ts` | Triage queue list |
| `apps/client/pages/api/admin/moderation-incidents/[id]/verdict.ts` | Admin verdict + NCMEC submit |
