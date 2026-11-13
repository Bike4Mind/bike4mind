# Organization data retention

Team Overview shows the active periods to members. Owners and current organization managers can set separate day counts for chat history, uploaded files and generated media. An empty value means keep forever; every category starts there.

Shortening any period requires requesting a server-generated estimate, then pressing **Confirm shorter retention**. The confirmation expires after ten minutes and is bound to the administrator, organization, proposed policy and current policy version. Concurrent policy changes require a new estimate.

## Eligibility

- Uploaded files require `FabFile.organizationId` to match the organization. Personal files are never selected from an uploader's membership.
- New notebooks created through the normal chat/create paths receive an immutable `retentionOrganizationId` after validating the creator's selected non-personal organization and membership. Message age uses its timestamp, strictly before the cutoff. Chat deletion does not delete attached files or generated media early.
- New generated library files inherit the explicitly bound notebook's organization. Inline generated objects have a separate immutable ownership ledger. Generated media uses its own period, even after chat messages are deleted.
- Existing unbound notebooks, imported notebooks, unbound copies and objects without an authoritative ownership record are excluded. Analytics organization metadata is never an ownership signal. No ownership backfill is performed.
- Another live notebook or library file referencing a generated object retains it. Personal or cross-organization copies are not swept to force deletion. Held content is excluded, and the existing moderation-evidence storage hold is preserved.

## Cleanup and auditing

Hosted and self-host workers run hourly. A run visits at most twenty organizations, attempts at most fifty items per organization and stops starting work after two minutes. Query deadlines also bound candidate lookups. Work not reached is retried in later sweeps; organizations and retained media rotate so an old failure or shared object cannot permanently block later candidates.

Each row deletion and its append-only organization audit entry commit together, guarded by the policy version. Media reference removal is audited separately from object deletion. Existing message and file deletion services handle tombstones, file chunks, references and owner storage accounting. Object storage and CDN operations use the existing deletion helpers; physical storage is not transactional with MongoDB. A failed sweep is retried by the next schedule and hosted failures go to a monitored dead-letter queue.

Estimates count eligible messages, file rows and generated object records, not unique physical blobs or guaranteed storage savings. Counts may change between estimation and cleanup. Deletion follows existing soft-delete and versioned-storage semantics; this is not a promise of immediate irreversible erasure of backups or storage versions.

Verification uses disposable MongoDB replica sets and mocked object storage. No production cleanup or deployment is part of implementation verification.
