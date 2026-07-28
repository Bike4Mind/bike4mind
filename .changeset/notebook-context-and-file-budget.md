---
"@bike4mind/common": patch
"@bike4mind/services": patch
"@bike4mind/utils": patch
---

Keep uploaded documents in a notebook's context so the model can use them on later turns.

Two contract changes ship with it and are not obvious from the title:

- `ChatCompletionFeature.getContextMessages` drops the unused `max_tokens` parameter and
  gains `attachedFileTokenBudget`. Implementations taking positional arguments must be
  updated; `max_tokens` was declared in several signatures and read in none.
- `processFabFilesServer` now sizes attached-file content from the model's INPUT window
  rather than its output-token cap, and divides that budget across the text files in the
  turn. A non-positive budget does not mean "unlimited" - downstream it restores a flat
  per-file cap - so callers must pass a positive value.
