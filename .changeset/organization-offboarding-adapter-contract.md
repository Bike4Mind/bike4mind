---
'@bike4mind/common': major
'@bike4mind/services': major
---

Organization departure adapters now require `userApiKeys.revokeLiveOrgBilledByUserId`. Implement that method on custom `IUserApiKeyRepository` adapters before upgrading.

`organizationService.revokeAccess` now returns `{ organization, revokedOrgBilledApiKeyIds }`. Callers that previously consumed the returned organization should read `result.organization`; the revoked key IDs are available separately.

Artifact repository adapters must implement `reassignMemberContent(scope, recipientId)` to transfer organization-scoped ownership and remove the departing member from explicit read, write and delete grants in one atomic write, preserving collaborator grants.
