# Open-Core Abuse Threat Model: CSAM Detection and Reporting

This document describes the CSAM safeguard pipeline implemented in this open-core repository,
covering detection surface, evidence preservation, human triage, and the NCMEC reporting flow.
It satisfies the §2258A compliance acceptance criterion: a confirmed-CSAM incident has a
defined, documented path to an NCMEC CyberTip report and evidence preservation.

## Legal basis

18 U.S.C. §2258A requires an Electronic Service Provider (ESP) that obtains actual knowledge
of apparent CSAM to submit a report to NCMEC. Every confirmed block event is a potential
knowledge event. Detection without a reporting path creates a worse legal posture than no
detection at all; the pipeline below closes that gap.

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

A confirmed-block file is never deleted. The `FabFile.moderationStatus: 'blocked'` flag:

- Prevents the file from being served (`isImageServeable` checks this flag).
- Prevents `FabFile.hardDeleteOneById` and `FabFile.hardDeleteByIds` from destroying the row.
  Both methods throw on any `blocked` file before any deletion occurs, so a data-lake purge
  or account deletion cannot silently remove §2258A evidence.
- The S3 object is preserved by convention: user-file prefixes carry no lifecycle expiry rule
  (verified in `infra/buckets.ts`). For confirmed CSAM, operators should additionally apply
  an S3 Object Lock hold to make this explicit and tamper-evident.

An `ImageModerationIncident` row is written at block time. It is metadata-only (labels,
user ID, session, file reference) and has no TTL. The underlying S3 object reference is the
file's storage key, which can be reconstructed from the `FabFile` row.

## Block-to-triage flow

```
Detection -> block (S3 preserved, FabFile.moderationStatus = 'blocked')
          -> ImageModerationIncident created (reviewStatus absent => 'pending_review')
          -> Admin triage queue: GET /api/admin/moderation-incidents
          -> Human review: POST /api/admin/moderation-incidents/:id/verdict
               confirmed_csam  -> NCMEC CyberTip submitted -> reviewStatus = 'reported'
               false_positive  -> reviewStatus = 'false_positive' (no NCMEC submission)
```

The triage queue returns incidents with `reviewStatus` absent or `'pending_review'`, oldest
first (`ImageModerationIncidentSchema.index({ reviewStatus: 1, createdAt: 1 })`).

## NCMEC reporting flow

The NCMEC service lives at `b4m-core/services/src/ncmecService/index.ts`. It submits a
CyberTip via the NCMEC CyberTipline ESP API v3 and returns the `reportId` NCMEC assigns.
The report ID is persisted on the incident row (`ncmecReportId`) as the audit record that
reporting occurred.

**Credentials:** `NCMEC_ESP_ID` and `NCMEC_API_KEY` are SST secrets. Set them per stage with
`sst secret set`. Set `NCMEC_USE_SANDBOX=true` on all non-production stages.

**Idempotency:** The verdict handler checks `reviewStatus !== 'reported'` before calling the
NCMEC API. The `updateReviewStatus` repository method uses a `$ne: 'reported'` atomic guard
to prevent duplicate submissions in a race.

**Before going live:** verify the exact NCMEC endpoint URL, authentication scheme, and XML
report schema with your NCMEC ESP representative. The sandbox endpoint
(`extapipre.cybertipline.org`) must be exercised end-to-end before pointing at the
production endpoint (`extapi.cybertipline.org`).

## Self-host divergence

Self-host installs (`B4M_SELF_HOST=true`) skip image moderation entirely. They are not
registered ESPs, carry no Rekognition credentials, and this reporting pipeline does not
apply to them. Any self-host operator who integrates Rekognition independently should
consult NCMEC directly about their obligations.

## Key files

| File | Purpose |
|---|---|
| `b4m-core/utils/src/imageModeration/index.ts` | Rekognition scan, retry, fail-closed |
| `b4m-core/services/src/llm/imageModerationGate.ts` | Gate for generated images |
| `apps/client/server/s3/moderateUploadedFile.ts` | Gate for uploaded images |
| `packages/database/src/models/content/ImageModerationIncidentModel.ts` | Audit trail |
| `packages/database/src/models/content/FabFileModel.ts` | Block state + hard-delete guard |
| `b4m-core/services/src/ncmecService/index.ts` | CyberTipline submission |
| `apps/client/pages/api/admin/moderation-incidents/index.ts` | Triage queue list |
| `apps/client/pages/api/admin/moderation-incidents/[id]/verdict.ts` | Admin verdict + NCMEC submit |
