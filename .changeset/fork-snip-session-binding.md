---
"@bike4mind/services": patch
---

bind fork/snip message lookup to the caller's session

`forkSession`/`snipSession`'s adapter parameter now requires `findBySessionIdAndId` where it
previously required `findById`, and `deleteSessionMessage`'s now picks `findBySessionIdAndId`/`update`
off `IChatHistoryItemRepository` instead of declaring them inline. Any caller passing the real
`questRepository` is unaffected, since `IChatHistoryItemRepository` has carried those methods since
#1755. A hand-rolled minimal adapter will fail to compile against this patch.
