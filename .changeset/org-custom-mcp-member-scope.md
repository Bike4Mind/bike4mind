---
"@bike4mind/common": major
---

Require current member user IDs as the second argument to
`IMcpConnectionRepository.listMemberConnections(organizationId, memberUserIds, options)`.
The optional host filter moves to the third argument. Callers must supply the current
membership roster so connections belonging to former members stay out of admin listings.
