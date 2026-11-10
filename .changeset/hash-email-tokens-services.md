---
'@bike4mind/services': patch
---

store email verification and email-change tokens as hashes; verify by hash, accepting unexpired pre-hash tokens

Custom user repositories resolve raw link tokens against the stored values returned by `emailTokenStoredValues` from `@bike4mind/utils`.
