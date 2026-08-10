---
"@bike4mind/common": minor
---

Passage-chunk limits (`DEFAULT_PASSAGE_TOKEN_TARGET`, `MIN_PASSAGE_TOKEN_TARGET`) are now exported
from `@bike4mind/common/constants/chunking` and are the single source of truth for chunk granularity.

The `DefaultChunkSize` admin setting's DEFAULT changes from 2100 to 512 tokens to match the chunker.
Behavioural note for anyone bisecting a retrieval-quality change: this is a default only. A deploy
with a value already stored in `adminsettings` keeps it, and a stored value above 512 makes the
Knowledge/FilesSection reprocess path produce coarser chunks than `/api/files/reprocess`, which sends
no override. The setting also gains a `min` bound so it can no longer be saved below the floor the
chunker would silently clamp to.
