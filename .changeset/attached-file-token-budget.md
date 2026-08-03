---
"@bike4mind/llm-adapters": patch
"@bike4mind/services": patch
"@bike4mind/utils": patch
---

Guarantee attached-file content a share of the chat token budget, and tell the model whenever content was cut.

An attached file could lose the whole input budget to conversation history and arrive empty, while the
model answered confidently from nothing - indistinguishable from a correct answer unless you already
held the file. Attached content now has a floor of the assembly budget, and unused reserve flows back
to history.

Cuts are now declared at every stage that makes one. A head-sliced file, a set of similarity-ranked
excerpts, and a truncated fetched page each carry their own wording, so the model no longer reads a
fragment as a whole document or names a mid-file row as the last. `truncationMethod` distinguishes a
budget loss from configured history windowing instead of reporting the latter for both.

Also fixed: `cosineSearch` returns up to ten chunks rather than three, which was starving small
embedders, and excerpts arrive in file order rather than score order. A vectorized file delivered
whole but with its last chunk cut to fit is now marked as truncated rather than as a set of
non-contiguous excerpts.
