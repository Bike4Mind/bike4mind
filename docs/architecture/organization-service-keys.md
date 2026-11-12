# Organization service keys

Organization administrators manage service keys in Team Settings. Each key has a
dedicated `isSystem` user with immutable `orgServiceAccount` organization binding,
creator provenance and explicit grants. It has no password, email, login providers,
admin authority, groups, home organization or human roster entry. Seats and human
membership are unchanged. Creator provenance is not an authorization input.

## Authorization

Service credentials are default-denied by REST auth. The supported intersection of
key scopes and principal grants is deliberately narrow:

| Resource grant | Required key scope | Endpoint |
| --- | --- | --- |
| Organization `compute` | `ai:chat` | `POST /api/lattice/chat` |
| Project `read` | `projects:read` | `GET /api/v1/projects/{id}` |

Compute returns text and proposed client-side tool calls; it never executes tools
on the server and cannot access stored notebooks, files or human integrations.
Project reads return project details with empty notebook/file reference lists.
Both mint and use require a persisted project `organizationId` matching the
principal's organization. Legacy unbound projects are ineligible; binding new
projects is owned by the organization sharing feature. No membership inference or
backfill is performed here.

JWT login, CLI/completion verification, embed, realtime and all other REST endpoints
are denied for these principals. A service account does not represent a human who
has satisfied MFA. Human administrator management uses normal JWT authentication
and organization authorization, including any applicable human MFA policy.

## Lifecycle and billing

JWT-only `/api/organizations/{id}/service-keys` lists and creates keys; POST to
`/{keyId}` rotates and DELETE revokes. Only current org administrators can manage
them. Secrets are returned once with `Cache-Control: private, no-store`. Grants are
immutable: revoke and recreate to change access. Rotation preserves the principal.
Creation, rotation and revocation await the shared organization audit writer in
the mutation transaction. Key usage records identify the service principal and
key; org credit ledger entries carry `apiKeyId`. The existing org billing path
accepts a system principal only for its bound organization, independently of the
human roster. Existing personal and org-billed personal key behavior is unchanged.

Revocation disables the credential; the principal remains for usage attribution.
Deleting an organization causes the service-auth organization lookup to refuse
the credential. Deleting or removing the human creator does not affect it.
