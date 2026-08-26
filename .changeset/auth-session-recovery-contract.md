---
"@bike4mind/common": patch
"@bike4mind/database": patch
"@bike4mind/services": patch
---

bound, non-sliding recovery rotation for the auth session store

`IAuthSessionRepository` gains a required `recoverRotateHash`, and two existing signatures tighten:
`rotateHash`'s `newExpiresAt` is now required, and `recoverRotateHash` takes `maxRecoveries` and no
`newExpiresAt` at all. That asymmetry is deliberate and load-bearing - only a rotation from the
CURRENT secret earns a slide, so a superseded secret can never extend the session it is used
against - and it is encoded in the types so a call site cannot regress it silently. Any caller
passing the real `authSessionRepository` is unaffected; a hand-rolled minimal adapter will fail to
compile against this patch.

`AuthSession` also gains a `recoveries` counter (schema default `0`, absent on pre-existing rows and
handled by the filter, so no migration is required).
