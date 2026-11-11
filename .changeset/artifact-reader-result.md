---
"@bike4mind/services": major
---

Return a viewer projection from `artifactService.get` for public readers without an explicit grant.
The result now includes an `access` discriminator: narrow it to `owner` or `shared` before reading
ownership, permission or source fields. Public results include only supported display metadata
and projected version rows. Owners and explicit sharees retain the full document.
