---
'@bike4mind/common': major
'@bike4mind/database': minor
'@bike4mind/services': major
---

Content mutations now resolve through the update-level share predicate rather than the read-level
one, so a `read` grant on a notebook, file or project authorizes viewing it and nothing more.
Affected paths: `updateFabFile` and `toggleTags` (file bytes, metadata and tags),
`addSystemPrompts`, `addFiles` and `removeSystemPrompts` (project content), the chat-completion
entry point (which appends to the notebook it runs against), and
`PUT /api/sessions/[id]/chat/[messageId]`. A sharee who previously edited shared content while
holding only `read` now needs `update`; project-derived grants already carry `[read, update]` and
are unaffected.

`IShareableStaticMethods` gains a required `findAllUpdateAccessByIds`, the batch counterpart to
`findUpdateAccessById`, implemented by `ShareableDocumentRepository` - an out-of-tree implementer
of that interface must add it. `@bike4mind/common` also exports `canUpdateShareable`, an
update-level predicate for the call sites that already hold the document and so cannot re-resolve
it through the repository.

`DELETE /api/files` no longer hard-deletes files owned by other users that happen to be shared in
with a delete grant: those lose the caller's grant instead, and only the caller's own files (and
their stored bytes) are destroyed.
