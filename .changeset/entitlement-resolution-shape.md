---
"@bike4mind/services": major
---

`ChatCompletionProcess.resolveEntitlementKeys()` now returns `EntitlementResolution` (`{ keys, resolved }`) instead of `string[]`. The method is reachable from the published `@bike4mind/services/llm` subpath, so an out-of-repo caller reading the array directly must destructure `keys`. `EntitlementResolution` is exported from both that subpath and `dataLakeService`.
