---
'@bike4mind/database': minor
---

The CASL ability's user-share arm now requires the caller's id and the requested permission to
hold on the same `users[]` entry. The previous dotted filter (`'users.userId'` plus
`'users.permissions'`) let Mongo satisfy the two halves from different entries, so a document
shared with two collaborators at different levels silently promoted the weaker one: a sharee
holding only `share` matched their own id on their entry and `read` on the other person's, and
was granted read. This mirrors the `$elemMatch` already used on the group arm.

Unlike the group arm, this path had no empty-collection gate in front of it, so the over-grant
was reachable in production wherever `accessibleBy` compiles the ability into a Mongo query.
Both ability copies are fixed together and must stay in sync: `apps/client/server/auth/ability.ts`
and `packages/database/src/utils/ability.ts`.
