---
"@bike4mind/common": patch
"@bike4mind/services": patch
"@bike4mind/utils": patch
---

Price the pre-flight credit hold on a realistic output size instead of the model's
full max-output ceiling, so a turn that will not actually use the ceiling no longer
gets blocked by a worst-case reservation. Reasoning models that spend reasoning
tokens inside their output budget get a larger reservation ceiling than other
models. The per-member organization credit cap is unaffected by this change: it is
still priced on the unshrunk ceiling at both the chat and CLI completion paths, and
on the CLI path that unshrunk figure is now used where an unrelated, smaller default
budget was used before - callers without an explicit output budget on an org-billed
key may see the per-member cap trigger sooner than before.
